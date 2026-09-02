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
   * 构造实例。
   * @param options - 输入：`IpFetchStatsStoreOptions` — 配置选项
   * @returns 输出：`IpFetchStatsStore` — IpFetchStatsStore 实例
   */constructor(options: IpFetchStatsStoreOptions) {
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
   * 执行 listHostnames。
   * @returns 输出：`string[]` — string[] 实例
   */
  listHostnames(): string[] {
    return [...this.domains.keys()].sort((a, b) => a.localeCompare(b));
  }

  /**
   * 执行 recordAttempt。
   * @param args - 输入：`object` — 请求参数
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
  }

  /**
   * 执行 addBytes。
   * @param hostname - 输入：`string` — hostname 参数
   * @param ip - 输入：`string` — ip 参数
   * @param bytes - 输入：`number` — bytes 参数
   * @returns 输出：无（`void`）
   */
  addBytes(hostname: string, ip: string, bytes: number): void {
    const host = normalizeHostname(hostname);
    if (!host || !ip || bytes <= 0) return;
    const row = this.ensure(host, ip);
    row.totalBytes += bytes;
    this.markDirty(host);
    this.bumpRevision(host);
  }

  /**
   * 执行 resetHostname。
   * @param hostname - 输入：`string` — hostname 参数
   * @returns 输出：`number` — 数值结果
   */
  resetHostname(hostname: string): number {
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
  }

  /**
   * 获取。
   * @param hostname - 输入：`string` — hostname 参数
   * @param ip - 输入：`string` — ip 参数
   * @returns 输出：`undefined | IpFetchStatRow` — undefined | IpFetchStatRow 实例
   */get(hostname: string, ip: string): IpFetchStatRow | undefined {
    const host = normalizeHostname(hostname);
    if (!host) return undefined;
    const bucket = this.ensureDomain(host);
    const row = bucket.rows.get(ip);
    return row ? { ...row, avgDurationMs: avgMs(row) } : undefined;
  }

  /**
   * 获取 DomainRevision。
   * @param hostname - 输入：`string` — hostname 参数
   * @returns 输出：`number` — 数值结果
   */
  getDomainRevision(hostname: string): number {
    const host = normalizeHostname(hostname);
    if (!host) return 0;
    return this.domainRevisions.get(host) ?? 0;
  }

  /**
   * 执行 collectChangedActive。
   * @param hostname - 输入：`string` — hostname 参数
   * @param lastSent - 输入：`ReadonlyMap` — lastSent 参数
   * @returns 输出：`null | object` — null | object 实例
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
  }

  /**
   * 执行 summarizeForUi。
   * @param hostname - 输入：`string` — hostname 参数
   * @param topN - 输入：`number` — topN 参数
   * @returns 输出：`null | object` — null | object 实例
   */
  summarizeForUi(
    hostname: string,
  /** ≤0 或省略：返回全部 IP（含 0 请求）；>0：仅有请求的 TopN（v4/v6 交错） */
    topN = 0,
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

    for (const [ip, row] of bucket.rows) {
      const req = row.requests ?? 0;
      if (req > 0) {
        totalRequests += row.requests;
        totalSuccess += row.success;
        totalFailed += row.failed;
        totalBytes += row.totalBytes;
        if (ip.includes(":")) activeIpv6 += 1;
        else activeIpv4 += 1;
      } else if (onlyActive) {
        continue;
      }
      (ip.includes(":") ? listV6 : listV4).push([ip, row]);
    }

    const byReq = (a: [string, IpFetchStatRow], b: [string, IpFetchStatRow]) =>
      b[1].requests - a[1].requests || a[0].localeCompare(b[0]);
    listV4.sort(byReq);
    listV6.sort(byReq);
    const cap = topN > 0 ? topN : listV4.length + listV6.length;
    const topPairs = interleavePairs(listV4, listV6, cap);
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
      top: topPairs.map(([ip, row]) => ({
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
      })),
    };
  }

  /**
   * 执行 snapshot。
   * @param hostname - 输入：`string` — hostname 参数
   * @returns 输出：`IpFetchStatsFile` — IpFetchStatsFile 实例
   */snapshot(hostname: string): IpFetchStatsFile {
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
  }

  /**
   * 执行 flush。
   * @returns 输出：无（`void`）
   */
  flush(): void {
    for (const hostname of this.domains.keys()) {
      this.flushHostname(hostname);
    }
  }

  /**
   * 执行 close。
   * @returns 输出：无（`void`）
   */close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flush();
  }

  /**
   * 执行 filePathFor。
   * @param hostname - 输入：`string` — hostname 参数
   * @returns 输出：`string` — 字符串结果
   */filePathFor(hostname: string): string {
    return join(this.dirPath, `${normalizeHostname(hostname)}.yaml`);
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
 * 执行 serializeRow。
 * @param row - 输入：`IpFetchStatRow` — row 参数
 * @returns 输出：`IpFetchStatRow` — IpFetchStatRow 实例
 */function serializeRow(row: IpFetchStatRow): IpFetchStatRow {
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
 * 执行 avgMs。
 * @param row - 输入：`IpFetchStatRow` — row 参数
 * @returns 输出：`number` — 数值结果
 */function avgMs(row: IpFetchStatRow): number {
  if (row.requests <= 0) return 0;
  return Math.round(row.totalDurationMs / row.requests);
}

/**
 * 执行 interleavePairs。
 * @param v4 - 输入：`T[]` — v4 参数
 * @param v6 - 输入：`T[]` — v6 参数
 * @param topN - 输入：`number` — topN 参数
 * @returns 输出：`T[]` — T[] 实例
 */function interleavePairs<T>(v4: T[], v6: T[], topN: number): T[] {
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
 * 执行 normalizeHostname。
 * @param raw - 输入：`string` — raw 参数
 * @returns 输出：`string` — 字符串结果
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
