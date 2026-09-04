import { randomUUID } from "node:crypto";

import { Logger } from "../core/Logger.js";
import type { IpGeoRegistry } from "./IpGeoRegistry.js";
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
   * 绑定地理表与可选 IP 统计存储初始化。
   * @param options - 输入：`FetchMetricsOptions` — 汇总间隔与环形缓冲上限
   * @param geo - 输入：`IpGeoRegistry` — IP → 地区查询表
   * @param ipStats - 输入：`undefined | IpFetchStatsStore` — 按域名落盘的 IP 统计
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
   * 生成新的业务请求 ID。
   * @returns 输出：`string` — UUID
   */
  createRequestId(): string {
    return randomUUID();
  }

  /**
   * 标记业务请求开始并计入 inFlight。
   * @param requestId - 输入：`string` — 业务请求 ID
   * @param url - 输入：`string` — 完整 HTTP URL
   * @returns 输出：无（`void`）
   */
  onRequestStart(requestId: string, url: string): void {
    FetchMetrics.logger.measureSync(
      "onRequestStart",
      () => {
        this.submitted++;
        this.inFlight++;
        this.active.set(requestId, {
          url,
          startedAt: Date.now(),
          attempts: 0,
          ipsUsed: [],
        });
      },
      { requestId, url },
    );
  }

  /**
   * 记录单次 fetch 尝试结果并更新分桶计数。
   * @param requestId - 输入：`string` — 业务请求 ID
   * @param url - 输入：`string` — 完整 HTTP URL
   * @param attempt - 输入：`number` — 当前尝试序号（从 1 起）
   * @param ip - 输入：`undefined | string` — 本次使用的连接 IP
   * @param outcome - 输入：`FetchAttemptOutcome` — 成功/HTTP 错/传输错/无热 IP
   * @param durationMs - 输入：`number` — 本次尝试耗时毫秒
   * @param bytes - 输入：`undefined | number` — 响应体字节数
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
    FetchMetrics.logger.measureSync(
      "onAttempt",
      () => {
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
      },
      { requestId, url, attempt, ip, outcome: outcome.kind, durationMs },
    );
  }

  /**
   * 标记业务请求成功并写入最终记录。
   * @param requestId - 输入：`string` — 业务请求 ID
   * @param ip - 输入：`string` — 最终成功使用的 IP
   * @param httpStatus - 输入：`number` — 最终 HTTP 状态码
   * @param bytes - 输入：`number` — 响应体字节数
   * @returns 输出：无（`void`）
   */
  onRequestSuccess(requestId: string, ip: string, httpStatus: number, bytes: number): void {
    FetchMetrics.logger.measureSync(
      "onRequestSuccess",
      () => {
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.succeeded++;
        this.finishRequest(requestId, "success", ip, httpStatus, bytes);
      },
      { requestId, ip, httpStatus, bytes },
    );
  }

  /**
   * 标记业务请求最终失败并写入记录。
   * @param requestId - 输入：`string` — 业务请求 ID
   * @param lastIp - 输入：`undefined | string` — 最后一次尝试的 IP
   * @param lastStatus - 输入：`undefined | number` — 最后一次 HTTP 状态码
   * @returns 输出：无（`void`）
   */
  onRequestFailed(requestId: string, lastIp?: string, lastStatus?: number): void {
    FetchMetrics.logger.measureSync(
      "onRequestFailed",
      () => {
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.failed++;
        this.finishRequest(requestId, "failed", lastIp, lastStatus);
      },
      { requestId, lastIp, lastStatus },
    );
  }

  /**
   * 向内存与落盘 IP 桶追加响应字节。
   * @param ip - 输入：`string` — 连接 IP
   * @param bytes - 输入：`number` — 追加字节数
   * @param hostname - 输入：`undefined | string` — 请求域名；有则同步落盘统计
   * @returns 输出：无（`void`）
   */
  addIpBytes(ip: string, bytes: number, hostname?: string): void {
    FetchMetrics.logger.measureSync(
      "addIpBytes",
      () => {
        if (!ip || bytes <= 0) return;
        const bucket = this.byIp.get(ip);
        if (bucket) {
          bucket.totalBytes = (bucket.totalBytes ?? 0) + bytes;
          this.byIp.set(ip, bucket);
        }
        if (hostname) {
          this.ipStats?.addBytes(hostname, ip, bytes);
        }
      },
      { ip, bytes, hostname },
    );
  }

  /**
   * 返回可选的 IP 统计落盘存储。
   * @returns 输出：`undefined | IpFetchStatsStore` — 未配置目录时为 undefined
   */
  getIpStatsStore(): IpFetchStatsStore | undefined {
    return this.ipStats;
  }

  /**
   * 将脏 IP 统计刷入 YAML。
   * @returns 输出：无（`void`）
   */
  flushIpStats(): void {
    FetchMetrics.logger.measureSync(
      "flushIpStats",
      () => {
        this.ipStats?.flush();
      },
      { hasStore: Boolean(this.ipStats) },
    );
  }

  /**
   * 重置某域名下全部 IP 计数并刷盘。
   * @param hostname - 输入：`string` — 请求主机名
   * @returns 输出：`number` — 被重置的 IP 条数
   */
  resetIpStats(hostname: string): number {
    return FetchMetrics.logger.measureSync(
      "resetIpStats",
      () => this.ipStats?.resetHostname(hostname) ?? 0,
      { hostname },
    );
  }

  /**
   * 将飞行路径推入近期环形缓冲。
   * @param path - 输入：`FetchFlightPath` — 单次请求的飞行路径
   * @returns 输出：无（`void`）
   */
  onFlightPath(path: FetchFlightPath): void {
    FetchMetrics.logger.measureSync(
      "onFlightPath",
      () => {
        this.pushRecent(this.recentFlightPaths, path, this.options.maxRecentFlightPaths);
      },
      { requestId: path.requestId, waypoints: path.waypoints.length },
    );
  }

  /**
   * 导出当前计数与近期记录快照。
   * @returns 输出：`FetchMetricsSnapshot` — 字段见 export type FetchMetricsSnapshot
   */
  getSnapshot(): FetchMetricsSnapshot {
    return FetchMetrics.logger.measureSync(
      "getSnapshot",
      () => ({
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
      }),
      { submitted: this.submitted, inFlight: this.inFlight },
    );
  }

  /**
   * 只读近期飞行路径（不拷贝 byIp 大表，供地图脉冲 drain）。
   * @returns 输出：`readonly FetchFlightPath[]` — 环形缓冲当前内容
   */
  getRecentFlightPaths(): readonly FetchFlightPath[] {
    return this.recentFlightPaths;
  }

  /**
   * 将当前快照摘要打到 INFO 日志。
   * @returns 输出：无（`void`）
   */
  logSummary(): void {
    FetchMetrics.logger.measureSync(
      "logSummary",
      () => {
        const s = this.getSnapshot();
        FetchMetrics.logger.info("fetch 指标汇总", {
          submitted: s.submitted,
          inFlight: s.inFlight,
          succeeded: s.succeeded,
          failed: s.failed,
          totalAttempts: s.totalAttempts,
          byStatus: s.byStatus,
          byCountry: s.byCountry,
          byRegion: s.byRegion,
        });
      },
      { submitted: this.submitted },
    );
  }

  /**
   * 停止汇总定时器并关闭 IP 统计存储。
   * @returns 输出：无（`void`）
   */
  close(): void {
    FetchMetrics.logger.measureSync(
      "close",
      () => {
        if (this.summaryTimer) {
          clearInterval(this.summaryTimer);
          this.summaryTimer = undefined;
        }
        this.ipStats?.close();
      },
      { hadTimer: Boolean(this.summaryTimer) },
    );
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
 * 将尝试结果映射为 byStatus 键。
 * @param outcome - 输入：`FetchAttemptOutcome` — 单次尝试结果
 * @returns 输出：`string` — HTTP 状态码字符串或 transport/no_hot_ip
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
 * 将计数 Map 转为普通对象。
 * @param map - 输入：`Map<string, number>` — 状态码或标签计数
 * @returns 输出：`Record<string, number>` — 可 JSON 序列化的计数表
 */
function mapToRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(map.entries());
}

/**
 * 从 URL 提取小写主机名。
 * @param url - 输入：`string` — 完整 HTTP URL
 * @returns 输出：`string` — 主机名；非法 URL 为空串
 */
function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 将桶 Map 转为普通对象。
 * @param map - 输入：`Map<string, FetchCounterBucket>` — 国家/地区桶
 * @returns 输出：`Record<string, FetchCounterBucket>` — 可序列化桶表
 */
function mapToRecordBuckets(
  map: Map<string, FetchCounterBucket>,
): Record<string, FetchCounterBucket> {
  return Object.fromEntries(map.entries());
}

/**
 * 为 IP 桶附加平均耗时字段。
 * @param map - 输入：`Map<string, FetchCounterBucket>` — 按 IP 聚合的桶
 * @returns 输出：`Record<string, FetchCounterBucket & { avgDurationMs: number }>` — 含均值的 IP 表
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

