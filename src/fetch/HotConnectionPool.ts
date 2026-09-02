import {
  createClient,
  type Client,
  type RequestStats,
  type RequestTimings,
} from "node-wreq";

import { GeoClawConfig } from "../core/GeoClawConfig.js";
import { Logger } from "../core/Logger.js";
import type { ProxyMode } from "./FetchTypes.js";
import { parseKhGoogleYaml, type HostPinRecord } from "./HostPinPool.js";
import { resolveProxyUrl } from "./FetchTypes.js";
import type { TlsFingerprintConfig } from "./TlsFingerprintCodec.js";
import {
  HotFetchNoHotIpError,
  HotFetchNotOkError,
  HotFetchTransportError,
} from "./FetchErrors.js";

/** 单 IP 槽位状态 */
export type HotSlotState = "pending" | "warming" | "hot" | "denied" | "failed";

/** 预热一次的结果分类 */
export type WarmAttemptOutcome = "hot" | "denied" | "retry";

/** 热连接池构造选项（通常来自 geoclaw.yaml warmPool 段） */
export type HotConnectionPoolOptions = {
  hostname: string;
  ips: readonly HostPinRecord[];
  warmupUrl: string;
  headers: Record<string, string>;
  browser: TlsFingerprintConfig;
  proxyUrl?: string;
  proxyMode: ProxyMode;
  timeoutMs?: number;
  poolIdleTimeout: number | false;
  poolMaxIdlePerHost: number;
  deniedStatuses: readonly number[];
  successStatus: number;
  initialConcurrency: number;
  reheatConcurrency: number;
  reheatIntervalMs: number;
  reheatBackoffMs: number;
  deniedBackoffMs: number;
};

/** 预热汇总 */
export type WarmupSummary = {
  total: number;
  hot: number;
  denied: number;
  retry: number;
  elapsedMs: number;
};

/** 池运行时统计 */
export type HotPoolStats = {
  total: number;
  hot: number;
  denied: number;
  failed: number;
  pending: number;
  warming: number;
  reheatQueueSize: number;
};

type IpSlot = {
  ip: string;
  family: HostPinRecord["family"];
  state: HotSlotState;
  client?: Client;
  lastStatus?: number;
  lastError?: string;
  nextReheatAt: number;
};

/**
 * 按 IP 维护 node-wreq 热连接；仅 HTTP 200 入池，403/429 拒绝并后台重试直至 200。
 */
export class HotConnectionPool {
  private static readonly logger = new Logger("HotConnectionPool");
  private readonly options: HotConnectionPoolOptions;
  private readonly slots = new Map<string, IpSlot>();
  private readonly hotIps: string[] = [];
  private hotIndex = 0;
  private readonly reheatQueue = new Set<string>();
  private reheatTimer: ReturnType<typeof setInterval> | undefined;
  private reheatRunning = false;
  private reheatBusy = false;

  /**
   * @param options - 输入：`HotConnectionPoolOptions` — 来自 GeoClawConfig.getWarmPoolOptions()
   */

  constructor(options: HotConnectionPoolOptions) {
    this.options = options;
    for (const record of options.ips) {
      this.slots.set(record.ip, {
        ip: record.ip,
        family: record.family,
        state: "pending",
        nextReheatAt: 0,
      });
    }
    HotConnectionPool.logger.info("热连接池已创建", {
      hostname: options.hostname,
      ipCount: options.ips.length,
    });
  }

  /**
   * 首轮并行预热全部 IP。
   * @returns 输出：`Promise<WarmupSummary>` — 热/拒/待重试计数
   */

  async runInitialWarmup(): Promise<WarmupSummary> {
    const started = Date.now();
    const ips = [...this.slots.keys()];
    HotConnectionPool.logger.info("开始首轮预热", { count: ips.length });
    const outcomes = await this.runPool(
      ips,
      this.options.initialConcurrency,
      (ip) => this.warmOne(ip),
    );

    const summary = summarizeOutcomes(outcomes, ips.length, Date.now() - started);
    HotConnectionPool.logger.info("首轮预热完成", summary);
    return summary;
  }

  /**
   * 启动后台重加热循环（403/429/传输失败 IP）。
   * @returns 输出：无（`void`）
   */

  startBackgroundReheat(): void {
    if (this.reheatTimer) {
      return;
    }
    this.reheatRunning = true;
    this.reheatTimer = setInterval(() => {
      void this.tickReheat();
    }, this.options.reheatIntervalMs);
    HotConnectionPool.logger.info("后台重加热已启动", {
      intervalMs: this.options.reheatIntervalMs,
      concurrency: this.options.reheatConcurrency,
    });
  }

  /**
   * 停止后台重加热。
   * @returns 输出：无（`void`）
   */

  stopBackgroundReheat(): void {
    this.reheatRunning = false;
    if (this.reheatTimer) {
      clearInterval(this.reheatTimer);
      this.reheatTimer = undefined;
    }
  }

  /**
   * 当前可用（HTTP 200 已预热）热连接数量。
   * @returns 输出：`number` — hot 槽位数
   */

  getHotCount(): number {
    return this.hotIps.length;
  }

  /**
   * 池统计快照。
   * @returns 输出：`HotPoolStats` — 各状态计数
   */

  getStats(): HotPoolStats {
    let hot = 0;
    let denied = 0;
    let failed = 0;
    let pending = 0;
    let warming = 0;
    for (const slot of this.slots.values()) {
      switch (slot.state) {
        case "hot":
          hot++;
          break;
        case "denied":
          denied++;
          break;
        case "failed":
          failed++;
          break;
        case "pending":
          pending++;
          break;
        case "warming":
          warming++;
          break;
      }
    }
    return {
      total: this.slots.size,
      hot,
      denied,
      failed,
      pending,
      warming,
      reheatQueueSize: this.reheatQueue.size,
    };
  }

  /**
   * 单次热连接 GET：只用一个 IP、只试一次；非 200 立即抛弃并移出热池。
   * @param url - 输入：`string` — 完整 URL
   * @param extraHeaders - 输入：`Record<string, string>` — 单次附加头
   * @returns 输出：`Promise<{ response, ip, timings? }>` — 仅 successStatus 时返回
   * @throws {HotFetchNotOkError} HTTP 非 successStatus
   * @throws {HotFetchTransportError} 传输失败
   * @throws {HotFetchNoHotIpError} 无热连接
   */

  async fetchOnce(
    url: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{
    response: Awaited<ReturnType<Client["get"]>>;
    ip: string;
    timings?: RequestTimings;
  }> {
    if (this.hotIps.length === 0) {
      throw new HotFetchNoHotIpError();
    }

    const ip = this.pickHotIp();
    const slot = this.slots.get(ip);
    if (!slot?.client) {
      throw new HotFetchNoHotIpError();
    }

    let stats: RequestStats | undefined;
    try {
      const response = await slot.client.get(url, {
        headers: extraHeaders,
        ...(this.options.timeoutMs !== undefined ? { timeout: this.options.timeoutMs } : {}),
        onStats: (s: RequestStats) => {
          stats = s;
        },
      });

      if (response.status === this.options.successStatus) {
        return { response, ip, timings: response.wreq.timings ?? stats?.timings };
      }

      void response.arrayBuffer().catch(() => undefined);
      const kind = this.options.deniedStatuses.includes(response.status) ? "denied" : "failed";
      this.evictToReheat(ip, kind, response.status);
      throw new HotFetchNotOkError(response.status, ip);
    } catch (err) {
      if (err instanceof HotFetchNotOkError) {
        throw err;
      }
      this.evictToReheat(ip, "failed", undefined, err);
      throw new HotFetchTransportError(ip, err);
    }
  }

  /**
   * @deprecated 使用 fetchOnce + FetchTaskPool；不在此方法内重试
   * @param url - 输入：`string` — 完整 URL
   * @param extraHeaders - 输入：`Record<string, string>` — 附加头
   * @returns 输出：`Promise<{ response, ip, timings? }>` — 同 fetchOnce
   */
  async fetchGet(
    url: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{
    response: Awaited<ReturnType<Client["get"]>>;
    ip: string;
    timings?: RequestTimings;
  }> {
    return this.fetchOnce(url, extraHeaders);
  }

  /**
   * 释放全部 native 连接。
   * @returns 输出：无（`void`）
   */

  close(): void {
    this.stopBackgroundReheat();
    for (const slot of this.slots.values()) {
      slot.client?.close();
      slot.client = undefined;
    }
    this.hotIps.length = 0;
  }

  /**
   * 对单个 IP 执行预热 GET；200 保留 client 入热池。
   * @param ip - 输入：`string` — 目标 IP
   * @returns 输出：`Promise<WarmAttemptOutcome>` — hot / denied / retry
   */

  private async warmOne(ip: string): Promise<WarmAttemptOutcome> {
    const slot = this.slots.get(ip);
    if (!slot) {
      return "retry";
    }

    slot.state = "warming";
    slot.client?.close();
    slot.client = undefined;
    this.removeFromHotList(ip);

    const proxy = resolveProxyUrl({
      pinnedIp: ip,
      proxyMode: this.options.proxyMode,
      proxyUrl: this.options.proxyUrl,
    });

    const client = createClient({
      browser: this.options.browser,
      headers: this.options.headers,
      dns: {
        hosts: {
          [this.options.hostname]: [ip],
        },
      },
      ...(proxy ? { proxy } : {}),
      poolIdleTimeout: this.options.poolIdleTimeout,
      poolMaxIdlePerHost: this.options.poolMaxIdlePerHost,
      connectionGroup: ip,
      ...(this.options.timeoutMs !== undefined ? { timeout: this.options.timeoutMs } : {}),
    });

    try {
      const response = await client.get(this.options.warmupUrl);
      const outcome = classifyWarmHttpStatus(
        response.status,
        this.options.successStatus,
        this.options.deniedStatuses,
      );

      if (outcome === "hot") {
        await response.arrayBuffer();
        slot.client = client;
        slot.state = "hot";
        slot.lastStatus = response.status;
        slot.lastError = undefined;
        this.addToHotList(ip);
        this.reheatQueue.delete(ip);
        HotConnectionPool.logger.debug("IP 入热池", { ip, status: response.status });
        return "hot";
      }

      await response.arrayBuffer().catch(() => undefined);
      client.close();

      if (outcome === "denied") {
        slot.state = "denied";
        slot.lastStatus = response.status;
        this.scheduleReheat(ip, this.options.deniedBackoffMs);
        HotConnectionPool.logger.debug("IP 拒绝服务，后台重试", { ip, status: response.status });
        return "denied";
      }

      slot.state = "failed";
      slot.lastStatus = response.status;
      this.scheduleReheat(ip, this.options.reheatBackoffMs);
      return "retry";
    } catch (err) {
      client.close();
      slot.state = "failed";
      slot.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleReheat(ip, this.options.reheatBackoffMs);
      HotConnectionPool.logger.debug("IP 预热传输失败，后台重试", { ip, error: slot.lastError });
      return "retry";
    }
  }

  /**
   * 后台重加热 tick。
   * @returns 输出：`Promise<void>`
   */

  private async tickReheat(): Promise<void> {
    if (!this.reheatRunning || this.reheatBusy) {
      return;
    }

    const now = Date.now();
    const due = [...this.reheatQueue].filter((ip) => {
      const slot = this.slots.get(ip);
      return slot && slot.state !== "hot" && slot.state !== "warming" && slot.nextReheatAt <= now;
    });

    if (due.length === 0) {
      return;
    }

    this.reheatBusy = true;
    try {
      const batch = due.slice(0, this.options.reheatConcurrency);
      HotConnectionPool.logger.debug("后台重加热批次", { count: batch.length });
      await this.runPool(batch, this.options.reheatConcurrency, (ip) => this.warmOne(ip));
    } finally {
      this.reheatBusy = false;
    }
  }

  /**
   * 将 IP 移出热池并加入重试队列。
   * @param ip - 输入：`string` — IP
   * @param kind - 输入：`"denied" | "failed"` — 拒绝或失败
   * @param status - 输入：`number | undefined` — HTTP 状态
   * @param err - 输入：`unknown` — 传输错误
   * @returns 输出：无（`void`）
   */

  private evictToReheat(
    ip: string,
    kind: "denied" | "failed",
    status?: number,
    err?: unknown,
  ): void {
    const slot = this.slots.get(ip);
    if (!slot) {
      return;
    }
    slot.client?.close();
    slot.client = undefined;
    slot.state = kind;
    slot.lastStatus = status;
    if (err !== undefined) {
      slot.lastError = err instanceof Error ? err.message : String(err);
    }
    this.removeFromHotList(ip);
    const backoff = kind === "denied" ? this.options.deniedBackoffMs : this.options.reheatBackoffMs;
    this.scheduleReheat(ip, backoff);
    HotConnectionPool.logger.warn("热连接移出并重试", { ip, kind, status });
  }

  /**
   * 安排后台重试时间。
   * @param ip - 输入：`string` — IP
   * @param backoffMs - 输入：`number` — 延迟毫秒
   * @returns 输出：无（`void`）
   */

  private scheduleReheat(ip: string, backoffMs: number): void {
    const slot = this.slots.get(ip);
    if (!slot) {
      return;
    }
    slot.nextReheatAt = Date.now() + backoffMs;
    this.reheatQueue.add(ip);
  }

  /**
   * 轮询选取下一个 hot IP。
   * @returns 输出：`string` — IP 地址
   */

  private pickHotIp(): string {
    const ip = this.hotIps[this.hotIndex % this.hotIps.length]!;
    this.hotIndex = (this.hotIndex + 1) % this.hotIps.length;
    return ip;
  }

  /**
   * 将 IP 加入热池轮询列表。
   * @param ip - 输入：`string` — IP
   * @returns 输出：无（`void`）
   */

  private addToHotList(ip: string): void {
    if (!this.hotIps.includes(ip)) {
      this.hotIps.push(ip);
    }
  }

  /**
   * 从热池轮询列表移除 IP。
   * @param ip - 输入：`string` — IP
   * @returns 输出：无（`void`）
   */

  private removeFromHotList(ip: string): void {
    const idx = this.hotIps.indexOf(ip);
    if (idx >= 0) {
      this.hotIps.splice(idx, 1);
      if (this.hotIndex >= this.hotIps.length) {
        this.hotIndex = 0;
      }
    }
  }

  /**
   * 有限并发执行任务池。
   * @param items - 输入：`T[]` — 任务项
   * @param concurrency - 输入：`number` — 并发度
   * @param worker - 输入：`(item: T) => Promise<R>` —  worker
   * @returns 输出：`Promise<R[]>` — 结果数组
   */

  private async runPool<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;

    async function loop(): Promise<void> {
      while (true) {
        const i = next++;
        if (i >= items.length) {
          return;
        }
        results[i] = await worker(items[i]!);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () => loop()),
    );
    return results;
  }
}

/**
 * 从 geoclaw.yaml 创建热连接池；warmPool.enabled 为 false 时返回 undefined。
 * @returns 输出：`HotConnectionPool | undefined` — 池实例
 */

export function createHotConnectionPoolFromConfig(): HotConnectionPool | undefined {
  const opts = GeoClawConfig.get().getWarmPoolOptions();
  if (!opts) {
    return undefined;
  }
  return new HotConnectionPool(opts);
}

/**
 * 根据 HTTP 状态分类预热结果。
 * @param status - 输入：`number` — HTTP 状态码
 * @param successStatus - 输入：`number` — 成功码（通常 200）
 * @param deniedStatuses - 输入：`readonly number[]` — 拒绝码（403/429）
 * @returns 输出：`WarmAttemptOutcome` — hot / denied / retry
 */

export function classifyWarmHttpStatus(
  status: number,
  successStatus: number,
  deniedStatuses: readonly number[],
): WarmAttemptOutcome {
  if (status === successStatus) {
    return "hot";
  }
  if (deniedStatuses.includes(status)) {
    return "denied";
  }
  return "retry";
}

/**
 * 汇总预热结果计数。
 * @param outcomes - 输入：`WarmAttemptOutcome[]` — 各 IP 结果
 * @param total - 输入：`number` — IP 总数
 * @param elapsedMs - 输入：`number` — 耗时
 * @returns 输出：`WarmupSummary` — 汇总
 */
function summarizeOutcomes(
  outcomes: WarmAttemptOutcome[],
  total: number,
  elapsedMs: number,
): WarmupSummary {
  let hot = 0;
  let denied = 0;
  let retry = 0;
  for (const o of outcomes) {
    if (o === "hot") hot++;
    else if (o === "denied") denied++;
    else retry++;
  }
  return { total, hot, denied, retry, elapsedMs };
}