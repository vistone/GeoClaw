import { lookup as dnsLookup } from "node:dns/promises";

import { GeoClawConfig } from "../core/GeoClawConfig.js";
import { Logger } from "../core/Logger.js";
import type { FetchRouteOrigin } from "./FetchFlightPath.js";
import { parseLocString } from "./FetchFlightPath.js";
import type { HostPinRecord } from "./HostPinPool.js";
import { IpInfoClient, type IpInfoRecord } from "./IpInfoClient.js";

/** FetchRouteResolver 配置 */
export type FetchRouteResolverOptions = {
  enabled: boolean;
  cacheTtlMs: number;
  originViaProxy: boolean;
  ipInfo: IpInfoClient;
};

/**
 * 解析飞行路线 origin（出口 IP）与 system DNS 目标坐标（ipinfo.io）。
 */
export class FetchRouteResolver {
  private static readonly logger = new Logger("FetchRouteResolver");
  private readonly options: FetchRouteResolverOptions;
  private originCache: { origin: FetchRouteOrigin; expiresAt: number } | null = null;
  private originInFlight: Promise<FetchRouteOrigin | null> | null = null;
  private readonly ipCache = new Map<string, { record: IpInfoRecord; expiresAt: number }>();

  /**
   * 构造实例。
   * @param options - 输入：`FetchRouteResolverOptions` — 配置选项
   * @returns 输出：`FetchRouteResolver` — FetchRouteResolver 实例
   */

  constructor(options: FetchRouteResolverOptions) {
    this.options = options;
  }

  /**
   * 执行 resolveOrigin。
   * @param proxyUrl - 输入：`undefined | string` — proxyUrl 参数
   * @returns 输出：`Promise<null | FetchRouteOrigin>` — 异步返回 null | FetchRouteOrigin
   */

  async resolveOrigin(proxyUrl?: string): Promise<FetchRouteOrigin | null> {
    if (!this.options.enabled) {
      return null;
    }

    const now = Date.now();
    if (this.originCache && this.originCache.expiresAt > now) {
      return this.originCache.origin;
    }
    if (this.originInFlight) {
      return this.originInFlight;
    }

    this.originInFlight = (async () => {
      try {
        const lookupProxy = this.options.originViaProxy ? proxyUrl : undefined;
        const record = await this.options.ipInfo.lookupSelf(lookupProxy);
        const origin = ipInfoToOrigin(record);
        this.originCache = { origin, expiresAt: Date.now() + this.options.cacheTtlMs };
        FetchRouteResolver.logger.info("origin 已解析（出口 IP）", {
          ip: record.ip,
          city: record.city,
          country: record.country,
          loc: record.loc,
        });
        return origin;
      } finally {
        this.originInFlight = null;
      }
    })();

    return this.originInFlight;
  }

  /**
   * 执行 resolveIpRecord。
   * @param ip - 输入：`string` — ip 参数
   * @returns 输出：`Promise<null | HostPinRecord>` — 异步返回 null | HostPinRecord
   */

  async resolveIpRecord(ip: string): Promise<HostPinRecord | null> {
    if (!this.options.enabled) {
      return null;
    }

    const now = Date.now();
    const cached = this.ipCache.get(ip);
    let record: IpInfoRecord;
    if (cached && cached.expiresAt > now) {
      record = cached.record;
    } else {
      record = await this.options.ipInfo.lookupIp(ip);
      this.ipCache.set(ip, { record, expiresAt: now + this.options.cacheTtlMs });
    }
    return ipInfoToHostPinRecord(record);
  }

  /**
   * 执行 resolveHostname。
   * @param hostname - 输入：`string` — hostname 参数
   * @returns 输出：`Promise<null | HostPinRecord>` — 异步返回 null | HostPinRecord
   */

  async resolveHostname(hostname: string): Promise<HostPinRecord | null> {
    if (!this.options.enabled) {
      return null;
    }

    try {
      const result = await dnsLookup(hostname, { verbatim: true });
      return this.resolveIpRecord(result.address);
    } catch (err) {
      FetchRouteResolver.logger.warn("DNS 解析失败", {
        hostname,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * 执行 clearCache。
   * @returns 输出：无（`void`）
   */

  clearCache(): void {
    this.originCache = null;
    this.ipCache.clear();
  }
}

/**
 * 执行 ipInfoToOrigin。
 * @param record - 输入：`IpInfoRecord` — record 参数
 * @returns 输出：`FetchRouteOrigin` — FetchRouteOrigin 实例
 * @throws {Error} 条件不满足或 I/O 失败时
 */
export function ipInfoToOrigin(record: IpInfoRecord): FetchRouteOrigin {
  const coords = parseLocString(record.loc);
  if (!coords) {
    throw new Error(`ipinfo: invalid loc for origin IP ${record.ip}`);
  }
  return {
    lat: coords.lat,
    lng: coords.lng,
    city: record.city,
    region: record.region,
    country: record.country,
    label: record.city ?? record.ip,
  };
}

/**
 * 执行 ipInfoToHostPinRecord。
 * @param record - 输入：`IpInfoRecord` — record 参数
 * @returns 输出：`null | HostPinRecord` — null | HostPinRecord 实例
 */
export function ipInfoToHostPinRecord(record: IpInfoRecord): HostPinRecord | null {
  if (!parseLocString(record.loc)) {
    return null;
  }
  return {
    ip: record.ip,
    family: record.ip.includes(":") ? "ipv6" : "ipv4",
    city: record.city,
    region: record.region,
    country: record.country,
    loc: record.loc,
    org: record.org,
    timezone: record.timezone,
  };
}

/**
 * 创建 FetchRouteResolverFromConfig。
 * @returns 输出：`undefined | FetchRouteResolver` — undefined | FetchRouteResolver 实例
 */
export function createFetchRouteResolverFromConfig(): FetchRouteResolver | undefined {
  const cfg = GeoClawConfig.get();
  const opts = cfg.getIpInfoOptions();
  if (!opts?.enabled || !opts.token) {
    return undefined;
  }

  return new FetchRouteResolver({
    enabled: true,
    cacheTtlMs: opts.cacheTtlMs,
    originViaProxy: opts.originViaProxy,
    ipInfo: new IpInfoClient({
      token: opts.token,
      baseUrl: opts.baseUrl,
      timeoutMs: opts.timeoutMs,
    }),
  });
}
