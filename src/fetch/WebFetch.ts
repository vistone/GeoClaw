import { fetch as wreqFetch, type RequestStats, type RequestTimings } from "node-wreq";

import { GeoClawConfig } from "../core/GeoClawConfig.js";
import { Logger } from "../core/Logger.js";
import type { ProxyMode } from "./FetchTypes.js";
import { resolveProxyUrl } from "./FetchTypes.js";
import { createHostPinPoolFromConfig, HostPinPool } from "./HostPinPool.js";
import {
  createHostPinRegistryFromConfig,
  HostPinRegistry,
  type HostPinRegistryResolve,
} from "./HostPinRegistry.js";
import {
  buildFetchFlightPath,
  type FetchFlightPath,
  type FetchRouteOptions,
} from "./FetchFlightPath.js";
import {
  createHotConnectionPoolFromConfig,
  HotConnectionPool,
} from "./HotConnectionPool.js";
import { FetchTaskPool } from "./FetchTaskPool.js";
import type { FetchMetrics } from "./FetchMetrics.js";
import { createFetchMetricsFromConfig, buildIpGeoRegistryFromConfig } from "./createFetchMetricsFromConfig.js";
import {
  createFetchExportSinkFromConfig,
  FetchExportSink,
} from "./FetchExportSink.js";
import {
  createFetchRouteResolverFromConfig,
  FetchRouteResolver,
} from "./FetchRouteResolver.js";
import { parseLocString } from "./FetchFlightPath.js";
import type { IpGeoRegistry } from "./IpGeoRegistry.js";
import type { HostPinRecord } from "./HostPinPool.js";
import {
  TlsFingerprintCodec,
  type TlsFingerprintConfig,
  type TlsRequestConfig,
} from "./TlsFingerprintCodec.js";

export type { ProxyMode } from "./FetchTypes.js";
export { resolveProxyUrl } from "./FetchTypes.js";

/** node-wreq fetch（TLS/JA3/HTTP2 浏览器指纹） */
export type TlsFetchFn = typeof wreqFetch;

/** 单次 GET 的传输层追踪信息 */
export type FetchTransportTrace = {
  /** 请求 URL */
  url: string;
  /** 实际使用的传输实现 */
  transport: "node-wreq" | "custom";
  /** 传给 node-wreq 的 browser profile（控制 TLS ClientHello + HTTP/2 SETTINGS） */
  browser: TlsFingerprintConfig;
  /** profile 是否启用 HTTP/2 指纹（ALPN 协商 h2） */
  http2FingerprintEnabled: boolean;
  /** profile 是否注入浏览器默认头及顺序 */
  profileHeadersEnabled: boolean;
  /** GeoClaw 层显式附加的请求头（不含 node-wreq profile 默认头） */
  extraHeaders: Record<string, string>;
  /** HTTP 状态码 */
  status: number;
  /** HTTP 原因短语 */
  statusText: string;
  /** 响应头（键名为 node-wreq 规范化后的小写） */
  responseHeaders: Record<string, string>;
  /** 响应体字节数 */
  bodyBytes: number;
  /** node-wreq 计时（wait = 首字节时间） */
  timings?: RequestTimings;
  /** TLS 对端证书是否可读（需 tlsDebug.peerCertificates） */
  tlsPeer?: {
    hasCertificate: boolean;
    chainLength?: number;
  };
  /** 响应头是否呈 HTTP/2 常见形态（全小写键名，启发式） */
  likelyHttp2Response: boolean;
  /** 请求 URL 主机名 */
  requestHostname?: string;
  /** dns.hosts 绑定的 IP（轮询结果） */
  pinnedIp?: string;
  /** 是否绕过系统 DNS（使用 YAML HostPin） */
  dnsPinned: boolean;
  /** 本次请求使用的代理 URL */
  proxy?: string;
  /** 代理策略 */
  proxyMode?: ProxyMode;
};

/** GET 结果：字节 + 传输追踪 + 飞行路线 */
export type WebFetchResult = {
  bytes: Uint8Array;
  trace: FetchTransportTrace;
  flightPath?: FetchFlightPath;
};

export type WebFetchGetOptions = {
  /** 单次请求 header 覆盖（最高优先级） */
  headers?: Record<string, string>;
  /** 单次 TLS 浏览器 profile 覆盖 */
  tlsFingerprint?: TlsFingerprintConfig;
  /** 为 true 时收集 TLS 证书与完整 trace（默认 false） */
  trace?: boolean;
  /** 单次代理 URL；false 表示禁用 */
  proxy?: string | false;
  /** 单次代理策略覆盖 */
  proxyMode?: ProxyMode;
};

export type WebFetchOptions = {
  /** 自定义 fetch；默认 node-wreq（TLS 指纹） */
  fetch?: TlsFetchFn;
  /** 默认 TLS 浏览器 profile（JA3/JA4/HTTP2）；省略时读 geoclaw.yaml tls 段 */
  tlsFingerprint?: TlsFingerprintConfig;
  /** 每个请求附加的上下文头；省略时读 geoclaw.yaml fetch.contextHeaders */
  contextHeaders?: Record<string, string>;
  /** 持久覆盖（高于 context，低于单次 headers） */
  headerOverrides?: Record<string, string>;
  /** protobuf 响应时使用 identity 编码；省略时读 geoclaw.yaml */
  forceIdentityEncoding?: boolean;
  /** 注入 TLS 指纹 codec（测试用） */
  tlsFingerprintCodec?: TlsFingerprintCodec;
  /** 请求超时（毫秒）；省略时读 geoclaw.yaml fetch.timeoutMs */
  timeout?: number;
  /** 默认开启传输 trace 日志（DEBUG 级别）；省略时读 geoclaw.yaml */
  logTransportTrace?: boolean;
  /** HostPin 池；false 关闭；省略时按 geoclaw.yaml hostPin 段 */
  hostPinPool?: HostPinPool | false;
  /** 域名 HostPin 注册表；false 关闭；省略时自动发现 config/{hostname}.yaml */
  hostPinRegistry?: HostPinRegistry | false;
  /** 代理 URL；false 禁用；省略时读 geoclaw.yaml proxy 段 */
  proxy?: string | false;
  /** 代理策略；省略时读 geoclaw.yaml proxy.mode */
  proxyMode?: ProxyMode;
  /** 热连接池；false 关闭；省略时按 geoclaw.yaml warmPool 段 */
  hotConnectionPool?: HotConnectionPool | false;
  /** Fetch 指标；false 关闭；省略时按 geoclaw.yaml fetchMetrics 段 */
  fetchMetrics?: FetchMetrics | false;
  /** 出站原样 PUT；false 关闭；省略时按 geoclaw.yaml fetchExport 段 */
  fetchExport?: FetchExportSink | false;
};

/**
 * 带 TLS 浏览器指纹的 HTTP GET 抓取对象（非 Rocktree 专用）。
 */
export class WebFetch {
  private static readonly logger = new Logger("WebFetch");
  private readonly options: Required<
    Pick<WebFetchOptions, "contextHeaders" | "headerOverrides" | "forceIdentityEncoding" | "logTransportTrace">
  > &
    Pick<WebFetchOptions, "fetch" | "tlsFingerprint" | "timeout"> & {
      tlsFingerprintCodec: TlsFingerprintCodec;
      hostPinPool?: HostPinPool;
      hostPinRegistry?: HostPinRegistry;
      fetchRoute: FetchRouteOptions;
      fetchRouteResolver?: FetchRouteResolver;
      hotConnectionPool?: HotConnectionPool;
      fetchTaskPool?: FetchTaskPool;
      fetchMetrics?: FetchMetrics;
      fetchExport?: FetchExportSink;
      ipGeoRegistry?: IpGeoRegistry;
      warmPoolFallbackToHostPin: boolean;
      proxyMode: ProxyMode;
      proxyUrl?: string;
    };

  /**
   * 构造实例。
   * @param options - 输入：`WebFetchOptions` — 配置选项
   * @returns 输出：`WebFetch` — WebFetch 实例
   */

  constructor(options: WebFetchOptions = {}) {
    const cfg = GeoClawConfig.get();
    const fetchMetrics =
      options.fetchMetrics === false
        ? undefined
        : (options.fetchMetrics ?? createFetchMetricsFromConfig());
    const hotConnectionPool =
      options.hotConnectionPool === false
        ? undefined
        : (options.hotConnectionPool ?? createHotConnectionPoolFromConfig());
    const fetchTaskPool =
      hotConnectionPool !== undefined
        ? new FetchTaskPool(hotConnectionPool, cfg.getFetchTaskPoolOptions(), fetchMetrics)
        : undefined;

    this.options = {
      fetch: options.fetch,
      tlsFingerprint: options.tlsFingerprint ?? cfg.getTlsFingerprint(),
      contextHeaders: options.contextHeaders ?? cfg.getContextHeaders(),
      headerOverrides: options.headerOverrides ?? {},
      forceIdentityEncoding: options.forceIdentityEncoding ?? cfg.getForceIdentityEncoding(),
      tlsFingerprintCodec: options.tlsFingerprintCodec ?? new TlsFingerprintCodec(),
      timeout: options.timeout ?? cfg.getFetchTimeoutMs(),
      logTransportTrace: options.logTransportTrace ?? cfg.getLogTransportTrace(),
      hostPinPool:
        options.hostPinPool === false
          ? undefined
          : (options.hostPinPool ?? createHostPinPoolFromConfig()),
      hostPinRegistry:
        options.hostPinRegistry === false
          ? undefined
          : (options.hostPinRegistry ?? createHostPinRegistryFromConfig()),
      fetchRoute: cfg.getFetchRouteOptions(),
      fetchRouteResolver: createFetchRouteResolverFromConfig(),
      hotConnectionPool,
      fetchTaskPool,
      fetchMetrics,
      fetchExport:
        options.fetchExport === false
          ? undefined
          : (options.fetchExport ?? createFetchExportSinkFromConfig()),
      ipGeoRegistry: buildIpGeoRegistryFromConfig(),
      warmPoolFallbackToHostPin: cfg.getWarmPoolFallbackToHostPin(),
      proxyMode: options.proxyMode ?? cfg.getProxyMode(),
      proxyUrl:
        options.proxy === false
          ? undefined
          : (typeof options.proxy === "string" ? options.proxy : cfg.getProxyUrl()),
    };
  }

  /**
   * 获取 Bytes。
   * @param url - 输入：`string` — 完整 HTTP URL
   * @param getOptions - 输入：`WebFetchGetOptions` — getOptions 参数
   * @returns 输出：`Promise<Uint8Array>` — 异步返回 Uint8Array
   */

  async getBytes(url: string, getOptions: WebFetchGetOptions = {}): Promise<Uint8Array> {
    const { bytes } = await this.getBytesWithTrace(url, getOptions);
    return bytes;
  }

  /**
   * 获取 BytesWithTrace。
   * @param url - 输入：`string` — 完整 HTTP URL
   * @param getOptions - 输入：`WebFetchGetOptions` — getOptions 参数
   * @returns 输出：`Promise<WebFetchResult>` — 异步返回 WebFetchResult
   * @throws {Error} 条件不满足或 I/O 失败时
   */

  async getBytesWithTrace(
    url: string,
    getOptions: WebFetchGetOptions = {},
  ): Promise<WebFetchResult> {
    return WebFetch.logger.measureAsync(
      "getBytesWithTrace",
      async () => {
        const urlHostname = new URL(url).hostname;
        const extraHeaders = this.buildHeaders(getOptions);
        const browser = this.resolveBrowser(getOptions);
        const collectTls = getOptions.trace ?? this.options.logTransportTrace;
        const hotPool = this.options.hotConnectionPool;
        const warmHostname = GeoClawConfig.get().getRaw().hostPin.hostname;
        const hasDomainYaml =
          this.options.hostPinRegistry?.hasYamlForHostname(urlHostname) ??
          urlHostname === warmHostname;

        if (hotPool && hasDomainYaml) {
          // 热池为空时也走任务池：NoHotIp 会回队等重热，禁止在此直接抛错把压测记成失败
          if (hotPool.getHotCount() > 0 || !this.options.warmPoolFallbackToHostPin) {
            return this.getBytesViaHotPool(url, getOptions, extraHeaders, browser, collectTls);
          }
        }

        const fetchFn = this.options.fetch ?? wreqFetch;
        const transport = fetchFn === wreqFetch ? "node-wreq" : "custom";
        const hostPin = this.resolveHostPin(url);
        const proxy = this.resolveProxy(hostPin?.pinnedIp, getOptions);
        const requestId = this.options.fetchMetrics?.createRequestId() ?? cryptoRandomId();
        this.options.fetchMetrics?.onRequestStart(requestId, url);
        const coldStarted = Date.now();

        WebFetch.logger.debug("发起 TLS GET", {
          url,
          transport,
          browser,
          extraHeaderKeys: Object.keys(extraHeaders),
          pinnedIp: hostPin?.pinnedIp,
          proxy,
        });

        let stats: RequestStats | undefined;
        const res = await fetchFn(url, {
          method: "GET",
          browser,
          headers: extraHeaders,
          ...(this.options.timeout !== undefined ? { timeout: this.options.timeout } : {}),
          ...(hostPin ? { dns: hostPin.dns } : {}),
          ...(proxy ? { proxy } : {}),
          ...(collectTls ? { tlsDebug: { peerCertificates: true } } : {}),
          onStats: (s: RequestStats) => {
            stats = s;
          },
        });

        if (!res.ok) {
          void res.arrayBuffer().catch(() => undefined);
          const durationMs = durationFromStats(stats, coldStarted);
          this.options.fetchMetrics?.onAttempt(
            requestId,
            url,
            1,
            hostPin?.pinnedIp,
            { kind: "http_error", httpStatus: res.status },
            durationMs,
          );
          this.options.fetchMetrics?.onRequestFailed(requestId, hostPin?.pinnedIp, res.status);
          WebFetch.logger.error("HTTP 请求失败", { status: res.status, url });
          throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
        }

        const buf = new Uint8Array(await res.arrayBuffer());
        const durationMs = durationFromStats(stats, coldStarted);
        this.options.fetchMetrics?.onAttempt(
          requestId,
          url,
          1,
          hostPin?.pinnedIp,
          { kind: "success", httpStatus: res.status },
          durationMs,
          buf.length,
        );
        this.options.fetchMetrics?.onRequestSuccess(
          requestId,
          hostPin?.pinnedIp ?? "",
          res.status,
          buf.length,
        );
        const trace = buildTransportTrace({
          url,
          transport,
          browser,
          extraHeaders,
          status: res.status,
          statusText: res.statusText,
          responseHeaders: headersToRecord(res.headers),
          bodyBytes: buf.length,
          timings: res.wreq.timings ?? stats?.timings,
          tlsPeer: res.wreq.tls,
          requestHostname: hostPin?.hostname ?? new URL(url).hostname,
          pinnedIp: hostPin?.pinnedIp,
          dnsPinned: Boolean(hostPin),
          proxy,
          proxyMode: getOptions.proxyMode ?? this.options.proxyMode,
        });

        if (this.options.logTransportTrace || getOptions.trace) {
          WebFetch.logger.info("传输层 trace", trace);
        } else {
          WebFetch.logger.debug("HTTP 响应", {
            url,
            bytes: buf.length,
            status: res.status,
            likelyHttp2: trace.likelyHttp2Response,
          });
        }

        await this.maybeExportBytes(buf);

        return {
          bytes: buf,
          trace,
          flightPath: await this.emitFlightPath({
            requestId,
            url,
            hostPin,
            proxy,
            durationMs,
            bodyBytes: buf.length,
            httpStatus: res.status,
            viaHot: false,
            http2: trace.http2FingerprintEnabled && trace.likelyHttp2Response,
          }),
        };
      },
      { url },
    );
  }

  /**
   * 获取 HotConnectionPool。
   * @returns 输出：`undefined | HotConnectionPool` — undefined | HotConnectionPool 实例
   */

  getHotConnectionPool(): HotConnectionPool | undefined {
    return this.options.hotConnectionPool;
  }

  /**
   * 获取热路径任务池。
   * @returns 输出：`undefined | FetchTaskPool` — 未启用热池时为 undefined
   */
  getFetchTaskPool(): FetchTaskPool | undefined {
    return this.options.fetchTaskPool;
  }

  /**
   * 获取 FetchMetrics。
   * @returns 输出：`undefined | FetchMetrics` — undefined | FetchMetrics 实例
   */

  getFetchMetrics(): FetchMetrics | undefined {
    return this.options.fetchMetrics;
  }

  /**
   * 经热连接池 GET（复用 per-IP HTTP/2 连接）。
   * @param url - 输入：`string` — 完整 URL
   * @param getOptions - 输入：`WebFetchGetOptions` — 单次覆盖
   * @param extraHeaders - 输入：`Record<string, string>` — 已合并请求头
   * @param browser - 输入：`TlsFingerprintConfig` — TLS profile
   * @param collectTls - 输入：`boolean` — 是否收集 TLS 调试信息
   * @returns 输出：`Promise<WebFetchResult>` — 字节与 trace
   */

  private async getBytesViaHotPool(
    url: string,
    getOptions: WebFetchGetOptions,
    extraHeaders: Record<string, string>,
    browser: TlsFingerprintConfig,
    collectTls: boolean,
  ): Promise<WebFetchResult> {
    const taskPool = this.options.fetchTaskPool!;
    const perRequestHeaders = getOptions.headers ?? {};
    const merged =
      Object.keys(perRequestHeaders).length > 0
        ? { ...extraHeaders, ...perRequestHeaders }
        : extraHeaders;

    const requestId = this.options.fetchMetrics?.createRequestId() ?? cryptoRandomId();
    const { response, ip, timings, requestId: rid } = await taskPool.submit(url, merged, requestId);
    const proxy = this.resolveProxy(ip, getOptions);

    if (response.status !== GeoClawConfig.get().getWarmPoolSuccessStatus()) {
      WebFetch.logger.error("热连接 HTTP 非 200", { status: response.status, url, ip });
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${url}`);
    }

    // 远程 RTT 优先用 wait（首字节前）；在读 body 之前取 timings，避免把下载算进去
    const remoteTimings = timings ?? response.wreq.timings;
    const durationMs = durationFromTimings(remoteTimings, Date.now());
    const buf = new Uint8Array(await response.arrayBuffer());
    const urlHostname = new URL(url).hostname;
    this.options.fetchMetrics?.addIpBytes(ip, buf.length, urlHostname);
    const pinRecord = this.lookupPinRecord(ip);
    const trace = buildTransportTrace({
      url,
      transport: "node-wreq",
      browser,
      extraHeaders: merged,
      status: response.status,
      statusText: response.statusText,
      responseHeaders: headersToRecord(response.headers),
      bodyBytes: buf.length,
      timings: remoteTimings,
      tlsPeer: collectTls ? response.wreq.tls : undefined,
      requestHostname: urlHostname,
      pinnedIp: ip,
      dnsPinned: true,
      proxy,
      proxyMode: getOptions.proxyMode ?? this.options.proxyMode,
    });

    const flightPath = await this.emitFlightPath({
      requestId: rid,
      url,
      hostPin: pinRecord
        ? {
            hostname: urlHostname,
            pinnedIp: ip,
            record: pinRecord,
            dns: { hosts: { [urlHostname]: [ip] } },
            yamlPath: this.options.hostPinRegistry?.resolveYamlPath(urlHostname) ?? undefined,
          }
        : undefined,
      proxy,
      durationMs,
      bodyBytes: buf.length,
      httpStatus: response.status,
      viaHot: true,
      http2: trace.http2FingerprintEnabled && trace.likelyHttp2Response,
    });

    if (this.options.logTransportTrace || getOptions.trace) {
      WebFetch.logger.info("热连接 trace", trace);
    } else {
      WebFetch.logger.debug("热连接响应", {
        url,
        ip,
        bytes: buf.length,
        status: response.status,
        likelyHttp2: trace.likelyHttp2Response,
      });
    }

    await this.maybeExportBytes(buf);

    return { bytes: buf, trace, flightPath };
  }

  /**
   * 进站成功后原样出站 PUT（未启用则跳过）。
   * @param bytes - 输入：`Uint8Array` — 进站响应原始字节
   * @returns 输出：`Promise<void>` — 无返回值
   */
  private async maybeExportBytes(bytes: Uint8Array): Promise<void> {
    const sink = this.options.fetchExport;
    if (!sink?.isActive()) return;
    await sink.putRaw(bytes);
  }

  /**
   * 解析 URL 对应 HostPin（config/{hostname}.yaml 存在则 pin，否则 undefined → 系统 DNS）。
   * @param url - 输入：`string` — 请求 URL
   * @returns 输出：`HostPinRegistryResolve | undefined` — HostPin 结果
   */

  private resolveHostPin(url: string): HostPinRegistryResolve | undefined {
    const fromRegistry = this.options.hostPinRegistry?.resolveForUrl(url);
    if (fromRegistry) {
      return fromRegistry;
    }
    const legacy = this.options.hostPinPool?.resolveForUrl(url);
    if (!legacy) {
      return undefined;
    }
    return {
      ...legacy,
      yamlPath: GeoClawConfig.resolvePath(GeoClawConfig.get().getRaw().hostPin.ipsFile),
    };
  }

  /**
   * @param ip - 输入：`string` — IP 地址
   * @returns 输出：`HostPinRecord | undefined` — geo 记录
   */

  private lookupPinRecord(ip: string): HostPinRecord | undefined {
    const geo = this.options.ipGeoRegistry?.lookup(ip);
    if (!geo) {
      return undefined;
    }
    return {
      ip,
      family: ip.includes(":") ? "ipv6" : "ipv4",
      city: geo.city,
      region: geo.region,
      country: geo.country,
      loc: geo.loc,
      org: geo.org,
      timezone: geo.timezone,
    };
  }

  /**
   * 构建并记录飞行路线（origin 经 ipinfo 出口 IP 自动解析）。
   * @param args - 输入：飞行路线参数
   * @returns 输出：`Promise<FetchFlightPath | undefined>` — 无法解析 origin 时 undefined
   */

  private async emitFlightPath(args: {
    requestId: string;
    url: string;
    hostPin?: HostPinRegistryResolve;
    proxy?: string;
    durationMs: number;
    bodyBytes?: number;
    httpStatus?: number;
    viaHot?: boolean;
    http2?: boolean;
  }): Promise<FetchFlightPath | undefined> {
    const hostname = new URL(args.url).hostname;
    const routeOpts = this.options.fetchRoute;
    let origin = routeOpts.origin;

    if (routeOpts.originMode === "ipinfo" && this.options.fetchRouteResolver) {
      try {
        origin = (await this.options.fetchRouteResolver.resolveOrigin(args.proxy)) ?? origin;
      } catch (err) {
        WebFetch.logger.warn("ipinfo origin 解析失败", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!origin) {
      return undefined;
    }

    let pinRecord = args.hostPin?.record;
    const pinnedIp = args.hostPin?.pinnedIp;

    if (pinnedIp && !parseLocString(pinRecord?.loc) && this.options.fetchRouteResolver) {
      try {
        pinRecord =
          (await this.options.fetchRouteResolver.resolveIpRecord(pinnedIp)) ?? pinRecord;
      } catch (err) {
        WebFetch.logger.debug("ipinfo 目标 IP 解析失败", { ip: pinnedIp, error: String(err) });
      }
    }

    if (
      !args.hostPin &&
      routeOpts.ipinfoForSystemDns &&
      this.options.fetchRouteResolver
    ) {
      try {
        pinRecord = (await this.options.fetchRouteResolver.resolveHostname(hostname)) ?? undefined;
      } catch (err) {
        WebFetch.logger.debug("ipinfo 目标域名解析失败", { hostname, error: String(err) });
      }
    }

    const path = buildFetchFlightPath({
      requestId: args.requestId,
      url: args.url,
      targetHostname: hostname,
      dnsMode: args.hostPin ? "hostpin" : "system",
      ipsYaml: args.hostPin?.yamlPath,
      pinnedIp: pinnedIp ?? pinRecord?.ip,
      pinRecord,
      route: { ...routeOpts, origin },
      proxyUrl: args.proxy,
      durationMs: args.durationMs,
      bodyBytes: args.bodyBytes,
      httpStatus: args.httpStatus,
      viaHot: args.viaHot,
      http2: args.http2,
    });
    this.options.fetchMetrics?.onFlightPath(path);
    return path;
  }

  /**
   * 执行 resolveBrowser。
   * @param getOptions - 输入：`WebFetchGetOptions` — getOptions 参数
   * @returns 输出：`BrowserEmulationOptions | "chrome_100" | "chrome_101" | …` — BrowserEmulationOptions | "chrome_100" | "chrome_101" | … 实例
   */

  resolveBrowser(getOptions: WebFetchGetOptions = {}): TlsFingerprintConfig {
    return this.options.tlsFingerprintCodec.resolveBrowser({
      tlsFingerprint: mergeTlsFingerprint(this.options.tlsFingerprint, getOptions.tlsFingerprint),
    });
  }

  /**
   * 执行 buildHeaders。
   * @param getOptions - 输入：`WebFetchGetOptions` — getOptions 参数
   * @returns 输出：`Record<string, string>` — Record<string, string> 实例
   */

  buildHeaders(getOptions: WebFetchGetOptions = {}): Record<string, string> {
    return WebFetch.logger.measureSync(
      "buildHeaders",
      () => {
        const config: TlsRequestConfig = {
          context: this.options.contextHeaders,
          overrides: {
            ...(this.options.forceIdentityEncoding
              ? { "Accept-Encoding": "identity" }
              : {}),
            ...this.options.headerOverrides,
          },
          perRequest: getOptions.headers,
        };
        return this.options.tlsFingerprintCodec.buildHeaders(config);
      },
      { perRequestKeys: Object.keys(getOptions.headers ?? {}) },
    );
  }

  /**
   * 执行 resolveProxy。
   * @param pinnedIp - 输入：`undefined | string` — pinnedIp 参数
   * @param getOptions - 输入：`WebFetchGetOptions` — getOptions 参数
   * @returns 输出：`undefined | string` — undefined | string 实例
   */

  resolveProxy(pinnedIp?: string, getOptions: WebFetchGetOptions = {}): string | undefined {
    return resolveProxyUrl({
      pinnedIp,
      proxyMode: getOptions.proxyMode ?? this.options.proxyMode,
      proxyUrl:
        getOptions.proxy === false
          ? undefined
          : (typeof getOptions.proxy === "string" ? getOptions.proxy : this.options.proxyUrl),
    });
  }
}

let cachedWebFetch: WebFetch | undefined;

/**
 * 获取 WebFetch。
 * @returns 输出：`WebFetch` — WebFetch 实例
 */
export function getWebFetch(): WebFetch {
  cachedWebFetch ??= new WebFetch();
  return cachedWebFetch;
}

/** @deprecated 请使用 getWebFetch()；保留 Proxy 以兼容旧代码 */
export const webFetch: WebFetch = new Proxy({} as WebFetch, {
  get(_target, prop) {
    const inst = getWebFetch();
    const value = Reflect.get(inst, prop, inst);
    return typeof value === "function" ? value.bind(inst) : value;
  },
});

/**
 * 创建 WebFetch 实例。
 * @param options - 输入：`WebFetchOptions` — 配置选项
 * @returns 输出：`WebFetch` — WebFetch 实例
 */
export function createWebFetch(options: WebFetchOptions = {}): WebFetch {
  return new WebFetch(options);
}

/**
 * 执行 mergeTlsFingerprint。
 * @param base - 输入：`undefined | BrowserEmulationOptions | "chrome_100" | …` — 基础 URL
 * @param override - 输入：`undefined | BrowserEmulationOptions | "chrome_100" | …` — override 参数
 * @returns 输出：`undefined | BrowserEmulationOptions | "chrome_100" | …` — undefined | BrowserEmulationOptions | "chrome_100" | … 实例
 */
function mergeTlsFingerprint(
  base?: TlsFingerprintConfig,
  override?: TlsFingerprintConfig,
): TlsFingerprintConfig | undefined {
  if (!base) return override;
  if (!override) return base;
  if (typeof override === "string") return override;
  if (typeof base === "string") {
    return { ...override, profile: override.profile ?? base };
  }
  return { ...base, ...override };
}

/**
 * 执行 buildTransportTrace。
 * @param args - 输入：`object` — 请求参数
 * @returns 输出：`FetchTransportTrace` — FetchTransportTrace 实例
 */
function buildTransportTrace(args: {
  url: string;
  transport: FetchTransportTrace["transport"];
  browser: TlsFingerprintConfig;
  extraHeaders: Record<string, string>;
  status: number;
  statusText: string;
  responseHeaders: Record<string, string>;
  bodyBytes: number;
  timings?: RequestTimings;
  tlsPeer?: { peerCertificate?: Uint8Array; peerCertificateChain?: Uint8Array[] };
  requestHostname?: string;
  pinnedIp?: string;
  dnsPinned: boolean;
  proxy?: string;
  proxyMode?: ProxyMode;
}): FetchTransportTrace {
  const responseHeaderKeys = Object.keys(args.responseHeaders);
  const likelyHttp2Response =
    responseHeaderKeys.length > 0 &&
    responseHeaderKeys.every((k) => k === k.toLowerCase());

  return {
    url: args.url,
    transport: args.transport,
    browser: args.browser,
    http2FingerprintEnabled: isHttp2FingerprintEnabled(args.browser),
    profileHeadersEnabled: isProfileHeadersEnabled(args.browser),
    extraHeaders: args.extraHeaders,
    status: args.status,
    statusText: args.statusText,
    responseHeaders: args.responseHeaders,
    bodyBytes: args.bodyBytes,
    timings: args.timings,
    tlsPeer: args.tlsPeer
      ? {
          hasCertificate: Boolean(args.tlsPeer.peerCertificate),
          chainLength: args.tlsPeer.peerCertificateChain?.length,
        }
      : undefined,
    likelyHttp2Response,
    requestHostname: args.requestHostname,
    pinnedIp: args.pinnedIp,
    dnsPinned: args.dnsPinned,
    proxy: args.proxy,
    proxyMode: args.proxyMode,
  };
}

/**
 * 判断 Http2FingerprintEnabled。
 * @param browser - 输入：`BrowserEmulationOptions | "chrome_100" | "chrome_101" | …` — browser 参数
 * @returns 输出：`boolean` — 条件成立返回 true，否则 false
 */
function isHttp2FingerprintEnabled(browser: TlsFingerprintConfig): boolean {
  if (typeof browser === "string") return true;
  return browser.http2 !== false;
}

/**
 * 判断 ProfileHeadersEnabled。
 * @param browser - 输入：`BrowserEmulationOptions | "chrome_100" | "chrome_101" | …` — browser 参数
 * @returns 输出：`boolean` — 条件成立返回 true，否则 false
 */
function isProfileHeadersEnabled(browser: TlsFingerprintConfig): boolean {
  if (typeof browser === "string") return true;
  return browser.headers !== false;
}

/**
 * 执行 headersToRecord。
 * @param headers - 输入：`object` — headers 参数
 * @returns 输出：`Record<string, string>` — Record<string, string> 实例
 */
function headersToRecord(headers: { entries(): IterableIterator<[string, string]> }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    out[key] = value;
  }
  return out;
}

/**
 * 执行 durationFromStats。
 * @param stats - 输入：`undefined | RequestStats` — stats 参数
 * @param fallbackStart - 输入：`number` — fallbackStart 参数
 * @returns 输出：`number` — 数值结果
 */
function durationFromStats(stats: RequestStats | undefined, fallbackStart: number): number {
  return durationFromTimings(stats?.timings, fallbackStart);
}

/**
 * 执行 durationFromTimings。
 * @param timings - 输入：`undefined | RequestTimings` — timings 参数
 * @param fallbackStart - 输入：`number` — fallbackStart 参数
 * @returns 输出：`number` — 数值结果
 */
function durationFromTimings(
  timings: import("node-wreq").RequestTimings | undefined,
  fallbackStart: number,
): number {
  // 优先 wait：到首字节的远程等待，不含本地下载/排队/路径解析
  if (timings?.wait !== undefined) {
    return Math.round(timings.wait);
  }
  if (timings?.total !== undefined) {
    return Math.round(timings.total);
  }
  return Date.now() - fallbackStart;
}

/**
 * 执行 cryptoRandomId。
 * @returns 输出：`string` — 字符串结果
 */
function cryptoRandomId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
