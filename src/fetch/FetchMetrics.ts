import { randomUUID } from "node:crypto";

import { Logger } from "../core/Logger.js";
import type { IpGeoInfo, IpGeoRegistry } from "./IpGeoRegistry.js";
import type { IpFetchStatsStore } from "./IpFetchStatsStore.js";
import type { FetchFlightPath } from "./FetchFlightPath.js";

/** 单次 fetch 尝试结果 */
export type FetchAttemptOutcome =
  | { kind: "success"; httpStatus: number }
  | { kind: "http_error"; httpStatus: number }
  | { kind: "transport_error" }
  | { kind: "no_hot_ip" };

/** 单次尝试记录（每次 hotPool.fetchOnce 或冷路径 GET） */
export type FetchAttemptRecord = {
  requestId: string;
  url: string;
  attempt: number;
  ip?: string;
  outcome: FetchAttemptOutcome["kind"];
  httpStatus?: number;
  durationMs: number;
  bytes?: number;
  city?: string;
  region?: string;
  country?: string;
  at: number;
};

/** 业务请求最终记录（FetchTaskPool 一次 submit 的最终结果） */
export type FetchRequestRecord = {
  requestId: string;
  url: string;
  outcome: "success" | "failed";
  attempts: number;
  totalDurationMs: number;
  finalIp?: string;
  finalStatus?: number;
  ipsUsed: string[];
  bytes?: number;
  at: number;
};

/** 计数器桶 */
export type FetchCounterBucket = {
  attempts: number;
  success: number;
  failed: number;
  totalDurationMs: number;
  totalBytes?: number;
};

/** 指标快照 */
export type FetchMetricsSnapshot = {
  submitted: number;
  inFlight: number;
  succeeded: number;
  failed: number;
  totalAttempts: number;
  byStatus: Record<string, number>;
  byIp: Record<string, FetchCounterBucket & { avgDurationMs: number }>;
  byCountry: Record<string, FetchCounterBucket>;
  byRegion: Record<string, FetchCounterBucket>;
  recentAttempts: FetchAttemptRecord[];
  recentRequests: FetchRequestRecord[];
  recentFlightPaths: FetchFlightPath[];
};

/** FetchMetrics 配置（geoclaw.yaml fetchMetrics 段） */
export type FetchMetricsOptions = {
  enabled: boolean;
  logEachAttempt: boolean;
  summaryIntervalMs: number;
  maxRecentAttempts: number;
  maxRecentRequests: number;
  maxRecentFlightPaths: number;
  /** 按域名分文件的 IP 统计目录；null/空关闭落盘 */
  ipStatsDir?: string | null;
  /** IP 统计刷盘间隔 ms */
  ipStatsFlushIntervalMs?: number;
  /** 首次接触域名时用对应 HostPin YAML 预填 IP */
  ipStatsSeedFromHostPin?: boolean;
};

type ActiveRequest = {
  url: string;
  startedAt: number;
  attempts: number;
  ipsUsed: string[];
};

/**
 * Fetch 全链路指标：请求量、成功率、失败码、IP、地区、耗时。
 */
export class FetchMetrics {
  private static readonly logger = new Logger("FetchMetrics");
  private readonly options: FetchMetricsOptions;
  private readonly geo: IpGeoRegistry;
  private readonly ipStats: IpFetchStatsStore | undefined;
  private summaryTimer: ReturnType<typeof setInterval> | undefined;

  private submitted = 0;
  private inFlight = 0;
  private succeeded = 0;
  private failed = 0;
  private totalAttempts = 0;
  private readonly byStatus = new Map<string, number>();
  private readonly byIp = new Map<string, FetchCounterBucket>();
  private readonly byCountry = new Map<string, FetchCounterBucket>();
  private readonly byRegion = new Map<string, FetchCounterBucket>();
  private readonly recentAttempts: FetchAttemptRecord[] = [];
  private readonly recentRequests: FetchRequestRecord[] = [];
  private readonly recentFlightPaths: FetchFlightPath[] = [];
  private readonly active = new Map<string, ActiveRequest>();

  /**
   * 构造实例。
   * @param options - 输入：`FetchMetricsOptions` — 配置选项
   * @param geo - 输入：`IpGeoRegistry` — geo 参数
   * @param ipStats - 输入：`undefined | IpFetchStatsStore` — ipStats 参数
   * @returns 输出：`FetchMetrics` — FetchMetrics 实例
   */
  constructor(
    options: FetchMetricsOptions,
    geo: IpGeoRegistry,
    ipStats?: IpFetchStatsStore,
  ) {
    this.options = options;
    this.geo = geo;
    this.ipStats = ipStats;
    if (options.summaryIntervalMs > 0) {
      this.summaryTimer = setInterval(() => this.logSummary(), options.summaryIntervalMs);
    }
  }

  /**
   * 创建 RequestId。
   * @returns 输出：`string` — 字符串结果
   */

  createRequestId(): string {
    return randomUUID();
  }

  /**
   * 执行 onRequestStart。
   * @param requestId - 输入：`string` — requestId 参数
   * @param url - 输入：`string` — 完整 HTTP URL
   * @returns 输出：无（`void`）
   */

  onRequestStart(requestId: string, url: string): void {
    this.submitted++;
    this.inFlight++;
    this.active.set(requestId, {
      url,
      startedAt: Date.now(),
      attempts: 0,
      ipsUsed: [],
    });
  }

  /**
   * 执行 onAttempt。
   * @param requestId - 输入：`string` — requestId 参数
   * @param url - 输入：`string` — 完整 HTTP URL
   * @param attempt - 输入：`number` — attempt 参数
   * @param ip - 输入：`undefined | string` — ip 参数
   * @param outcome - 输入：`object` — outcome 参数
   * @param durationMs - 输入：`number` — durationMs 参数
   * @param bytes - 输入：`undefined | number` — bytes 参数
   * @returns 输出：无（`void`）
   */

  onAttempt(
    requestId: string,
    url: string,
    attempt: number,
    ip: string | undefined,
    outcome: FetchAttemptOutcome,
    durationMs: number,
    bytes?: number,
  ): void {
    this.totalAttempts++;
    const active = this.active.get(requestId);
    if (active) {
      active.attempts = attempt;
      if (ip && !active.ipsUsed.includes(ip)) {
        active.ipsUsed.push(ip);
      }
    }

    const statusKey = outcomeStatusKey(outcome);
    this.bumpMap(this.byStatus, statusKey);

    const geo = ip ? this.geo.lookup(ip) : undefined;
    if (ip) {
      this.bumpCounter(this.byIp, ip, outcome.kind === "success", durationMs, bytes);
      const hostname = hostnameFromUrl(url);
      if (hostname) {
        this.ipStats?.recordAttempt({
          hostname,
          ip,
          success: outcome.kind === "success",
          durationMs,
          bytes,
          city: geo?.city,
          region: geo?.region,
          country: geo?.country,
          loc: geo?.loc,
        });
      }
    }
    if (geo?.country) {
      this.bumpCounter(this.byCountry, geo.country, outcome.kind === "success", durationMs);
    }
    if (geo?.region) {
      this.bumpCounter(this.byRegion, geo.region, outcome.kind === "success", durationMs);
    }

    const record: FetchAttemptRecord = {
      requestId,
      url,
      attempt,
      ip,
      outcome: outcome.kind,
      httpStatus: outcome.kind === "success" || outcome.kind === "http_error" ? outcome.httpStatus : undefined,
      durationMs,
      bytes,
      city: geo?.city,
      region: geo?.region,
      country: geo?.country,
      at: Date.now(),
    };
    this.pushRecent(this.recentAttempts, record, this.options.maxRecentAttempts);

    if (this.options.logEachAttempt) {
      FetchMetrics.logger.info("fetch 尝试", record);
    }
  }

  /**
   * 执行 onRequestSuccess。
   * @param requestId - 输入：`string` — requestId 参数
   * @param ip - 输入：`string` — ip 参数
   * @param httpStatus - 输入：`number` — httpStatus 参数
   * @param bytes - 输入：`number` — bytes 参数
   * @returns 输出：无（`void`）
   */

  onRequestSuccess(requestId: string, ip: string, httpStatus: number, bytes: number): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.succeeded++;
    this.finishRequest(requestId, "success", ip, httpStatus, bytes);
  }

  /**
   * 执行 onRequestFailed。
   * @param requestId - 输入：`string` — requestId 参数
   * @param lastIp - 输入：`undefined | string` — lastIp 参数
   * @param lastStatus - 输入：`undefined | number` — lastStatus 参数
   * @returns 输出：无（`void`）
   */

  onRequestFailed(requestId: string, lastIp?: string, lastStatus?: number): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.failed++;
    this.finishRequest(requestId, "failed", lastIp, lastStatus);
  }

  /**
   * 执行 addIpBytes。
   * @param ip - 输入：`string` — ip 参数
   * @param bytes - 输入：`number` — bytes 参数
   * @param hostname - 输入：`undefined | string` — hostname 参数
   * @returns 输出：无（`void`）
   */
  addIpBytes(ip: string, bytes: number, hostname?: string): void {
    if (!ip || bytes <= 0) return;
    const bucket = this.byIp.get(ip);
    if (bucket) {
      bucket.totalBytes = (bucket.totalBytes ?? 0) + bytes;
      this.byIp.set(ip, bucket);
    }
    if (hostname) {
      this.ipStats?.addBytes(hostname, ip, bytes);
    }
  }

  /**
   * 获取 IpStatsStore。
   * @returns 输出：`undefined | IpFetchStatsStore` — undefined | IpFetchStatsStore 实例
   */
  getIpStatsStore(): IpFetchStatsStore | undefined {
    return this.ipStats;
  }

  /**
   * 执行 flushIpStats。
   * @returns 输出：无（`void`）
   */
  flushIpStats(): void {
    this.ipStats?.flush();
  }

  /**
   * 执行 resetIpStats。
   * @param hostname - 输入：`string` — hostname 参数
   * @returns 输出：`number` — 数值结果
   */
  resetIpStats(hostname: string): number {
    return this.ipStats?.resetHostname(hostname) ?? 0;
  }

  /**
   * 执行 onFlightPath。
   * @param path - 输入：`FetchFlightPath` — 八分体路径
   * @returns 输出：无（`void`）
   */
  onFlightPath(path: FetchFlightPath): void {
    this.pushRecent(this.recentFlightPaths, path, this.options.maxRecentFlightPaths);
  }

  /**
   * 获取 Snapshot。
   * @returns 输出：`FetchMetricsSnapshot` — FetchMetricsSnapshot 实例
   */

  getSnapshot(): FetchMetricsSnapshot {
    return {
      submitted: this.submitted,
      inFlight: this.inFlight,
      succeeded: this.succeeded,
      failed: this.failed,
      totalAttempts: this.totalAttempts,
      byStatus: mapToRecord(this.byStatus),
      byIp: mapIpStats(this.byIp),
      byCountry: mapToRecordBuckets(this.byCountry),
      byRegion: mapToRecordBuckets(this.byRegion),
      recentAttempts: [...this.recentAttempts],
      recentRequests: [...this.recentRequests],
      recentFlightPaths: [...this.recentFlightPaths],
    };
  }

  /**
   * 执行 logSummary。
   * @returns 输出：无（`void`）
   */

  logSummary(): void {
    const s = this.getSnapshot();
    FetchMetrics.logger.info("fetch 指标汇总", {
      submitted: s.submitted,
      inFlight: s.inFlight,
      succeeded: s.succeeded,
      failed: s.failed,
      totalAttempts: s.totalAttempts,
      byStatus: s.byStatus,
      topCountries: topBuckets(s.byCountry, 5),
      topRegions: topBuckets(s.byRegion, 5),
    });
  }

  /**
   * 执行 close。
   * @returns 输出：无（`void`）
   */

  close(): void {
    if (this.summaryTimer) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = undefined;
    }
    this.ipStats?.close();
  }

  /**
   * @param requestId - 输入：`string` — 请求 ID
   * @param outcome - 输入：`"success" | "failed"` — 最终结果
   * @param finalIp - 输入：`string | undefined` — 最终 IP
   * @param finalStatus - 输入：`number | undefined` — 最终 HTTP 状态
   * @param bytes - 输入：`number | undefined` — 响应字节
   * @returns 输出：无（`void`）
   */

  private finishRequest(
    requestId: string,
    outcome: "success" | "failed",
    finalIp?: string,
    finalStatus?: number,
    bytes?: number,
  ): void {
    const active = this.active.get(requestId);
    if (!active) {
      return;
    }
    this.active.delete(requestId);
    const record: FetchRequestRecord = {
      requestId,
      url: active.url,
      outcome,
      attempts: active.attempts,
      totalDurationMs: Date.now() - active.startedAt,
      finalIp,
      finalStatus,
      ipsUsed: [...active.ipsUsed],
      bytes,
      at: Date.now(),
    };
    this.pushRecent(this.recentRequests, record, this.options.maxRecentRequests);
  }

  /**
   * @param map - 输入：`Map<string, number>` — 计数 map
   * @param key - 输入：`string` — 键
   * @returns 输出：无（`void`）
   */

  private bumpMap(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  /**
   * @param map - 输入：`Map<string, FetchCounterBucket>` — 桶 map
   * @param key - 输入：`string` — 键
   * @param success - 输入：`boolean` — 是否成功
   * @param durationMs - 输入：`number` — 耗时
   * @returns 输出：无（`void`）
   */

  private bumpCounter(
    map: Map<string, FetchCounterBucket>,
    key: string,
    success: boolean,
    durationMs: number,
    bytes?: number,
  ): void {
    const bucket = map.get(key) ?? {
      attempts: 0,
      success: 0,
      failed: 0,
      totalDurationMs: 0,
      totalBytes: 0,
    };
    bucket.attempts++;
    bucket.totalDurationMs += durationMs;
    if (success) {
      bucket.success++;
      if (bytes && bytes > 0) {
        bucket.totalBytes = (bucket.totalBytes ?? 0) + bytes;
      }
    } else {
      bucket.failed++;
    }
    map.set(key, bucket);
  }

  /**
   * @param list - 输入：`T[]` — 环形缓冲
   * @param item - 输入：`T` — 新条目
   * @param max - 输入：`number` — 上限
   * @returns 输出：无（`void`）
   */

  private pushRecent<T>(list: T[], item: T, max: number): void {
    list.push(item);
    while (list.length > max) {
      list.shift();
    }
  }
}

/**
 * 执行 outcomeStatusKey。
 * @param outcome - 输入：`object` — outcome 参数
 * @returns 输出：`string` — 字符串结果
 */
function outcomeStatusKey(outcome: FetchAttemptOutcome): string {
  switch (outcome.kind) {
    case "success":
      return String(outcome.httpStatus);
    case "http_error":
      return String(outcome.httpStatus);
    case "transport_error":
      return "transport";
    case "no_hot_ip":
      return "no_hot_ip";
  }
}

/**
 * 执行 mapToRecord。
 * @param map - 输入：`Map` — map 参数
 * @returns 输出：`Record<string, number>` — Record<string, number> 实例
 */
function mapToRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(map.entries());
}

/**
 * 执行 hostnameFromUrl。
 * @param url - 输入：`string` — 完整 HTTP URL
 * @returns 输出：`string` — 字符串结果
 */function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 执行 mapToRecordBuckets。
 * @param map - 输入：`Map` — map 参数
 * @returns 输出：`Record<string, FetchCounterBucket>` — Record<string, FetchCounterBucket> 实例
 */
function mapToRecordBuckets(
  map: Map<string, FetchCounterBucket>,
): Record<string, FetchCounterBucket> {
  return Object.fromEntries(map.entries());
}

/**
 * 执行 mapIpStats。
 * @param map - 输入：`Map` — map 参数
 * @returns 输出：`object` — object 实例
 */
function mapIpStats(
  map: Map<string, FetchCounterBucket>,
): Record<string, FetchCounterBucket & { avgDurationMs: number }> {
  const out: Record<string, FetchCounterBucket & { avgDurationMs: number }> = {};
  for (const [ip, bucket] of map.entries()) {
    out[ip] = {
      ...bucket,
      avgDurationMs: bucket.attempts > 0 ? Math.round(bucket.totalDurationMs / bucket.attempts) : 0,
    };
  }
  return out;
}

/**
 * 执行 topBuckets。
 * @param buckets - 输入：`Record<string, FetchCounterBucket>` — buckets 参数
 * @param n - 输入：`number` — n 参数
 * @returns 输出：`Record<string, FetchCounterBucket>` — Record<string, FetchCounterBucket> 实例
 */
function topBuckets(
  buckets: Record<string, FetchCounterBucket>,
  n: number,
): Record<string, FetchCounterBucket> {
  const sorted = Object.entries(buckets).sort((a, b) => b[1].attempts - a[1].attempts);
  return Object.fromEntries(sorted.slice(0, n));
}
