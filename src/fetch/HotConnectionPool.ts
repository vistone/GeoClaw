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
  HotFetchTimeoutError,
  HotFetchTransportError,
} from "./FetchErrors.js";
import { ColdConnectionPool } from "./ColdConnectionPool.js";
import { pickFairHotIp } from "./HotIpPicker.js";

export { pickFairHotIp, pickNearestExpiryHotIp } from "./HotIpPicker.js";

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
  /** 下载中命中这些状态码时入冷池（默认与 deniedStatuses 相同） */
  coldPoolStatuses: readonly number[];
  /** 创建池后立即后台首轮预热（不阻塞，HTTP 200 即入热池） */
  autoStartWarmup: boolean;
  /**
   * 估计服务端空闲超时（毫秒）。选路优先把任务派给最接近过期的热连接以续命；
   * 空闲达到该窗口约 75% 时发轻量保活。0 表示不按过期排序/不保活（退化为任意热 IP）。
   */
  idleExpireMs: number;
  /** 每轮保活最大并发 */
  keepAliveConcurrency: number;
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
  cold: number;
  initialWarmupInProgress: boolean;
};

type IpSlot = {
  ip: string;
  family: HostPinRecord["family"];
  state: HotSlotState;
  client?: Client;
  lastStatus?: number;
  lastError?: string;
  nextReheatAt: number;
  /** 最近一次成功收发时间（保活 / 判断空闲） */
  lastUsedAt: number;
  /** 业务派发次数（不含预热/保活）；选路优先参与少的 */
  assignCount: number;
};

/**
 * 按 IP 维护 node-wreq 热连接；仅 HTTP 200 入池，403/429 拒绝并后台重试直至 200。
 */
export class HotConnectionPool {
  private static readonly logger = new Logger("HotConnectionPool");
  private readonly options: HotConnectionPoolOptions;
  private readonly slots = new Map<string, IpSlot>();
  private readonly hotIps: string[] = [];
  private readonly coldPool: ColdConnectionPool;
  private reheatTimer: ReturnType<typeof setInterval> | undefined;
  private reheatRunning = false;
  private reheatBusy = false;
  private initialWarmupInProgress = false;
  private initialWarmupPromise: Promise<WarmupSummary> | null = null;

  /**
   * 构造实例。
   * @param options - 输入：`HotConnectionPoolOptions` — 配置选项
   * @returns 输出：`HotConnectionPool` — HotConnectionPool 实例
   */

  constructor(options: HotConnectionPoolOptions) {
    this.options = options;
    this.coldPool = new ColdConnectionPool({
      coldPoolStatuses: options.coldPoolStatuses,
    });
    for (const record of options.ips) {
      this.slots.set(record.ip, {
        ip: record.ip,
        family: record.family,
        state: "pending",
        nextReheatAt: 0,
        lastUsedAt: 0,
        assignCount: 0,
      });
    }
    HotConnectionPool.logger.info("热连接池已创建", {
      hostname: options.hostname,
      ipCount: options.ips.length,
    });
    if (options.autoStartWarmup) {
      this.startInitialWarmup();
      this.startBackgroundReheat();
    }
  }

  /**
   * 执行 startInitialWarmup。
   * @returns 输出：无（`void`）
   */

  startInitialWarmup(): void {
    if (this.initialWarmupPromise) {
      return;
    }
    this.initialWarmupInProgress = true;
    this.initialWarmupPromise = this.runInitialWarmupInternal();
    void this.initialWarmupPromise.finally(() => {
      this.initialWarmupInProgress = false;
    });
  }

  /**
   * 判断 InitialWarmupInProgress。
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */

  isInitialWarmupInProgress(): boolean {
    return this.initialWarmupInProgress;
  }

  /**
   * 执行 waitInitialWarmup。
   * @returns 输出：`Promise<WarmupSummary>` — 异步返回 WarmupSummary
   */

  waitInitialWarmup(): Promise<WarmupSummary> {
    if (!this.initialWarmupPromise) {
      return Promise.resolve(this.buildWarmupSummary(0));
    }
    return this.initialWarmupPromise;
  }

  /**
   * 启动首轮预热并在完成后返回汇总。
   * @returns 输出：`Promise<WarmupSummary>` — 预热汇总
   */
  async runInitialWarmup(): Promise<WarmupSummary> {
    return HotConnectionPool.logger.measureAsync(
      "runInitialWarmup",
      async () => {
        this.startInitialWarmup();
        return this.waitInitialWarmup();
      },
      { total: this.slots.size },
    );
  }

  /**
   * 执行首轮预热任务（内部异步）。
   * @returns 输出：`Promise<WarmupSummary>` — 汇总
   */

  private async runInitialWarmupInternal(): Promise<WarmupSummary> {
    const started = Date.now();
    const ips = [...this.slots.keys()];
    HotConnectionPool.logger.info("开始后台批量预热", {
      count: ips.length,
      batchConcurrency: this.options.initialConcurrency,
    });
    const outcomes = await this.runPool(
      ips,
      this.options.initialConcurrency,
      (ip) => this.warmOne(ip),
    );

    const summary = summarizeOutcomes(outcomes, ips.length, Date.now() - started);
    HotConnectionPool.logger.info("后台首轮预热完成", summary);
    return summary;
  }

  /**
   * 构建空/已完成预热汇总（尚未启动时）。
   * @param elapsedMs - 输入：`number` — 耗时毫秒
   * @returns 输出：`WarmupSummary` — 汇总
   */

  private buildWarmupSummary(elapsedMs: number): WarmupSummary {
    const stats = this.getStats();
    return {
      total: stats.total,
      hot: stats.hot,
      denied: stats.denied,
      retry: stats.failed + stats.pending,
      elapsedMs,
    };
  }

  /**
   * 执行 startBackgroundReheat。
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
   * 执行 stopBackgroundReheat。
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
   * 获取 HotCount。
   * @returns 输出：`number` — 数值结果
   */

  getHotCount(): number {
    return this.hotIps.length;
  }

  /**
   * 获取 HotIps。
   * @returns 输出：`string[]` — string[] 实例
   */
  getHotIps(): string[] {
    return [...this.hotIps];
  }

  /**
   * 执行 resetAssignCounts。
   * @returns 输出：`number` — 数值结果
   */
  resetAssignCounts(): number {
    let n = 0;
    for (const slot of this.slots.values()) {
      if (slot.assignCount) n += 1;
      slot.assignCount = 0;
    }
    return n;
  }

  /**
   * 判断 Hot。
   * @param ip - 输入：`string` — ip 参数
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */
  isHot(ip: string): boolean {
    return this.slots.get(ip)?.state === "hot" && !this.coldPool.isCold(ip);
  }

  /**
   * 获取 ColdCount。
   * @returns 输出：`number` — 数值结果
   */

  getColdCount(): number {
    return this.coldPool.getColdCount();
  }

  /**
   * 获取 ColdPool。
   * @returns 输出：`ColdConnectionPool` — ColdConnectionPool 实例
   */

  getColdPool(): ColdConnectionPool {
    return this.coldPool;
  }

  /**
   * 获取 Stats。
   * @returns 输出：`HotPoolStats` — HotPoolStats 实例
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
      reheatQueueSize: this.coldPool.getDueForReheat().length,
      cold: this.coldPool.getColdCount(),
      initialWarmupInProgress: this.initialWarmupInProgress,
    };
  }

  /**
   * 拉取 Once。
   * @param url - 输入：`string` — 完整 HTTP URL
   * @param extraHeaders - 输入：`Record<string, string>` — extraHeaders 参数
   * @returns 输出：`Promise<object>` — 异步返回 object
   * @throws {Error} 条件不满足或 I/O 失败时
   */

  /**
   * 经热连接发起单次 GET；非 successStatus 时踢池并抛错。
   * @param url - 输入：`string` — 完整 HTTP URL
   * @param extraHeaders - 输入：`Record<string, string>` — 附加请求头
   * @param pick - 输入：`undefined | object` — timeoutMs / warmSlack / exploreRatio
   * @returns 输出：`Promise<object>` — response、选用 IP、timings
   */
  async fetchOnce(
    url: string,
    extraHeaders: Record<string, string> = {},
    pick?: {
      timeoutMs?: number;
      /** 软公平带宽：带内优先复用最近用过的热连接；落后 IP 仍会补上 */
      warmSlack?: number;
      /** 0~1：以该概率走严格公平（最久未用），保证全池都会被打到 */
      exploreRatio?: number;
    },
  ): Promise<{
    response: Awaited<ReturnType<Client["get"]>>;
    ip: string;
    timings?: RequestTimings;
  }> {
    return HotConnectionPool.logger.measureAsync(
      "fetchOnce",
      async () => {
        if (this.hotIps.length === 0) {
          throw new HotFetchNoHotIpError();
        }

        const ip = this.pickHotIp(pick?.warmSlack, pick?.exploreRatio);
        const slot = this.slots.get(ip);
        if (!slot?.client || this.coldPool.isCold(ip)) {
          throw new HotFetchNoHotIpError();
        }
        // 一派出即计数，避免失败重试总砸同一条「参与少」的连接
        slot.assignCount += 1;

        const timeoutMs = pick?.timeoutMs ?? this.options.timeoutMs;
        let stats: RequestStats | undefined;
        const t0 = Date.now();
        try {
          const response = await slot.client.get(url, {
            headers: extraHeaders,
            ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
            onStats: (s: RequestStats) => {
              stats = s;
            },
          });
          const t1 = Date.now();

          if (response.status === this.options.successStatus) {
            slot.lastUsedAt = t1;
            const timings =
              response.wreq.timings ??
              stats?.timings ??
              ({ startTime: t0, responseStart: t1, wait: t1 - t0 } satisfies RequestTimings);
            return { response, ip, timings };
          }

          // 非 200：丢弃 body（不 await），403/429 入冷池；其余保留热连接，任务立即回队
          void response.arrayBuffer().catch(() => undefined);
          if (this.coldPool.shouldAdmit(response.status)) {
            this.evictToColdPool(ip, response.status);
          }
          throw new HotFetchNotOkError(response.status, ip);
        } catch (err) {
          if (err instanceof HotFetchNotOkError) {
            throw err;
          }
          // 超时：保留热连接，任务回队换 IP（不入待预热、不当错误）
          if (isTimeoutError(err)) {
            HotConnectionPool.logger.debug("热连接请求超时，保留热池并回队", {
              ip,
              timeoutMs,
              error: formatTransportError(err),
            });
            throw new HotFetchTimeoutError(ip, err);
          }
          this.evictFailedFromHot(ip, undefined, err);
          throw new HotFetchTransportError(ip, err);
        }
      },
      {
        url,
        hotCount: this.hotIps.length,
        warmSlack: pick?.warmSlack ?? null,
        exploreRatio: pick?.exploreRatio ?? null,
        timeoutMs: pick?.timeoutMs ?? this.options.timeoutMs ?? null,
      },
    );
  }

  /**
   * 与 fetchOnce 相同（兼容旧名）。
   * @param url - 输入：`string` — 完整 HTTP URL
   * @param extraHeaders - 输入：`Record<string, string>` — 附加请求头
   * @returns 输出：`Promise<object>` — response、选用 IP、timings
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
   * 停止后台重热并关闭全部热连接 client。
   * @returns 输出：无（`void`）
   */
  close(): void {
    HotConnectionPool.logger.measureSync(
      "close",
      () => {
        this.stopBackgroundReheat();
        for (const slot of this.slots.values()) {
          slot.client?.close();
          slot.client = undefined;
        }
        this.hotIps.length = 0;
      },
      { slots: this.slots.size },
    );
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
        slot.lastUsedAt = Date.now();
        this.coldPool.release(ip);
        this.addToHotList(ip);
        HotConnectionPool.logger.debug("IP 入热池", { ip, status: response.status });
        return "hot";
      }

      await response.arrayBuffer().catch(() => undefined);
      client.close();

      if (outcome === "denied") {
        slot.state = "denied";
        slot.lastStatus = response.status;
        this.coldPool.ensureCold(ip, response.status, this.options.deniedBackoffMs);
        HotConnectionPool.logger.debug("IP 预热仍拒绝，留冷池", { ip, status: response.status });
        return "denied";
      }

      slot.state = "failed";
      slot.lastStatus = response.status;
      slot.nextReheatAt = Date.now() + this.options.reheatBackoffMs;
      this.coldPool.scheduleReheat(ip, this.options.reheatBackoffMs);
      return "retry";
    } catch (err) {
      client.close();
      // EOF / 超时等：进待预热队列，热通前不参与下载
      this.enqueuePendingReheat(ip, err, "warmup");
      return "retry";
    }
  }

  /**
   * 传输失败后进入待预热：移出热池、设退避，由后台 tick 再 warmOne。
   */
  private enqueuePendingReheat(
    ip: string,
    err?: unknown,
    source = "transport",
    status?: number,
  ): void {
    const slot = this.slots.get(ip);
    if (!slot) return;

    slot.client?.close();
    slot.client = undefined;
    slot.state = "failed";
    if (status !== undefined) slot.lastStatus = status;
    const errorDetail = formatTransportError(err);
    if (errorDetail) slot.lastError = errorDetail;
    this.removeFromHotList(ip);
    slot.nextReheatAt = Date.now() + this.options.reheatBackoffMs;

    if (this.coldPool.isCold(ip)) {
      this.coldPool.scheduleReheat(ip, this.options.reheatBackoffMs);
    }

    HotConnectionPool.logger.warn("IP 入待预热队列（热通前不参与下载）", {
      ip,
      source,
      status: status ?? null,
      error: errorDetail ?? "(无详情)",
      transient: isEofOrTimeoutError(err),
      reheatBackoffMs: this.options.reheatBackoffMs,
      nextReheatAt: new Date(slot.nextReheatAt).toISOString(),
    });
  }

  /**
   * 后台重加热 tick。
   * @returns 输出：`Promise<void>`
   */

  private async tickReheat(): Promise<void> {
    if (!this.reheatRunning || this.reheatBusy) {
      return;
    }

    this.reheatBusy = true;
    try {
      const due = this.coldPool.getDueForReheat();
      const now = Date.now();
      const pendingReheat = [...this.slots.values()]
        .filter(
          (s) =>
            s.state === "failed" &&
            !this.coldPool.isCold(s.ip) &&
            now >= (s.nextReheatAt || 0),
        )
        .map((s) => s.ip);

      const batchIps = [...new Set([...due, ...pendingReheat])].filter((ip) => {
        const slot = this.slots.get(ip);
        return slot && slot.state !== "hot" && slot.state !== "warming";
      });

      const tasks: Promise<unknown>[] = [];

      if (batchIps.length > 0) {
        const batch = batchIps.slice(0, this.options.reheatConcurrency);
        HotConnectionPool.logger.debug("后台重加热批次", {
          count: batch.length,
          fromCold: due.length,
          fromPending: pendingReheat.length,
        });
        tasks.push(this.runPool(batch, this.options.reheatConcurrency, (ip) => this.warmOne(ip)));
      }

      // 与重热并行，互不等待串行拖死事件循环
      tasks.push(this.keepAliveIdleHot());
      await Promise.all(tasks);
    } finally {
      this.reheatBusy = false;
    }
  }

  /**
   * 对即将空闲超时的热连接发轻量 GET；优先续命最老的，避免全量狂 ping。
   */
  private async keepAliveIdleHot(): Promise<void> {
    const expireMs = this.options.idleExpireMs;
    if (!expireMs || expireMs <= 0) return;
    // 首轮预热期间不做保活，避免与大批量预热抢占带宽/触发对端限流
    if (this.initialWarmupInProgress) return;

    const now = Date.now();
    // 空闲达到窗口 75% 即视为「快要超时」，与业务选路同一套过期模型
    const keepAliveAfter = Math.floor(expireMs * 0.75);
    const due = this.hotIps
      .map((ip) => {
        const slot = this.slots.get(ip);
        if (!slot?.client || slot.state !== "hot" || this.coldPool.isCold(ip)) {
          return null;
        }
        const age = now - (slot.lastUsedAt || 0);
        if (age < keepAliveAfter) return null;
        return { ip, lastUsedAt: slot.lastUsedAt || 0 };
      })
      .filter((x): x is { ip: string; lastUsedAt: number } => x != null)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    if (due.length === 0) return;

    const concurrency = Math.max(1, this.options.keepAliveConcurrency);
    const batch = due.slice(0, concurrency).map((x) => x.ip);
    HotConnectionPool.logger.debug("热连接保活（快过期优先）", {
      count: batch.length,
      due: due.length,
      idleExpireMs: expireMs,
      keepAliveAfter,
    });
    await this.runPool(batch, concurrency, async (ip) => {
      const slot = this.slots.get(ip);
      if (!slot?.client || slot.state !== "hot") return;
      try {
        const response = await slot.client.get(this.options.warmupUrl, {
          ...(this.options.timeoutMs !== undefined ? { timeout: this.options.timeoutMs } : {}),
        });
        await response.arrayBuffer().catch(() => undefined);
        if (response.status === this.options.successStatus) {
          slot.lastUsedAt = Date.now();
          slot.lastStatus = response.status;
          return;
        }
        // 保活非 200：403/429 入冷池；其余保留热连接（与下载路径一致，不踢池占重热）
        if (this.coldPool.shouldAdmit(response.status)) {
          this.evictToColdPool(ip, response.status);
        }
      } catch (err) {
        // 保活超时：不算错误，不踢热池
        if (isTimeoutError(err)) {
          HotConnectionPool.logger.debug("热连接保活超时，跳过", {
            ip,
            error: formatTransportError(err),
          });
          return;
        }
        HotConnectionPool.logger.debug("热连接保活失败，移出重热", {
          ip,
          error: formatTransportError(err) ?? String(err),
        });
        this.evictFailedFromHot(ip, undefined, err);
      }
    });
  }

  /**
   * 下载中 403/429：移出热池并放入冷池，须预热 HTTP 200 后才可恢复。
   * @param ip - 输入：`string` — IP
   * @param status - 输入：`number` — HTTP 状态
   * @returns 输出：无（`void`）
   */

  private evictToColdPool(ip: string, status: number): void {
    const slot = this.slots.get(ip);
    if (!slot) {
      return;
    }
    slot.client?.close();
    slot.client = undefined;
    slot.state = "denied";
    slot.lastStatus = status;
    this.removeFromHotList(ip);
    this.coldPool.ensureCold(ip, status, this.options.deniedBackoffMs);
    HotConnectionPool.logger.warn("下载 403/429，IP 入冷池", { ip, status });
  }

  /**
   * 非冷池拒绝类失败：移出热池，短退避后重预热（不入冷池除非已在冷池）。
   * @param ip - 输入：`string` — IP
   * @param status - 输入：`number | undefined` — HTTP 状态
   * @param err - 输入：`unknown` — 传输错误
   * @returns 输出：无（`void`）
   */

  private evictFailedFromHot(ip: string, status?: number, err?: unknown): void {
    if (!this.slots.get(ip)) {
      return;
    }
    // 统一进待预热：业务/保活传输失败也不再参与下载，等 warmOne 成功后再入热池
    this.enqueuePendingReheat(
      ip,
      err,
      status !== undefined ? `http_${status}` : "download_or_keepalive",
      status,
    );
  }

  /**
   * 选取业务 IP。
   * @param warmSlack - 输入：`undefined | number` — 软公平带宽；>0 时带内优先最近用过
   * @param exploreRatio - 输入：`undefined | number` — 0~1，以该概率严格公平（保证全池都会用到）
   * @returns 输出：`string` — IP 地址
   */
  private pickHotIp(warmSlack?: number, exploreRatio?: number): string {
    const now = Date.now();
    const candidates: { ip: string; lastUsedAt: number; assignCount: number }[] = [];

    for (const ip of this.hotIps) {
      if (this.coldPool.isCold(ip)) {
        this.removeFromHotList(ip);
        continue;
      }
      const slot = this.slots.get(ip);
      if (!slot?.client || slot.state !== "hot") {
        this.removeFromHotList(ip);
        continue;
      }
      candidates.push({
        ip,
        lastUsedAt: slot.lastUsedAt || 0,
        assignCount: slot.assignCount || 0,
      });
    }

    const explore = Math.max(0, Math.min(1, exploreRatio ?? 0));
    const useStrictFair = explore > 0 && Math.random() < explore;
    const slack = useStrictFair ? 0 : Math.max(0, Math.floor(warmSlack ?? 0));
    const picked = pickFairHotIp(candidates, now, this.options.idleExpireMs, {
      warmSlack: slack,
    });
    if (!picked) {
      throw new HotFetchNoHotIpError();
    }
    return picked;
  }

  /**
   * 将 IP 加入热池列表。
   * @param ip - 输入：`string` — IP
   * @returns 输出：无（`void`）
   */

  private addToHotList(ip: string): void {
    if (!this.hotIps.includes(ip)) {
      this.hotIps.push(ip);
    }
  }

  /**
   * 从热池列表移除 IP。
   * @param ip - 输入：`string` — IP
   * @returns 输出：无（`void`）
   */

  private removeFromHotList(ip: string): void {
    const idx = this.hotIps.indexOf(ip);
    if (idx >= 0) {
      this.hotIps.splice(idx, 1);
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

    const yieldEventLoop = (): Promise<void> =>
      new Promise((resolve) => setImmediate(resolve));

    async function loop(): Promise<void> {
      let sinceYield = 0;
      while (true) {
        const i = next++;
        if (i >= items.length) {
          return;
        }
        results[i] = await worker(items[i]!);
        // 大批量预热/保活时让出事件循环，避免堵死 HTTP/WS
        sinceYield += 1;
        if (sinceYield >= 8) {
          sinceYield = 0;
          await yieldEventLoop();
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () => loop()),
    );
    return results;
  }
}

/**
 * 执行 formatTransportError。
 * @param err - 输入：`unknown` — 错误对象
 * @returns 输出：`undefined | string` — undefined | string 实例
 */
export function formatTransportError(err: unknown): string | undefined {
  if (err === undefined || err === null) return undefined;
  if (typeof err === "string") return err;
  if (!(err instanceof Error)) return String(err);

  const parts: string[] = [];
  const name = err.name && err.name !== "Error" ? err.name : "";
  const msg = err.message || "";
  if (name && msg) parts.push(`${name}: ${msg}`);
  else if (msg) parts.push(msg);
  else if (name) parts.push(name);

  const code = (err as { code?: string | number }).code;
  if (code !== undefined && code !== "") parts.push(`code=${code}`);

  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== null) {
    const nested = formatTransportError(cause);
    if (nested) parts.push(`cause=${nested}`);
  }
  return parts.join(" | ") || String(err);
}

/**
 * 判断 EofOrTimeoutError。
 * @param err - 输入：`unknown` — 错误对象
 * @returns 输出：`boolean` — 条件成立返回 true，否则 false
 */
export function isEofOrTimeoutError(err: unknown): boolean {
  const text = (formatTransportError(err) ?? "").toLowerCase();
  if (!text) return false;
  return /eof|timeout|timed out|econnreset|econnrefused|econnaborted|broken pipe|connection reset|connection closed|connection refused|unexpected eof|goaway|network|unreachable|host unreachable/.test(
    text,
  );
}

/**
 * 判断 TimeoutError。
 * @param err - 输入：`unknown` — 错误对象
 * @returns 输出：`boolean` — 条件成立返回 true，否则 false
 */
export function isTimeoutError(err: unknown): boolean {
  const text = (formatTransportError(err) ?? "").toLowerCase();
  if (!text) return false;
  return /timeout|timed out|err_timeout/.test(text);
}

/**
 * 创建 HotConnectionPoolFromConfig。
 * @returns 输出：`undefined | HotConnectionPool` — undefined | HotConnectionPool 实例
 */

export function createHotConnectionPoolFromConfig(): HotConnectionPool | undefined {
  const opts = GeoClawConfig.get().getWarmPoolOptions();
  if (!opts) {
    return undefined;
  }
  return new HotConnectionPool(opts);
}

/**
 * 执行 classifyWarmHttpStatus。
 * @param status - 输入：`number` — status 参数
 * @param successStatus - 输入：`number` — successStatus 参数
 * @param deniedStatuses - 输入：`number[]` — deniedStatuses 参数
 * @returns 输出：`"retry" | "hot" | "denied"` — "retry" | "hot" | "denied" 实例
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
 * 执行 summarizeOutcomes。
 * @param outcomes - 输入：`"retry" | "hot" | "denied"[]` — outcomes 参数
 * @param total - 输入：`number` — total 参数
 * @param elapsedMs - 输入：`number` — elapsedMs 参数
 * @returns 输出：`WarmupSummary` — WarmupSummary 实例
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