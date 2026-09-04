import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import type { BrowserEmulationOptions, BrowserPlatform, BrowserProfile } from "node-wreq";

import { setGlobalLogLevel, LogLevel, logLevelFromString } from "./LogConfig.js";
import { loadDotEnv } from "./loadDotEnv.js";
import type { HostPinPoolOptions } from "../fetch/HostPinPool.js";
import { loadHostPinRecordsFromYaml } from "../fetch/HostPinPool.js";
import type { HotConnectionPoolOptions } from "../fetch/HotConnectionPool.js";
import type { FetchRouteOptions } from "../fetch/FetchFlightPath.js";
import type { FetchMetricsOptions } from "../fetch/FetchMetrics.js";
import type { FetchExportOptions } from "../fetch/FetchExportSink.js";
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
    /** 统一并发：预热 / 重热 / 保活 / 任务池共用；可被下列细分项覆盖 */
    concurrency?: number;
    initialConcurrency?: number;
    reheatConcurrency?: number;
    reheatIntervalMs?: number;
    /** 统一失败退避；可被 reheatBackoffMs / deniedBackoffMs 覆盖 */
    backoffMs?: number;
    reheatBackoffMs?: number;
    deniedBackoffMs?: number;
    fallbackToHostPin?: boolean;
    taskConcurrency?: number;
    maxTaskAttempts?: number | null;
    idleExpireMs?: number;
    keepAliveIdleMs?: number;
    keepAliveConcurrency?: number;
  };
  fetchMetrics?: {
    enabled: boolean;
    logEachAttempt: boolean;
    summaryIntervalMs: number;
    maxRecentAttempts: number;
    maxRecentRequests: number;
    maxRecentFlightPaths: number;
    ipStatsDir?: string | null;
    ipStatsFile?: string | null;
    ipStatsFlushIntervalMs?: number;
    ipStatsSeedFromHostPin?: boolean;
  };
  /** 出站：进站响应原样 PUT（与进站 fetch 分离） */
  fetchExport?: {
    enabled?: boolean;
    method?: "PUT";
    url?: string | null;
    headers?: Record<string, string>;
    timeoutMs?: number | null;
    proxyMode?: ProxyMode;
    failOpen?: boolean;
  };
  fetchRoute?: {
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
    ipinfoForSystemDns?: boolean;
  };
  ipinfo?: {
    enabled: boolean;
    token: string | null;
    baseUrl?: string;
    cacheTtlMs?: number;
    timeoutMs?: number;
    originViaProxy?: boolean;
  };
  flightMap?: {
    host?: string;
    port?: number;
    mapStyleUrl?: string;
    tileUrl?: string;
    tileProvider?: "bing" | "custom";
    bingImagerySet?: "Road" | "Aerial" | "AerialWithLabels";
    bingMapsKey?: string | null;
    geojsonIoUrl?: string;
    pollIntervalMs?: number;
    demoFetchOnStart?: boolean;
    demoFetchUrl?: string | null;
    earthRadiusKm?: number;
    leoAltitudeMinKm?: number;
    leoAltitudeMaxKm?: number;
    orbitDisplayExaggeration?: number;
    routeDrawMs?: number;
    routeHoldMs?: number;
    routeFadeMs?: number;
    /** 网卡名；null/空=默认路由网卡 */
    nicIface?: string | null;
    /** 网卡流量采样间隔（毫秒） */
    nicSampleMs?: number;
    /** 脉冲 WS 连续冲刷间隔（毫秒） */
    pulseStreamMs?: number;
    /** 单客户端 WS 发送缓冲上限（字节）；超限丢弃本帧脉冲 */
    wsMaxBufferedBytes?: number;
  };
  /** 测试工具：热路径压测（stress:hot → flight:map /api/stress；主页无 UI） */
  stressTest?: {
    concurrency?: number;
    total?: number;
    url?: string | null;
    waitHot?: boolean;
    waitHotMs?: number;
    /** 压测单次请求超时（毫秒）；只释放并发槽，不把慢 IP 排除出选路 */
    requestTimeoutMs?: number;
  };
};

/** ipinfo 运行时选项（由 YAML + 可选环境变量组成） */
export type IpInfoRuntimeOptions = {
  enabled: boolean;
  token: string | null;
  baseUrl: string;
  cacheTtlMs: number;
  timeoutMs: number;
  originViaProxy: boolean;
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
   * 加载 YAML 配置为进程内单例（已加载则直接返回）。
   * @param configPath - 输入：`undefined | string` — 可选配置文件路径，缺省读 GEOCLAW_CONFIG 或默认路径
   * @returns 输出：`GeoClawConfig` — 已加载的配置单例
   */
  static load(configPath?: string): GeoClawConfig {
    if (GeoClawConfig.instance) {
      return GeoClawConfig.instance;
    }
    loadDotEnv(PACKAGE_ROOT);
    const resolved = GeoClawConfig.resolveConfigPath(configPath);
    const raw = readFileSync(resolved, "utf8");
    const parsed = parseYaml(raw) as GeoClawConfigFile;
    GeoClawConfig.validate(parsed);
    setGlobalLogLevel(logLevelFromString(parsed.log.level));
    GeoClawConfig.instance = new GeoClawConfig(resolved, parsed);
    return GeoClawConfig.instance;
  }

  /**
   * 取得配置单例；尚未加载时自动 load。
   * @returns 输出：`GeoClawConfig` — 当前配置单例
   */
  static get(): GeoClawConfig {
    return GeoClawConfig.instance ?? GeoClawConfig.load();
  }

  /**
   * 清除配置单例（仅测试用）。
   * @returns 输出：无（`void`）
   */
  static reset(): void {
    GeoClawConfig.instance = null;
  }

  /**
   * 返回本次加载的配置文件绝对路径。
   * @returns 输出：`string` — 配置文件绝对路径
   */
  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * 返回只读原始 YAML 结构。
   * @returns 输出：`Readonly<GeoClawConfigFile>` — 解析后的配置对象
   */
  getRaw(): Readonly<GeoClawConfigFile> {
    return this.file;
  }

  /**
   * 返回全局日志级别。
   * @returns 输出：`LogLevel` — 由 log.level 解析的枚举
   */
  getLogLevel(): LogLevel {
    return logLevelFromString(this.file.log.level);
  }

  /**
   * 返回 Rocktree API 根 URL。
   * @returns 输出：`string` — rocktree.baseUrl
   */
  getRocktreeBaseUrl(): string {
    return this.file.rocktree.baseUrl;
  }

  /**
   * 拼接 PlanetoidMetadata 完整 URL。
   * @returns 输出：`string` — baseUrl + benchmark.planetoidPath
   */
  getPlanetoidMetadataUrl(): string {
    return joinUrl(this.file.rocktree.baseUrl, this.file.benchmark.planetoidPath);
  }

  /**
   * 返回 fetch 上下文请求头副本。
   * @returns 输出：`Record<string, string>` — Origin、Referer 一类上下文头
   */
  getContextHeaders(): Record<string, string> {
    return { ...this.file.fetch.contextHeaders };
  }

  /**
   * 是否强制 Accept-Encoding: identity。
   * @returns 输出：`boolean` — fetch.forceIdentityEncoding
   */
  getForceIdentityEncoding(): boolean {
    return this.file.fetch.forceIdentityEncoding;
  }

  /**
   * 是否打印传输 trace。
   * @returns 输出：`boolean` — fetch.logTransportTrace
   */
  getLogTransportTrace(): boolean {
    return this.file.fetch.logTransportTrace;
  }

  /**
   * 返回业务/热池请求超时；YAML 为 null 表示不限制。
   * @returns 输出：`undefined | number` — 超时毫秒，未配置为 undefined
   */
  getFetchTimeoutMs(): number | undefined {
    const v = this.file.fetch.timeoutMs;
    return v === null || v === undefined ? undefined : v;
  }

  /**
   * 返回 node-wreq TLS 浏览器指纹选项。
   * @returns 输出：`BrowserEmulationOptions` — profile/platform/http2/headers
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
   * 返回代理 URL；proxy.enabled=false 时为 undefined。
   * @returns 输出：`undefined | string` — SOCKS/HTTP 代理 URL
   */
  getProxyUrl(): string | undefined {
    return this.file.proxy.enabled ? this.file.proxy.url : undefined;
  }

  /**
   * 返回代理模式。
   * @returns 输出：`ProxyMode` — auto / always / never
   */
  getProxyMode(): ProxyMode {
    return this.file.proxy.mode;
  }

  /**
   * 组装 HostPin 池选项；hostPin.enabled=false 时返回 null。
   * @returns 输出：`null | HostPinPoolOptions` — 池构造参数或 null
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
   * 返回 HostPin 域名 YAML 所在目录。
   * @returns 输出：`string` — hostPin.configDir
   */
  getHostPinConfigDir(): string {
    return this.file.hostPin?.configDir ?? "config";
  }

  /**
   * 组装飞行路线解析选项。
   * @returns 输出：`FetchRouteOptions` — origin/proxy/ipinfo 开关
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
   * 组装 ipinfo 客户端选项；YAML 缺 ipinfo 段时返回 null。
   * @returns 输出：`null | IpInfoRuntimeOptions` — 含环境变量覆盖后的 token
   */
  getIpInfoOptions(): IpInfoRuntimeOptions | null {
    const info = this.file.ipinfo;
    if (!info) {
      return null;
    }
    return {
      enabled: info.enabled,
      token: process.env.IPINFO_TOKEN ?? info.token ?? null,
      baseUrl: info.baseUrl ?? "https://ipinfo.io",
      cacheTtlMs: info.cacheTtlMs ?? 3_600_000,
      timeoutMs: info.timeoutMs ?? 5000,
      originViaProxy: info.originViaProxy ?? false,
    };
  }

  /**
   * 返回飞行地图服务配置；缺省字段用合理默认，避免 YAML 漏项就崩溃。
   * @returns 输出：`Required<GeoClawConfigFile["flightMap"]>` — 已补齐的 flightMap
   */
  getFlightMapConfig(): {
    host: string;
    port: number;
    mapStyleUrl: string;
    tileUrl: string;
    tileProvider: "bing" | "custom";
    bingImagerySet: "Road" | "Aerial" | "AerialWithLabels";
    bingMapsKey: string | null;
    geojsonIoUrl: string;
    pollIntervalMs: number;
    demoFetchOnStart: boolean;
    demoFetchUrl: string | null;
    earthRadiusKm: number;
    leoAltitudeMinKm: number;
    leoAltitudeMaxKm: number;
    orbitDisplayExaggeration: number;
    routeDrawMs: number;
    routeHoldMs: number;
    routeFadeMs: number;
    nicIface: string | null;
    nicSampleMs: number;
    pulseStreamMs: number;
    wsMaxBufferedBytes: number;
  } {
    const m = this.file.flightMap;
    const planetoid = joinUrl(this.file.rocktree.baseUrl, this.file.benchmark.planetoidPath);
    const bingKey = process.env.BING_MAPS_KEY?.trim() || m?.bingMapsKey || null;
    return {
      host: m?.host ?? "127.0.0.1",
      port: m?.port ?? 8765,
      mapStyleUrl: m?.mapStyleUrl ?? "https://demotiles.maplibre.org/style.json",
      tileUrl: m?.tileUrl ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
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
      routeHoldMs: m?.routeHoldMs ?? 16000,
      routeFadeMs: m?.routeFadeMs ?? 4000,
      nicIface: m?.nicIface?.trim() || null,
      nicSampleMs: m?.nicSampleMs ?? 1000,
      pulseStreamMs: m?.pulseStreamMs ?? 16,
      wsMaxBufferedBytes: m?.wsMaxBufferedBytes ?? 1_048_576,
    };
  }

  /**
   * 返回测试用热路径压测选项（stress:hot / flight-map `/api/stress`）。
   * @returns 输出：object — concurrency/total/url/waitHot/waitHotMs/requestTimeoutMs
   */
  getStressTestOptions(): {
    concurrency: number;
    total: number;
    url: string | null;
    waitHot: boolean;
    waitHotMs: number;
    requestTimeoutMs: number;
  } {
    const s = this.file.stressTest;
    return {
      concurrency: Math.max(1, s?.concurrency ?? 64),
      total: Math.max(1, s?.total ?? 10_000),
      url: s?.url ?? null,
      waitHot: s?.waitHot ?? true,
      waitHotMs: Math.max(1000, s?.waitHotMs ?? 120_000),
      requestTimeoutMs: Math.max(200, s?.requestTimeoutMs ?? 3_000),
    };
  }

  /**
   * 返回 benchmark 脚本配置副本。
   * @returns 输出：`GeoClawConfigFile["benchmark"]` — benchmark 段
   */
  getBenchmarkConfig(): GeoClawConfigFile["benchmark"] {
    return { ...this.file.benchmark };
  }

  /**
   * 组装热连接池选项；warmPool.enabled=false 时返回 null。
   * @returns 输出：`null | HotConnectionPoolOptions` — 预热/保活/选路参数
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

    const concurrency = Math.max(
      1,
      warm.concurrency ?? warm.initialConcurrency ?? warm.taskConcurrency ?? 200,
    );
    const backoffMs = warm.backoffMs ?? 0;

    return {
      hostname: hostPin.hostname,
      ips,
      warmupUrl,
      headers,
      browser: this.getTlsFingerprint(),
      proxyUrl: this.getProxyUrl(),
      proxyMode: this.getProxyMode(),
      timeoutMs: this.getFetchTimeoutMs() ?? this.file.benchmark.timeoutMs,
      poolIdleTimeout: warm.poolIdleTimeout === null ? false : (warm.poolIdleTimeout ?? false),
      poolMaxIdlePerHost: warm.poolMaxIdlePerHost ?? 1,
      deniedStatuses: warm.deniedStatuses ?? [403, 429],
      successStatus: warm.successStatus ?? 200,
      initialConcurrency: warm.initialConcurrency ?? concurrency,
      reheatConcurrency: warm.reheatConcurrency ?? concurrency,
      reheatIntervalMs: warm.reheatIntervalMs ?? 5000,
      reheatBackoffMs: warm.reheatBackoffMs ?? backoffMs,
      deniedBackoffMs: warm.deniedBackoffMs ?? backoffMs,
      coldPoolStatuses: warm.coldPoolStatuses ?? warm.deniedStatuses ?? [403, 429],
      autoStartWarmup: warm.autoStartWarmup ?? true,
      idleExpireMs: warm.idleExpireMs ?? warm.keepAliveIdleMs ?? 60_000,
      keepAliveConcurrency: warm.keepAliveConcurrency ?? concurrency,
    };
  }

  /**
   * 无热连接时是否回退 HostPin 冷路径。
   * @returns 输出：`boolean` — warmPool.fallbackToHostPin
   */
  getWarmPoolFallbackToHostPin(): boolean {
    return this.file.warmPool?.fallbackToHostPin ?? false;
  }

  /**
   * 返回业务下载任务池并发（与热池预热/重热/保活并发分离）。
   * @returns 输出：`{ concurrency: number; maxAttempts: number | null }` — 任务池参数
   */
  getFetchTaskPoolOptions(): { concurrency: number; maxAttempts: number | null } {
    const warm = this.file.warmPool;
    // 只用 taskConcurrency；不再回落到 warmPool.concurrency（那是热池运维专用）
    const concurrency = Math.max(1, warm?.taskConcurrency ?? 500);
    return {
      concurrency,
      maxAttempts: warm?.maxTaskAttempts ?? null,
    };
  }

  /**
   * 返回热池判定成功的 HTTP 状态码。
   * @returns 输出：`number` — warmPool.successStatus
   */
  getWarmPoolSuccessStatus(): number {
    return this.file.warmPool?.successStatus ?? 200;
  }

  /**
   * 返回 FetchMetrics 选项。
   * @returns 输出：`FetchMetricsOptions` — 指标与 IP 统计落盘选项
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
   * 返回出站 PUT 存档选项（与进站 fetch 分离）。
   * @returns 输出：`FetchExportOptions` — enabled/url/headers/proxyMode/failOpen
   */
  getFetchExportOptions(): FetchExportOptions {
    const e = this.file.fetchExport;
    const method = e?.method ?? "PUT";
    if (method !== "PUT") {
      throw new Error(`fetchExport.method 仅支持 PUT，收到: ${String(method)}`);
    }
    return {
      enabled: e?.enabled ?? false,
      method: "PUT",
      url: e?.url ?? null,
      headers: { ...(e?.headers ?? { "Content-Type": "application/octet-stream" }) },
      timeoutMs: e?.timeoutMs === undefined ? 30_000 : e.timeoutMs,
      proxyMode: e?.proxyMode ?? "never",
      failOpen: e?.failOpen ?? true,
    };
  }

  /**
   * 将相对路径解析为相对项目根的绝对路径。
   * @param relOrAbs - 输入：`string` — 相对或绝对路径
   * @returns 输出：`string` — 绝对路径
   */
  static resolvePath(relOrAbs: string): string {
    return isAbsolute(relOrAbs) ? relOrAbs : join(PACKAGE_ROOT, relOrAbs);
  }

  /**
   * 解析配置文件路径并确认文件存在。
   * @param configPath - 输入：`undefined | string` — 显式路径，否则环境变量或默认 YAML
   * @returns 输出：`string` — 存在的配置文件绝对路径
   * @throws {Error} 文件不存在时
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
 * 拼接 base URL 与路径段。
 * @param base - 输入：`string` — 根 URL
 * @param pathSegment - 输入：`string` — 相对路径段
 * @returns 输出：`string` — 无重复斜杠的完整 URL
 */
function joinUrl(base: string, pathSegment: string): string {
  return `${base.replace(/\/+$/, "")}/${pathSegment.replace(/^\/+/, "")}`;
}
