import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import type { BrowserEmulationOptions, BrowserPlatform, BrowserProfile } from "node-wreq";

import { setGlobalLogLevel, LogLevel, logLevelFromString } from "./LogConfig.js";
import type { HostPinPoolOptions } from "../fetch/HostPinPool.js";
import { loadHostPinRecordsFromYaml } from "../fetch/HostPinPool.js";
import type { HotConnectionPoolOptions } from "../fetch/HotConnectionPool.js";
import type { FetchRouteOptions } from "../fetch/FetchFlightPath.js";
import type { FetchMetricsOptions } from "../fetch/FetchMetrics.js";
import type { ProxyMode } from "../fetch/FetchTypes.js";

/** config/geoclaw.yaml 文件结构 */
export type GeoClawConfigFile = {
  log: { level: string };
  rocktree: { baseUrl: string };
  fetch: {
    contextHeaders: Record<string, string>;
    forceIdentityEncoding: boolean;
    logTransportTrace: boolean;
    timeoutMs: number | null;
  };
  tls: {
    profile: string;
    platform: string;
    http2: boolean;
    profileHeaders: boolean;
  };
  proxy: {
    enabled: boolean;
    url: string;
    mode: ProxyMode;
  /** 可选；已废弃用于航线可视化，勿再配置 */
    geo?: {
      lat: number;
      lng: number;
      city?: string;
      country?: string;
      label?: string;
    } | null;
  };
  hostPin: {
    enabled: boolean;
    hostname: string;
    ipsFile: string;
    configDir: string;
    family: "all" | "ipv4" | "ipv6";
  };
  benchmark: {
    concurrency: number;
    timeoutMs: number;
    outDir: string;
    planetoidPath: string;
  };
  warmPool: {
    enabled: boolean;
    ipsFile: string | null;
    warmupPath: string | null;
    poolIdleTimeout: number | false | null;
    poolMaxIdlePerHost: number;
    deniedStatuses: number[];
    coldPoolStatuses: number[] | null;
    successStatus: number;
    autoStartWarmup: boolean;
    initialConcurrency: number;
    reheatConcurrency: number;
    reheatIntervalMs: number;
    reheatBackoffMs: number;
    deniedBackoffMs: number;
    fallbackToHostPin: boolean;
    taskConcurrency: number;
    maxTaskAttempts: number | null;
  /** 估计服务端空闲超时；选路优先快过期 + 末段保活；省略默认 60000；0 关闭 */
    idleExpireMs?: number;
  /** @deprecated 请用 idleExpireMs；若仍配置则作为 idleExpireMs 回退 */
    keepAliveIdleMs?: number;
  /** 每轮保活最大并发；省略默认 20 */
    keepAliveConcurrency?: number;
  };
  fetchMetrics: {
    enabled: boolean;
    logEachAttempt: boolean;
    summaryIntervalMs: number;
    maxRecentAttempts: number;
    maxRecentRequests: number;
    maxRecentFlightPaths: number;
  /** 按域名分文件的 IP 统计目录（如 config/ip-stats） */
    ipStatsDir?: string | null;
  /** @deprecated 已改为 ipStatsDir */
    ipStatsFile?: string | null;
    ipStatsFlushIntervalMs?: number;
    ipStatsSeedFromHostPin?: boolean;
  };
  fetchRoute: {
    originMode: "ipinfo" | "manual";
    origin: {
      lat: number;
      lng: number;
      city?: string;
      region?: string;
      country?: string;
      label?: string;
    } | null;
    includeProxyHop?: boolean;
    ipinfoForSystemDns: boolean;
  };
  ipinfo: {
    enabled: boolean;
    token: string | null;
    baseUrl: string;
    cacheTtlMs: number;
    timeoutMs: number;
    originViaProxy: boolean;
  };
  flightMap: {
    host: string;
    port: number;
  /** @deprecated 使用 tileUrl / tileProvider */
    mapStyleUrl: string;
    tileUrl: string;
  /** 底图：bing | custom（custom 时用 tileUrl） */
    tileProvider: "bing" | "custom";
  /** Bing 样式：Road | Aerial | AerialWithLabels */
    bingImagerySet: "Road" | "Aerial" | "AerialWithLabels";
  /** 可选；有 key 时走官方 Metadata API */
    bingMapsKey: string | null;
    geojsonIoUrl: string;
    pollIntervalMs: number;
    demoFetchOnStart: boolean;
    demoFetchUrl: string | null;
  /** 地球半径 (km)，用于 LEO 轨道弧计算 */
    earthRadiusKm: number;
  /** LEO 轨道高度下限 (km) */
    leoAltitudeMinKm: number;
  /** LEO 轨道高度上限 (km) */
    leoAltitudeMaxKm: number;
  /**
     * 平面地图显示夸张系数。
     * 真实 LEO 相对地表的几何仰角很小，需放大才有卫星轨道空间感。
   */
    orbitDisplayExaggeration: number;
    routeDrawMs?: number;
    routeHoldMs?: number;
    routeFadeMs?: number;
  /** 高并发压测：并发数 */
    stressConcurrency?: number;
  /** 高并发压测：总请求数；null=按热池 IP 数 */
    stressTotal?: number | null;
  /** 启动后热池就绪自动跑一轮压测 */
    stressOnStart?: boolean;
  };
};

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(MODULE_DIR, "..", "..");
const DEFAULT_CONFIG_REL = "config/geoclaw.yaml";

/**
 * 从外部 YAML 加载 GeoClaw 运行时配置（单例）。
 */
export class GeoClawConfig {
  private static instance: GeoClawConfig | null = null;
  private readonly file: GeoClawConfigFile;
  private readonly configPath: string;

  private constructor(configPath: string, file: GeoClawConfigFile) {
    this.configPath = configPath;
    this.file = file;
  }

  /**
   * 执行 load。
   * @param configPath - 输入：`undefined | string` — configPath 参数
   * @returns 输出：`GeoClawConfig` — GeoClawConfig 实例
   */

  static load(configPath?: string): GeoClawConfig {
    if (GeoClawConfig.instance) {
      return GeoClawConfig.instance;
    }
    const resolved = GeoClawConfig.resolveConfigPath(configPath);
    const raw = readFileSync(resolved, "utf8");
    const parsed = parseYaml(raw) as GeoClawConfigFile;
    GeoClawConfig.validate(parsed);
    setGlobalLogLevel(logLevelFromString(parsed.log.level));
    GeoClawConfig.instance = new GeoClawConfig(resolved, parsed);
    return GeoClawConfig.instance;
  }

  /**
   * 获取。
   * @returns 输出：`GeoClawConfig` — GeoClawConfig 实例
   */

  static get(): GeoClawConfig {
    return GeoClawConfig.instance ?? GeoClawConfig.load();
  }

  /**
   * 执行 reset。
   * @returns 输出：无（`void`）
   */

  static reset(): void {
    GeoClawConfig.instance = null;
  }

  /**
   * 获取 ConfigPath。
   * @returns 输出：`string` — 字符串结果
   */

  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * 获取 Raw。
   * @returns 输出：`Readonly<GeoClawConfigFile>` — Readonly<GeoClawConfigFile> 实例
   */

  getRaw(): Readonly<GeoClawConfigFile> {
    return this.file;
  }

  /**
   * 获取 LogLevel。
   * @returns 输出：`DEBUG | INFO | WARN | …` — DEBUG | INFO | WARN | … 实例
   */

  getLogLevel(): LogLevel {
    return logLevelFromString(this.file.log.level);
  }

  /**
   * 获取 RocktreeBaseUrl。
   * @returns 输出：`string` — 字符串结果
   */

  getRocktreeBaseUrl(): string {
    return this.file.rocktree.baseUrl;
  }

  /**
   * 获取 PlanetoidMetadataUrl。
   * @returns 输出：`string` — 字符串结果
   */

  getPlanetoidMetadataUrl(): string {
    return joinUrl(this.file.rocktree.baseUrl, this.file.benchmark.planetoidPath);
  }

  /**
   * 获取 ContextHeaders。
   * @returns 输出：`Record<string, string>` — Record<string, string> 实例
   */

  getContextHeaders(): Record<string, string> {
    return { ...this.file.fetch.contextHeaders };
  }

  /**
   * 获取 ForceIdentityEncoding。
   * @returns 输出：`boolean` — 布尔结果
   */

  getForceIdentityEncoding(): boolean {
    return this.file.fetch.forceIdentityEncoding;
  }

  /**
   * 获取 LogTransportTrace。
   * @returns 输出：`boolean` — 布尔结果
   */

  getLogTransportTrace(): boolean {
    return this.file.fetch.logTransportTrace;
  }

  /**
   * 获取 FetchTimeoutMs。
   * @returns 输出：`undefined | number` — undefined | number 实例
   */

  getFetchTimeoutMs(): number | undefined {
    const v = this.file.fetch.timeoutMs;
    return v === null || v === undefined ? undefined : v;
  }

  /**
   * 获取 TlsFingerprint。
   * @returns 输出：`BrowserEmulationOptions` — BrowserEmulationOptions 实例
   */

  getTlsFingerprint(): BrowserEmulationOptions {
    return {
      profile: this.file.tls.profile as BrowserProfile,
      platform: this.file.tls.platform as BrowserPlatform,
      http2: this.file.tls.http2,
      headers: this.file.tls.profileHeaders,
    };
  }

  /**
   * 获取 ProxyUrl。
   * @returns 输出：`undefined | string` — undefined | string 实例
   */

  getProxyUrl(): string | undefined {
    return this.file.proxy.enabled ? this.file.proxy.url : undefined;
  }

  /**
   * 获取 ProxyMode。
   * @returns 输出：`"auto" | "always" | "never"` — "auto" | "always" | "never" 实例
   */

  getProxyMode(): ProxyMode {
    return this.file.proxy.mode;
  }

  /**
   * 获取 HostPinPoolOptions。
   * @returns 输出：`null | HostPinPoolOptions` — null | HostPinPoolOptions 实例
   */

  getHostPinPoolOptions(): HostPinPoolOptions | null {
    if (!this.file.hostPin.enabled) {
      return null;
    }
    return {
      hostname: this.file.hostPin.hostname,
      yamlPath: GeoClawConfig.resolvePath(this.file.hostPin.ipsFile),
      family: this.file.hostPin.family,
    };
  }

  /**
   * 获取 HostPinConfigDir。
   * @returns 输出：`string` — 字符串结果
   */

  getHostPinConfigDir(): string {
    return this.file.hostPin?.configDir ?? "config";
  }

  /**
   * 获取 FetchRouteOptions。
   * @returns 输出：`FetchRouteOptions` — FetchRouteOptions 实例
   */

  getFetchRouteOptions(): FetchRouteOptions {
    const route = this.file.fetchRoute;
    const proxyGeo = this.file.proxy?.geo ?? null;
    const originMode = route?.originMode ?? "ipinfo";
    return {
      originMode,
      origin: originMode === "manual" ? (route?.origin ?? null) : null,
      includeProxyHop: route?.includeProxyHop ?? false,
      ipinfoForSystemDns: route?.ipinfoForSystemDns ?? true,
      proxyGeo: proxyGeo
        ? {
            lat: proxyGeo.lat,
            lng: proxyGeo.lng,
            city: proxyGeo.city,
            country: proxyGeo.country,
            label: proxyGeo.label,
          }
        : null,
    };
  }

  /**
   * 获取 IpInfoOptions。
   * @returns 输出：`null | object` — null | object 实例
   */

  getIpInfoOptions(): {
    enabled: boolean;
    token: string | null;
    baseUrl: string;
    cacheTtlMs: number;
    timeoutMs: number;
    originViaProxy: boolean;
  } | null {
    const info = this.file.ipinfo;
    if (!info) {
      return null;
    }
    const token = process.env.IPINFO_TOKEN ?? info.token ?? null;
    return {
      enabled: info.enabled,
      token,
      baseUrl: info.baseUrl ?? "https://ipinfo.io",
      cacheTtlMs: info.cacheTtlMs ?? 3_600_000,
      timeoutMs: info.timeoutMs ?? 5000,
      originViaProxy: info.originViaProxy ?? false,
    };
  }

  /**
   * 获取 FlightMapConfig。
   * @returns 输出：`object` — object 实例
   */

  getFlightMapConfig(): GeoClawConfigFile["flightMap"] {
    const m = this.file.flightMap;
    const planetoid = joinUrl(this.file.rocktree.baseUrl, this.file.benchmark.planetoidPath);
    const defaultTile = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
    const bingKey = process.env.BING_MAPS_KEY?.trim() || m?.bingMapsKey || null;
    return {
      host: m?.host ?? "127.0.0.1",
      port: m?.port ?? 8765,
      mapStyleUrl: m?.mapStyleUrl ?? "https://demotiles.maplibre.org/style.json",
      tileUrl: m?.tileUrl ?? defaultTile,
      tileProvider: m?.tileProvider ?? "bing",
      bingImagerySet: m?.bingImagerySet ?? "Road",
      bingMapsKey: bingKey,
      geojsonIoUrl: m?.geojsonIoUrl ?? "https://geojson.io",
      pollIntervalMs: m?.pollIntervalMs ?? 3000,
      demoFetchOnStart: m?.demoFetchOnStart ?? true,
      demoFetchUrl: m?.demoFetchUrl ?? planetoid,
      earthRadiusKm: m?.earthRadiusKm ?? 6371,
      leoAltitudeMinKm: m?.leoAltitudeMinKm ?? 12,
      leoAltitudeMaxKm: m?.leoAltitudeMaxKm ?? 48,
      orbitDisplayExaggeration: m?.orbitDisplayExaggeration ?? 2.5,
      routeDrawMs: m?.routeDrawMs ?? 1400,
      routeHoldMs: m?.routeHoldMs ?? 500,
      routeFadeMs: m?.routeFadeMs ?? 2800,
      stressConcurrency: m?.stressConcurrency ?? 40,
      stressTotal: m?.stressTotal ?? null,
      stressOnStart: m?.stressOnStart ?? false,
    };
  }

  /**
   * 获取 BenchmarkConfig。
   * @returns 输出：`object` — object 实例
   */

  getBenchmarkConfig(): GeoClawConfigFile["benchmark"] {
    return { ...this.file.benchmark };
  }

  /**
   * 获取 WarmPoolOptions。
   * @returns 输出：`null | HotConnectionPoolOptions` — null | HotConnectionPoolOptions 实例
   */

  getWarmPoolOptions(): HotConnectionPoolOptions | null {
    const warm = this.file.warmPool;
    if (!warm?.enabled) {
      return null;
    }

    const hostPin = this.file.hostPin;
    const ipsFile = warm.ipsFile ?? hostPin.ipsFile;
    const yamlPath = GeoClawConfig.resolvePath(ipsFile);
    const ips = loadHostPinRecordsFromYaml(yamlPath, hostPin.family);

    const warmupPath = warm.warmupPath ?? this.file.benchmark.planetoidPath;
    const warmupUrl = joinUrl(this.file.rocktree.baseUrl, warmupPath);

    const headers: Record<string, string> = {
      ...this.file.fetch.contextHeaders,
      ...(this.file.fetch.forceIdentityEncoding ? { "Accept-Encoding": "identity" } : {}),
    };

    return {
      hostname: hostPin.hostname,
      ips,
      warmupUrl,
      headers,
      browser: this.getTlsFingerprint(),
      proxyUrl: this.getProxyUrl(),
      proxyMode: this.getProxyMode(),
      timeoutMs: this.getFetchTimeoutMs() ?? this.file.benchmark.timeoutMs,
      poolIdleTimeout: warm.poolIdleTimeout === null ? false : warm.poolIdleTimeout,
      poolMaxIdlePerHost: warm.poolMaxIdlePerHost,
      deniedStatuses: warm.deniedStatuses,
      successStatus: warm.successStatus,
      initialConcurrency: warm.initialConcurrency,
      reheatConcurrency: warm.reheatConcurrency,
      reheatIntervalMs: warm.reheatIntervalMs,
      reheatBackoffMs: warm.reheatBackoffMs,
      deniedBackoffMs: warm.deniedBackoffMs,
      coldPoolStatuses: warm.coldPoolStatuses ?? warm.deniedStatuses,
      autoStartWarmup: warm.autoStartWarmup,
      idleExpireMs: warm.idleExpireMs ?? warm.keepAliveIdleMs ?? 60_000,
      keepAliveConcurrency: warm.keepAliveConcurrency ?? 20,
    };
  }

  /**
   * 获取 WarmPoolFallbackToHostPin。
   * @returns 输出：`boolean` — 布尔结果
   */

  getWarmPoolFallbackToHostPin(): boolean {
    return this.file.warmPool?.fallbackToHostPin ?? false;
  }

  /**
   * 获取 FetchTaskPoolOptions。
   * @returns 输出：`object` — object 实例
   */

  getFetchTaskPoolOptions(): { concurrency: number; maxAttempts: number | null } {
    const warm = this.file.warmPool;
    return {
      concurrency: warm?.taskConcurrency ?? 50,
      maxAttempts: warm?.maxTaskAttempts ?? null,
    };
  }

  /**
   * 获取 WarmPoolSuccessStatus。
   * @returns 输出：`number` — 数值结果
   */

  getWarmPoolSuccessStatus(): number {
    return this.file.warmPool?.successStatus ?? 200;
  }

  /**
   * 获取 FetchMetricsOptions。
   * @returns 输出：`FetchMetricsOptions` — FetchMetricsOptions 实例
   */

  getFetchMetricsOptions(): FetchMetricsOptions {
    const m = this.file.fetchMetrics;
    return {
      enabled: m?.enabled ?? true,
      logEachAttempt: m?.logEachAttempt ?? false,
      summaryIntervalMs: m?.summaryIntervalMs ?? 30_000,
      maxRecentAttempts: m?.maxRecentAttempts ?? 1000,
      maxRecentRequests: m?.maxRecentRequests ?? 500,
      maxRecentFlightPaths: m?.maxRecentFlightPaths ?? 500,
      ipStatsDir: m?.ipStatsDir ?? "config/ip-stats",
      ipStatsFlushIntervalMs: m?.ipStatsFlushIntervalMs ?? 5_000,
      ipStatsSeedFromHostPin: m?.ipStatsSeedFromHostPin ?? true,
    };
  }

  /**
   * 执行 resolvePath。
   * @param relOrAbs - 输入：`string` — relOrAbs 参数
   * @returns 输出：`string` — 字符串结果
   */

  static resolvePath(relOrAbs: string): string {
    return isAbsolute(relOrAbs) ? relOrAbs : join(PACKAGE_ROOT, relOrAbs);
  }

  /**
   * 执行 resolveConfigPath。
   * @param configPath - 输入：`undefined | string` — configPath 参数
   * @returns 输出：`string` — 字符串结果
   * @throws {Error} 条件不满足或 I/O 失败时
   */

  static resolveConfigPath(configPath?: string): string {
    const fromEnv = process.env.GEOCLAW_CONFIG;
    const rel = configPath ?? fromEnv ?? DEFAULT_CONFIG_REL;
    const abs = isAbsolute(rel) ? rel : join(PACKAGE_ROOT, rel);
    if (!existsSync(abs)) {
      throw new Error(`GeoClaw config not found: ${abs}`);
    }
    return abs;
  }

  private static validate(file: GeoClawConfigFile): void {
    if (!file?.rocktree?.baseUrl) {
      throw new Error("geoclaw.yaml: rocktree.baseUrl is required");
    }
    if (!file?.hostPin?.hostname) {
      throw new Error("geoclaw.yaml: hostPin.hostname is required");
    }
    if (!file?.tls?.profile) {
      throw new Error("geoclaw.yaml: tls.profile is required");
    }
  }
}

/**
 * 已加载的全局配置（懒加载 config/geoclaw.yaml）。
 */
export const geoclawConfig = {
  get value(): GeoClawConfig {
    return GeoClawConfig.get();
  },
};

/**
 * 拼接 Url。
 * @param base - 输入：`string` — 基础 URL
 * @param pathSegment - 输入：`string` — pathSegment 参数
 * @returns 输出：`string` — 字符串结果
 */
function joinUrl(base: string, pathSegment: string): string {
  return `${base.replace(/\/+$/, "")}/${pathSegment.replace(/^\/+/, "")}`;
}
