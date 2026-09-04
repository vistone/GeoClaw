import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { Logger } from "../core/Logger.js";

/** 单 IP 累计统计 */
export type IpFetchStatRow = {
  requests: number;
  success: number;
  failed: number;
  totalBytes: number;
  totalDurationMs: number;
  /** 写入时计算：totalDurationMs / requests */
  avgDurationMs?: number;
  city?: string;
  region?: string;
  country?: string;
  /** 原始 loc 字符串 "lat,lng"（若有） */
  loc?: string;
};

export type IpFetchStatsFile = {
  hostname: string;
  updatedAt: string;
  ips: Record<string, IpFetchStatRow>;
};

export type IpFetchStatsSeedIp = {
  ip: string;
  city?: string;
  region?: string;
  country?: string;
  loc?: string;
};

export type IpFetchStatsStoreOptions = {
  /** 统计目录：每个域名一个 `<hostname>.yaml` */
  dirPath: string;
  /** 刷盘间隔；0 表示仅显式 flush / close */
  flushIntervalMs: number;
  /** 首次接触某域名时预填 IP（通常来自 config/{hostname}.yaml） */
  seedForHostname?: (hostname: string) => ReadonlyArray<IpFetchStatsSeedIp> | undefined;
};

type DomainBucket = {
  rows: Map<string, IpFetchStatRow>;
  dirty: boolean;
  loaded: boolean;
};

/**
 * 按「请求域名」分文件持久化 IP 请求统计（YAML）。
 * 路径：`{dirPath}/{hostname}.yaml`，与 HostPin 同属 config 树管理。
 */
export class IpFetchStatsStore {
  private static readonly logger = new Logger("IpFetchStatsStore");
  private readonly dirPath: string;
  private readonly seedForHostname?: IpFetchStatsStoreOptions["seedForHostname"];
  private readonly domains = new Map<string, DomainBucket>();
  /** 每域名变更世代：有请求记账时递增，供 WS 增量跳过 */
  private readonly domainRevisions = new Map<string, number>();
  private flushTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * 按统计目录与刷盘间隔初始化，并发现已有 YAML。
   * @param options - 输入：`IpFetchStatsStoreOptions` — dirPath、flushIntervalMs、可选种子
   */
  constructor(options: IpFetchStatsStoreOptions) {
    this.dirPath = options.dirPath;
    this.seedForHostname = options.seedForHostname;
    mkdirSync(this.dirPath, { recursive: true });
    this.discoverExisting();
    if (options.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        try {
          this.flush();
        } catch (err) {
          IpFetchStatsStore.logger.warn("IP 统计刷盘失败", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }, options.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  /**
   * 列出已知域名（已有文件或曾记账）。
   * @returns 输出：`string[]` — 按字典序排序的主机名
   */
  listHostnames(): string[] {
    return [...this.domains.keys()].sort((a, b) => a.localeCompare(b));
  }

  /**
   * 记账一次请求尝试（缺文件时懒加载 YAML）。
   * @param args - 输入：`{ hostname; ip; success; durationMs; ... }` — 域名、IP、成败与耗时
   * @returns 输出：无（`void`）
   */
  recordAttempt(args: {
    hostname: string;
    ip: string;
    success: boolean;
    durationMs: number;
    bytes?: number;
    city?: string;
    region?: string;
    country?: string;
    loc?: string;
  }): void {
    IpFetchStatsStore.logger.measureSync(
      "recordAttempt",
      () => {
        const hostname = normalizeHostname(args.hostname);
        if (!hostname || !args.ip) return;
        const row = this.ensure(hostname, args.ip, args);
        row.requests += 1;
        row.totalDurationMs += Math.max(0, args.durationMs);
        if (args.success) {
          row.success += 1;
          if (args.bytes && args.bytes > 0) {
            row.totalBytes += args.bytes;
          }
        } else {
          row.failed += 1;
        }
        this.markDirty(hostname);
        this.bumpRevision(hostname);
      },
      { hostname: args.hostname, ip: args.ip, success: args.success },
    );
  }

  /**
   * 批量累加某 IP 的请求计数（压测刷盘，避免逐次 recordAttempt）。
   * @param args - 输入：`{ hostname; ip; success; failed; durationSumMs; ... }` — 域名、IP、成功/失败次数、耗时合计与字节
   * @returns 输出：无（`void`）
   */
  recordBatch(args: {
    hostname: string;
    ip: string;
    success: number;
    failed: number;
    durationSumMs: number;
    bytes?: number;
    city?: string;
    region?: string;
    country?: string;
    loc?: string;
  }): void {
    IpFetchStatsStore.logger.measureSync(
      "recordBatch",
      () => {
        const hostname = normalizeHostname(args.hostname);
        if (!hostname || !args.ip) return;
        const success = Math.max(0, Math.floor(args.success));
        const failed = Math.max(0, Math.floor(args.failed));
        if (success === 0 && failed === 0) return;
        const row = this.ensure(hostname, args.ip, args);
        row.requests += success + failed;
        row.success += success;
        row.failed += failed;
        row.totalDurationMs += Math.max(0, args.durationSumMs);
        if (args.bytes && args.bytes > 0) {
          row.totalBytes += args.bytes;
        }
        this.markDirty(hostname);
        this.bumpRevision(hostname);
      },
      { hostname: args.hostname, ip: args.ip, success: args.success, failed: args.failed },
    );
  }

  /**
   * 向指定域名 IP 追加下载字节。
   * @param hostname - 输入：`string` — 请求主机名
   * @param ip - 输入：`string` — 连接 IP
   * @param bytes - 输入：`number` — 追加字节数
   * @returns 输出：无（`void`）
   */
  addBytes(hostname: string, ip: string, bytes: number): void {
    IpFetchStatsStore.logger.measureSync(
      "addBytes",
      () => {
        const host = normalizeHostname(hostname);
        if (!host || !ip || bytes <= 0) return;
        const row = this.ensure(host, ip);
        row.totalBytes += bytes;
        this.markDirty(host);
        this.bumpRevision(host);
      },
      { hostname, ip, bytes },
    );
  }

  /**
   * 清零某域名下全部 IP 计数并立即刷盘。
   * @param hostname - 输入：`string` — 请求主机名
   * @returns 输出：`number` — 被重置的 IP 条数
   */
  resetHostname(hostname: string): number {
    return IpFetchStatsStore.logger.measureSync(
      "resetHostname",
      () => {
        const host = normalizeHostname(hostname);
        if (!host) return 0;
        const bucket = this.ensureDomain(host);
        let n = 0;
        for (const row of bucket.rows.values()) {
          row.requests = 0;
          row.success = 0;
          row.failed = 0;
          row.totalBytes = 0;
          row.totalDurationMs = 0;
          n += 1;
        }
        bucket.dirty = true;
        this.bumpRevision(host);
        this.flushHostname(host);
        IpFetchStatsStore.logger.info("IP 统计已重置", { hostname: host, ips: n });
        return n;
      },
      { hostname },
    );
  }

  /**
   * 读取某域名下单 IP 的累计统计（含均值）。
   * @param hostname - 输入：`string` — 请求主机名
   * @param ip - 输入：`string` — 连接 IP
   * @returns 输出：`undefined | IpFetchStatRow` — 无记录为 undefined
   */
  get(hostname: string, ip: string): IpFetchStatRow | undefined {
    return IpFetchStatsStore.logger.measureSync(
      "get",
      () => {
        const host = normalizeHostname(hostname);
        if (!host) return undefined;
        const bucket = this.ensureDomain(host);
        const row = bucket.rows.get(ip);
        return row ? { ...row, avgDurationMs: avgMs(row) } : undefined;
      },
      { hostname, ip },
    );
  }

  /**
   * 返回某域名统计的变更世代号。
   * @param hostname - 输入：`string` — 请求主机名
   * @returns 输出：`number` — 记账递增；未知域名为 0
   */
  getDomainRevision(hostname: string): number {
    const host = normalizeHostname(hostname);
    if (!host) return 0;
    return this.domainRevisions.get(host) ?? 0;
  }

  /**
   * 相对上次签名收集有请求的活跃 IP 增量。
   * @param hostname - 输入：`string` — 请求主机名
   * @param lastSent - 输入：`ReadonlyMap<string, string>` — IP → 上次签名
   * @returns 输出：`null | object` — 字段见返回类型；非法主机名为 null
   */
  collectChangedActive(
    hostname: string,
    lastSent: ReadonlyMap<string, string>,
  ): {
    hostname: string;
    updatedAt: string;
    totalIps: number;
    activeIps: number;
    activeIpv4: number;
    activeIpv6: number;
    totalRequests: number;
    totalSuccess: number;
    totalFailed: number;
    totalBytes: number;
    changed: Array<{
      ip: string;
      family: "ipv4" | "ipv6";
      requests: number;
      success: number;
      failed: number;
      totalBytes: number;
      avgDurationMs: number;
      city?: string;
      country?: string;
      loc?: string;
      sig: string;
    }>;
  } | null {
    return IpFetchStatsStore.logger.measureSync(
      "collectChangedActive",
      () => {
        const host = normalizeHostname(hostname);
        if (!host) return null;
        const bucket = this.ensureDomain(host);
        let activeIpv4 = 0;
        let activeIpv6 = 0;
        let totalRequests = 0;
        let totalSuccess = 0;
        let totalFailed = 0;
        let totalBytes = 0;
        const changed: Array<{
          ip: string;
          family: "ipv4" | "ipv6";
          requests: number;
          success: number;
          failed: number;
          totalBytes: number;
          avgDurationMs: number;
          city?: string;
          country?: string;
          loc?: string;
          sig: string;
        }> = [];

        for (const [ip, row] of bucket.rows) {
          if ((row.requests ?? 0) <= 0) continue;
          totalRequests += row.requests;
          totalSuccess += row.success;
          totalFailed += row.failed;
          totalBytes += row.totalBytes;
          const family = ip.includes(":") ? ("ipv6" as const) : ("ipv4" as const);
          if (family === "ipv6") activeIpv6 += 1;
          else activeIpv4 += 1;
          const avgDurationMs = avgMs(row);
          const sig = `${row.requests}:${row.success}:${row.failed}:${row.totalBytes}:${avgDurationMs}`;
          if (lastSent.get(ip) === sig) continue;
          changed.push({
            ip,
            family,
            requests: row.requests,
            success: row.success,
            failed: row.failed,
            totalBytes: row.totalBytes,
            avgDurationMs,
            ...(row.city ? { city: row.city } : {}),
            ...(row.country ? { country: row.country } : {}),
            ...(row.loc ? { loc: row.loc } : {}),
            sig,
          });
        }

        return {
          hostname: host,
          updatedAt: new Date().toISOString(),
          totalIps: bucket.rows.size,
          activeIps: activeIpv4 + activeIpv6,
          activeIpv4,
          activeIpv6,
          totalRequests,
          totalSuccess,
          totalFailed,
          totalBytes,
          changed,
        };
      },
      { hostname, lastSentSize: lastSent.size },
    );
  }

  /**
   * 将有请求的 IP 签名写入 target（全量同步后供增量比对，不组装 UI 行）。
   * @param hostname - 输入：`string` — 请求主机名
   * @param target - 输入：`Map<string, string>` — ip → sig
   * @returns 输出：`number` — 写入条数
   */
  seedActiveSigsInto(hostname: string, target: Map<string, string>): number {
    return IpFetchStatsStore.logger.measureSync(
      "seedActiveSigsInto",
      () => {
        const host = normalizeHostname(hostname);
        if (!host) return 0;
        const bucket = this.domains.get(host);
        if (!bucket) return 0;
        let n = 0;
        for (const [ip, row] of bucket.rows) {
          if ((row.requests ?? 0) <= 0) continue;
          const avgDurationMs = avgMs(row);
          target.set(
            ip,
            `${row.requests}:${row.success}:${row.failed}:${row.totalBytes}:${avgDurationMs}`,
          );
          n += 1;
        }
        return n;
      },
      { hostname },
    );
  }

  /** 按 revision 缓存的全量 IP 交错序列（有请求在前） */
  private readonly orderedActiveIpCache = new Map<
    string,
    { revision: number; ips: string[] }
  >();

  /**
   * 返回域名下全部 IP 的稳定交错序列（有请求优先，再零请求；v4/v6 交错）。
   * @param hostname - 输入：`string` — 请求主机名
   * @param countryFilter - 输入：`string | null | undefined` — ISO 国别码；空=全部；`ZZ`=无国别
   * @returns 输出：`string[]` — IP 列表；非法主机名为空数组
   */
  listOrderedActiveIps(hostname: string, countryFilter?: string | null): string[] {
    return IpFetchStatsStore.logger.measureSync(
      "listOrderedActiveIps",
      () => {
        const host = normalizeHostname(hostname);
        if (!host) return [];
        const revision = this.getDomainRevision(host);
        const hit = this.orderedActiveIpCache.get(host);
        let ips: string[];
        if (hit && hit.revision === revision) {
          ips = hit.ips;
        } else {
          const bucket = this.ensureDomain(host);
          const activeV4: Array<[string, IpFetchStatRow]> = [];
          const activeV6: Array<[string, IpFetchStatRow]> = [];
          const idleV4: Array<[string, IpFetchStatRow]> = [];
          const idleV6: Array<[string, IpFetchStatRow]> = [];
          for (const [ip, row] of bucket.rows) {
            const bucketList =
              (row.requests ?? 0) > 0
                ? ip.includes(":")
                  ? activeV6
                  : activeV4
                : ip.includes(":")
                  ? idleV6
                  : idleV4;
            bucketList.push([ip, row]);
          }
          const byReq = (a: [string, IpFetchStatRow], b: [string, IpFetchStatRow]) =>
            b[1].requests - a[1].requests || a[0].localeCompare(b[0]);
          activeV4.sort(byReq);
          activeV6.sort(byReq);
          idleV4.sort(byReq);
          idleV6.sort(byReq);
          const active = interleavePairs(
            activeV4,
            activeV6,
            activeV4.length + activeV6.length,
          );
          const idle = interleavePairs(idleV4, idleV6, idleV4.length + idleV6.length);
          ips = [...active, ...idle].map(([ip]) => ip);
          this.orderedActiveIpCache.set(host, { revision, ips });
        }
        const filter = normalizeCountryFilter(countryFilter);
        if (!filter) return ips;
        const bucket = this.ensureDomain(host);
        return ips.filter((ip) => {
          const row = bucket.rows.get(ip);
          return normalizeCountryCode(row?.country) === filter;
        });
      },
      { hostname, countryFilter: countryFilter ?? "" },
    );
  }

  /**
   * 按交错序截取 IP 窗口并返回行数据（含零请求种子行）。
   * @param hostname - 输入：`string` — 请求主机名
   * @param start - 输入：`number` — 起始下标（从 0，含）
   * @param count - 输入：`number` — 窗口条数
   * @param countryFilter - 输入：`string | null | undefined` — 国别筛选；空=全部
   * @returns 输出：`null | object` — total/start/end/rows；非法主机名为 null
   */
  sliceActiveIpWindow(
    hostname: string,
    start: number,
    count: number,
    countryFilter?: string | null,
  ): {
    total: number;
    start: number;
    end: number;
    rows: Array<{
      ip: string;
      family: "ipv4" | "ipv6";
      requests: number;
      success: number;
      failed: number;
      totalBytes: number;
      avgDurationMs: number;
      city?: string;
      country?: string;
      loc?: string;
      index: number;
    }>;
  } | null {
    return IpFetchStatsStore.logger.measureSync(
      "sliceActiveIpWindow",
      () => {
        const host = normalizeHostname(hostname);
        if (!host) return null;
        const ips = this.listOrderedActiveIps(host, countryFilter);
        const total = ips.length;
        const safeStart = Math.max(0, Math.min(total, Math.floor(start) || 0));
        const safeCount = Math.max(1, Math.floor(count) || 24);
        const end = Math.min(total, safeStart + safeCount);
        const bucket = this.ensureDomain(host);
        const rows: Array<{
          ip: string;
          family: "ipv4" | "ipv6";
          requests: number;
          success: number;
          failed: number;
          totalBytes: number;
          avgDurationMs: number;
          city?: string;
          country?: string;
          loc?: string;
          index: number;
        }> = [];
        for (let i = safeStart; i < end; i++) {
          const ip = ips[i]!;
          const row = bucket.rows.get(ip);
          if (!row) continue;
          rows.push({
            ip,
            family: ip.includes(":") ? ("ipv6" as const) : ("ipv4" as const),
            requests: row.requests,
            success: row.success,
            failed: row.failed,
            totalBytes: row.totalBytes,
            avgDurationMs: avgMs(row),
            ...(row.city ? { city: row.city } : {}),
            ...(row.country ? { country: row.country } : {}),
            ...(row.loc ? { loc: row.loc } : {}),
            index: i,
          });
        }
        return { total, start: safeStart, end, rows };
      },
      { hostname, start, count, countryFilter: countryFilter ?? "" },
    );
  }

  /**
   * 汇总某域名 IP 统计供 UI 展示。
   * @param hostname - 输入：`string` — 请求主机名
   * @param topN - 输入：`number` — ≤0 返回全部行；>0 仅活跃 TopN（v4/v6 交错）
   * @param includeRows - 输入：`boolean` — false 时只算汇总、不组装 top 行（供 WS 摘要）
   * @returns 输出：`null | object` — 字段见返回类型；非法主机名为 null
   */
  summarizeForUi(
    hostname: string,
    /** ≤0 或省略：返回全部 IP（含 0 请求）；>0：仅有请求的 TopN（v4/v6 交错） */
    topN = 0,
    includeRows = true,
  ): {
    hostname: string;
    updatedAt: string;
    totalIps: number;
    activeIps: number;
    activeIpv4: number;
    activeIpv6: number;
    totalRequests: number;
    totalSuccess: number;
    totalFailed: number;
    totalBytes: number;
    byCountry: Array<{
      code: string;
      ips: number;
      requests: number;
      success: number;
      failed: number;
      totalBytes: number;
    }>;
    top: Array<{
      ip: string;
      family: "ipv4" | "ipv6";
      requests: number;
      success: number;
      failed: number;
      totalBytes: number;
      avgDurationMs: number;
      city?: string;
      country?: string;
      loc?: string;
    }>;
  } | null {
    return IpFetchStatsStore.logger.measureSync(
      "summarizeForUi",
      () => {
        const host = normalizeHostname(hostname);
        if (!host) return null;
        const bucket = this.ensureDomain(host);
        const listV4: Array<[string, IpFetchStatRow]> = [];
        const listV6: Array<[string, IpFetchStatRow]> = [];
        let totalRequests = 0;
        let totalSuccess = 0;
        let totalFailed = 0;
        let totalBytes = 0;
        let activeIpv4 = 0;
        let activeIpv6 = 0;
        const onlyActive = topN > 0;
        const countryAgg = new Map<
          string,
          { ips: number; requests: number; success: number; failed: number; totalBytes: number }
        >();

        for (const [ip, row] of bucket.rows) {
          const req = row.requests ?? 0;
          if (req > 0) {
            totalRequests += row.requests;
            totalSuccess += row.success;
            totalFailed += row.failed;
            totalBytes += row.totalBytes;
            if (ip.includes(":")) activeIpv6 += 1;
            else activeIpv4 += 1;
            const code = normalizeCountryCode(row.country);
            const cur = countryAgg.get(code) ?? {
              ips: 0,
              requests: 0,
              success: 0,
              failed: 0,
              totalBytes: 0,
            };
            cur.ips += 1;
            cur.requests += row.requests;
            cur.success += row.success;
            cur.failed += row.failed;
            cur.totalBytes += row.totalBytes;
            countryAgg.set(code, cur);
          } else if (onlyActive) {
            continue;
          } else {
            const code = normalizeCountryCode(row.country);
            const cur = countryAgg.get(code) ?? {
              ips: 0,
              requests: 0,
              success: 0,
              failed: 0,
              totalBytes: 0,
            };
            cur.ips += 1;
            countryAgg.set(code, cur);
          }
          if (includeRows) {
            (ip.includes(":") ? listV6 : listV4).push([ip, row]);
          }
        }

        let top: Array<{
          ip: string;
          family: "ipv4" | "ipv6";
          requests: number;
          success: number;
          failed: number;
          totalBytes: number;
          avgDurationMs: number;
          city?: string;
          country?: string;
          loc?: string;
        }> = [];

        if (includeRows) {
          const byReq = (a: [string, IpFetchStatRow], b: [string, IpFetchStatRow]) =>
            b[1].requests - a[1].requests || a[0].localeCompare(b[0]);
          listV4.sort(byReq);
          listV6.sort(byReq);
          const cap = topN > 0 ? topN : listV4.length + listV6.length;
          const topPairs = interleavePairs(listV4, listV6, cap);
          top = topPairs.map(([ip, row]) => ({
            ip,
            family: ip.includes(":") ? ("ipv6" as const) : ("ipv4" as const),
            requests: row.requests,
            success: row.success,
            failed: row.failed,
            totalBytes: row.totalBytes,
            avgDurationMs: avgMs(row),
            ...(row.city ? { city: row.city } : {}),
            ...(row.country ? { country: row.country } : {}),
            ...(row.loc ? { loc: row.loc } : {}),
          }));
        }

        const byCountry = [...countryAgg.entries()]
          .map(([code, v]) => ({ code, ...v }))
          .sort((a, b) => b.requests - a.requests || a.code.localeCompare(b.code));

        return {
          hostname: host,
          updatedAt: new Date().toISOString(),
          totalIps: bucket.rows.size,
          activeIps: activeIpv4 + activeIpv6,
          activeIpv4,
          activeIpv6,
          totalRequests,
          totalSuccess,
          totalFailed,
          totalBytes,
          byCountry,
          top,
        };
      },
      { hostname, topN, includeRows },
    );
  }

  /**
   * 导出某域名完整统计文档结构。
   * @param hostname - 输入：`string` — 请求主机名
   * @returns 输出：`IpFetchStatsFile` — hostname、updatedAt、ips
   */
  snapshot(hostname: string): IpFetchStatsFile {
    return IpFetchStatsStore.logger.measureSync(
      "snapshot",
      () => {
        const host = normalizeHostname(hostname);
        const bucket = host ? this.ensureDomain(host) : null;
        const ips: Record<string, IpFetchStatRow> = {};
        if (bucket) {
          for (const [ip, row] of [...bucket.rows.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            ips[ip] = serializeRow(row);
          }
        }
        return {
          hostname: host || hostname,
          updatedAt: new Date().toISOString(),
          ips,
        };
      },
      { hostname },
    );
  }

  /**
   * 将所有脏域名统计写入 YAML。
   * @returns 输出：无（`void`）
   */
  flush(): void {
    IpFetchStatsStore.logger.measureSync(
      "flush",
      () => {
        for (const hostname of this.domains.keys()) {
          this.flushHostname(hostname);
        }
      },
      { domainCount: this.domains.size },
    );
  }

  /**
   * 停止定时刷盘并执行最终 flush。
   * @returns 输出：无（`void`）
   */
  close(): void {
    IpFetchStatsStore.logger.measureSync(
      "close",
      () => {
        if (this.flushTimer) {
          clearInterval(this.flushTimer);
          this.flushTimer = undefined;
        }
        this.flush();
      },
      { hadTimer: Boolean(this.flushTimer) },
    );
  }

  /**
   * 返回某域名统计 YAML 的绝对路径。
   * @param hostname - 输入：`string` — 请求主机名
   * @returns 输出：`string` — `{dirPath}/{hostname}.yaml`
   */
  filePathFor(hostname: string): string {
    return join(this.dirPath, `${normalizeHostname(hostname)}.yaml`);
  }

  /**
   * 对尚无统计 YAML 的域名执行种子化并立即落盘。
   * @param hostnames - 输入：`readonly string[]` — 待补建的主机名
   * @returns 输出：`number` — 新写入的文件数
   */
  materializeMissingFromSeeds(hostnames: readonly string[]): number {
    return IpFetchStatsStore.logger.measureSync(
      "materializeMissingFromSeeds",
      () => {
        let written = 0;
        for (const raw of hostnames) {
          const host = normalizeHostname(raw);
          if (!host) continue;
          if (existsSync(this.filePathFor(host))) continue;
          this.ensureDomain(host);
          if (existsSync(this.filePathFor(host))) written += 1;
        }
        return written;
      },
      { hostnameCount: hostnames.length },
    );
  }

  private flushHostname(hostname: string): void {
    const host = normalizeHostname(hostname);
    if (!host) return;
    const bucket = this.domains.get(host);
    if (!bucket || (!bucket.dirty && existsSync(this.filePathFor(host)))) return;
    mkdirSync(this.dirPath, { recursive: true });
    const doc = this.snapshot(host);
    const text = stringifyYaml(doc, {
      lineWidth: 0,
      sortMapEntries: false,
    });
    writeFileSync(this.filePathFor(host), text, "utf8");
    bucket.dirty = false;
    IpFetchStatsStore.logger.debug("IP 统计已写入", {
      path: this.filePathFor(host),
      hostname: host,
      ips: Object.keys(doc.ips).length,
    });
  }

  private markDirty(hostname: string): void {
    const bucket = this.domains.get(hostname);
    if (bucket) bucket.dirty = true;
  }

  private bumpRevision(hostname: string): void {
    this.domainRevisions.set(hostname, (this.domainRevisions.get(hostname) ?? 0) + 1);
  }

  private ensure(
    hostname: string,
    ip: string,
    meta?: { city?: string; region?: string; country?: string; loc?: string },
  ): IpFetchStatRow {
    const bucket = this.ensureDomain(hostname);
    let row = bucket.rows.get(ip);
    if (!row) {
      row = {
        requests: 0,
        success: 0,
        failed: 0,
        totalBytes: 0,
        totalDurationMs: 0,
        city: meta?.city,
        region: meta?.region,
        country: meta?.country,
        loc: meta?.loc,
      };
      bucket.rows.set(ip, row);
      bucket.dirty = true;
    } else if (meta) {
      row.city = row.city ?? meta.city;
      row.region = row.region ?? meta.region;
      row.country = row.country ?? meta.country;
      row.loc = row.loc ?? meta.loc;
    }
    return row;
  }

  private ensureDomain(hostname: string): DomainBucket {
    let bucket = this.domains.get(hostname);
    if (!bucket) {
      bucket = { rows: new Map(), dirty: false, loaded: false };
      this.domains.set(hostname, bucket);
    }
    if (!bucket.loaded) {
      const filePath = this.filePathFor(hostname);
      const missingFile = !existsSync(filePath);
      // 先标记已加载，避免 seed → ensure 重入再次 load
      bucket.loaded = true;
      this.loadHostname(hostname, bucket);
      if (this.seedForHostname) {
        const seeds = this.seedForHostname(hostname);
        if (seeds?.length) {
          for (const r of seeds) {
            this.ensure(hostname, r.ip, r);
          }
        }
      }
      // 缺统计文件时：种子一旦有 IP，立刻落盘，不依赖刷盘定时器
      if (missingFile && bucket.rows.size > 0) {
        bucket.dirty = true;
        this.flushHostname(hostname);
        IpFetchStatsStore.logger.info("已从 HostPin 种子建立 IP 统计", {
          hostname,
          ips: bucket.rows.size,
          path: filePath,
        });
      }
    }
    return bucket;
  }

  private discoverExisting(): void {
    if (!existsSync(this.dirPath)) return;
    for (const name of readdirSync(this.dirPath)) {
      if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
      const hostname = name.replace(/\.ya?ml$/i, "");
      if (!normalizeHostname(hostname)) continue;
      if (!this.domains.has(hostname)) {
        this.domains.set(hostname, { rows: new Map(), dirty: false, loaded: false });
      }
    }
  }

  private loadHostname(hostname: string, bucket: DomainBucket): void {
    const filePath = this.filePathFor(hostname);
    if (!existsSync(filePath)) return;
    try {
      const raw = readFileSync(filePath, "utf8");
      const doc = parseYaml(raw) as IpFetchStatsFile | null;
      if (!doc?.ips || typeof doc.ips !== "object") return;
      for (const [ip, row] of Object.entries(doc.ips)) {
        if (!row || typeof row !== "object") continue;
        bucket.rows.set(ip, {
          requests: Number(row.requests) || 0,
          success: Number(row.success) || 0,
          failed: Number(row.failed) || 0,
          totalBytes: Number(row.totalBytes) || 0,
          totalDurationMs: Number(row.totalDurationMs) || 0,
          city: row.city,
          region: row.region,
          country: row.country,
          loc: row.loc,
        });
      }
      IpFetchStatsStore.logger.info("已加载 IP 统计", {
        path: filePath,
        hostname,
        ips: bucket.rows.size,
      });
    } catch (err) {
      IpFetchStatsStore.logger.warn("加载 IP 统计失败，将重建", {
        path: filePath,
        hostname,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * 序列化单行统计（含均值与可选地理字段）。
 * @param row - 输入：`IpFetchStatRow` — 内存中的累计行
 * @returns 输出：`IpFetchStatRow` — 可写入 YAML 的行副本
 */
function serializeRow(row: IpFetchStatRow): IpFetchStatRow {
  return {
    requests: row.requests,
    success: row.success,
    failed: row.failed,
    totalBytes: row.totalBytes,
    totalDurationMs: row.totalDurationMs,
    avgDurationMs: avgMs(row),
    ...(row.city ? { city: row.city } : {}),
    ...(row.region ? { region: row.region } : {}),
    ...(row.country ? { country: row.country } : {}),
    ...(row.loc ? { loc: row.loc } : {}),
  };
}

/**
 * 计算平均请求耗时毫秒。
 * @param row - 输入：`IpFetchStatRow` — 含 totalDurationMs 与 requests
 * @returns 输出：`number` — 四舍五入均值；无请求为 0
 */
function avgMs(row: IpFetchStatRow): number {
  if (row.requests <= 0) return 0;
  return Math.round(row.totalDurationMs / row.requests);
}

/**
 * 交错合并 v4/v6 列表至多 topN 条。
 * @param v4 - 输入：`T[]` — IPv4 条目（已排序）
 * @param v6 - 输入：`T[]` — IPv6 条目（已排序）
 * @param topN - 输入：`number` — 输出上限
 * @returns 输出：`T[]` — v4/v6 交替截断结果
 */
function interleavePairs<T>(v4: T[], v6: T[], topN: number): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (out.length < topN && (i < v4.length || j < v6.length)) {
    if (i < v4.length) out.push(v4[i++]!);
    if (out.length >= topN) break;
    if (j < v6.length) out.push(v6[j++]!);
  }
  return out;
}

/**
 * 规范化国别码；无效则 `ZZ`（未知）。
 * @param raw - 输入：`string | undefined` — 原始国别
 * @returns 输出：`string` — 大写二字码或 ZZ
 */
export function normalizeCountryCode(raw: string | undefined): string {
  const t = String(raw ?? "")
    .trim()
    .toUpperCase();
  if (/^[A-Z]{2}$/.test(t)) return t;
  return "ZZ";
}

/**
 * 规范化筛选国别；空/`ALL` 表示不筛选。
 * @param raw - 输入：`string | null | undefined` — 筛选值
 * @returns 输出：`string | null` — 国别码或 null
 */
export function normalizeCountryFilter(raw: string | null | undefined): string | null {
  const t = String(raw ?? "")
    .trim()
    .toUpperCase();
  if (!t || t === "ALL" || t === "*") return null;
  return normalizeCountryCode(t);
}

/**
 * 规范化主机名为可作文件名的小写串。
 * @param raw - 输入：`string` — 原始主机名
 * @returns 输出：`string` — 合法主机名；非法为空串
 */
export function normalizeHostname(raw: string): string {
  const h = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!h || h.includes("/") || h.includes("\\") || h.includes("..")) return "";
  if (!/^[a-z0-9._-]+$/i.test(h)) return "";
  return h;
}
