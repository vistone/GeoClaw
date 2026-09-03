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
   * 绑定 ipinfo 客户端与缓存 TTL 初始化。
   * @param options - 输入：`FetchRouteResolverOptions` — enabled、cacheTtlMs、ipInfo
   */
  constructor(options: FetchRouteResolverOptions) {
    this.options = options;
  }

  /**
   * 解析当前出口 IP 为飞行路线原点坐标。
   * @param proxyUrl - 输入：`undefined | string` — 可选代理；originViaProxy 时经此查询
   * @returns 输出：`Promise<null | FetchRouteOrigin>` — 禁用或失败为 null，否则含 lat/lng
   */
  async resolveOrigin(proxyUrl?: string): Promise<FetchRouteOrigin | null> {
    return FetchRouteResolver.logger.measureAsync(
      "resolveOrigin",
      async () => {
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
      },
      { proxyUrl: proxyUrl ?? null },
    );
  }

  /**
   * 按 IP 查询并转为 HostPin 记录。
   * @param ip - 输入：`string` — 目标 IP 地址
   * @returns 输出：`Promise<null | HostPinRecord>` — 禁用或 loc 无效为 null
   */
  async resolveIpRecord(ip: string): Promise<HostPinRecord | null> {
    return FetchRouteResolver.logger.measureAsync(
      "resolveIpRecord",
      async () => {
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
      },
      { ip },
    );
  }

  /**
   * 系统 DNS 解析主机名后再查地理信息。
   * @param hostname - 输入：`string` — 待解析的主机名
   * @returns 输出：`Promise<null | HostPinRecord>` — DNS/ipinfo 失败或禁用为 null
   */
  async resolveHostname(hostname: string): Promise<HostPinRecord | null> {
    return FetchRouteResolver.logger.measureAsync(
      "resolveHostname",
      async () => {
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
      },
      { hostname },
    );
  }

  /**
   * 清空 origin 与 IP 地理缓存。
   * @returns 输出：无（`void`）
   */
  clearCache(): void {
    this.originCache = null;
    this.ipCache.clear();
  }
}

/**
 * 将 ipinfo 记录转为飞行路线原点。
 * @param record - 输入：`IpInfoRecord` — 含 loc 的出口 IP 记录
 * @returns 输出：`FetchRouteOrigin` — lat/lng 与城市标签
 * @throws {Error} loc 缺失或无法解析时
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
 * 将 ipinfo 记录转为 HostPin 记录。
 * @param record - 输入：`IpInfoRecord` — 含 loc 的 IP 地理记录
 * @returns 输出：`null | HostPinRecord` — loc 无效为 null，否则含 family
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
 * 从 geoclaw.yaml 的 ipinfo 段创建路线解析器。
 * @returns 输出：`undefined | FetchRouteResolver` — 未启用或无 token 时为 undefined
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
