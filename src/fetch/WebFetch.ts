import { fetch as wreqFetch, type RequestStats, type RequestTimings } from "node-wreq";

import { Logger } from "../core/Logger.js";
import {
  EARTH_WEB_CONTEXT_HEADERS,
  TlsFingerprintCodec,
  tlsFingerprintCodec,
  type TlsFingerprintConfig,
  type TlsRequestConfig,
} from "./TlsFingerprintCodec.js";

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
};

/** GET 结果：字节 + 传输追踪 */
export type WebFetchResult = {
  bytes: Uint8Array;
  trace: FetchTransportTrace;
};

export type WebFetchGetOptions = {
  /** 单次请求 header 覆盖（最高优先级） */
  headers?: Record<string, string>;
  /** 单次 TLS 浏览器 profile 覆盖 */
  tlsFingerprint?: TlsFingerprintConfig;
  /** 为 true 时收集 TLS 证书与完整 trace（默认 false） */
  trace?: boolean;
};

export type WebFetchOptions = {
  /** 自定义 fetch；默认 node-wreq（TLS 指纹） */
  fetch?: TlsFetchFn;
  /** 默认 TLS 浏览器 profile（JA3/JA4/HTTP2） */
  tlsFingerprint?: TlsFingerprintConfig;
  /** 每个请求附加的上下文头（默认 Google Earth） */
  contextHeaders?: Record<string, string>;
  /** 持久覆盖（高于 context，低于单次 headers） */
  headerOverrides?: Record<string, string>;
  /** protobuf 响应时使用 identity 编码；默认 true */
  forceIdentityEncoding?: boolean;
  /** 注入 TLS 指纹 codec（测试用） */
  tlsFingerprintCodec?: TlsFingerprintCodec;
  /** 请求超时（毫秒） */
  timeout?: number;
  /** 默认开启传输 trace 日志（DEBUG 级别） */
  logTransportTrace?: boolean;
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
    };

  /**
   * @param options - 输入：`WebFetchOptions` — TLS 指纹、context、header 覆盖
   */

  constructor(options: WebFetchOptions = {}) {
    this.options = {
      fetch: options.fetch,
      tlsFingerprint: options.tlsFingerprint,
      contextHeaders: options.contextHeaders ?? { ...EARTH_WEB_CONTEXT_HEADERS },
      headerOverrides: options.headerOverrides ?? {},
      forceIdentityEncoding: options.forceIdentityEncoding ?? true,
      tlsFingerprintCodec: options.tlsFingerprintCodec ?? tlsFingerprintCodec,
      timeout: options.timeout,
      logTransportTrace: options.logTransportTrace ?? false,
    };
  }

  /**
   * GET 请求并返回响应字节（TLS 浏览器指纹由 node-wreq 原生层实现）。
   * @param url - 输入：`string` — 完整 URL
   * @param getOptions - 输入：`WebFetchGetOptions` — 单次 headers / tlsFingerprint 覆盖
   * @returns 输出：`Promise<Uint8Array>` — 响应体
   * @throws {Error} fetch 不可用或 HTTP 非 2xx
   */

  async getBytes(url: string, getOptions: WebFetchGetOptions = {}): Promise<Uint8Array> {
    const { bytes } = await this.getBytesWithTrace(url, getOptions);
    return bytes;
  }

  /**
   * GET 请求并返回响应字节与传输层 trace（用于确认 TLS/HTTP 协议栈）。
   * @param url - 输入：`string` — 完整 URL
   * @param getOptions - 输入：`WebFetchGetOptions` — 单次覆盖；`trace: true` 收集 TLS 证书
   * @returns 输出：`Promise<WebFetchResult>` — 字节与 FetchTransportTrace
   * @throws {Error} fetch 不可用或 HTTP 非 2xx
   */

  async getBytesWithTrace(
    url: string,
    getOptions: WebFetchGetOptions = {},
  ): Promise<WebFetchResult> {
    return WebFetch.logger.measureAsync(
      "getBytesWithTrace",
      async () => {
        const fetchFn = this.options.fetch ?? wreqFetch;
        const transport = fetchFn === wreqFetch ? "node-wreq" : "custom";
        const browser = this.resolveBrowser(getOptions);
        const extraHeaders = this.buildHeaders(getOptions);
        const collectTls = getOptions.trace ?? this.options.logTransportTrace;

        WebFetch.logger.debug("发起 TLS GET", {
          url,
          transport,
          browser,
          extraHeaderKeys: Object.keys(extraHeaders),
        });

        let stats: RequestStats | undefined;
        const res = await fetchFn(url, {
          method: "GET",
          browser,
          headers: extraHeaders,
          ...(this.options.timeout !== undefined ? { timeout: this.options.timeout } : {}),
          ...(collectTls ? { tlsDebug: { peerCertificates: true } } : {}),
          onStats: (s: RequestStats) => {
            stats = s;
          },
        });

        if (!res.ok) {
          WebFetch.logger.error("HTTP 请求失败", { status: res.status, url });
          throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
        }

        const buf = new Uint8Array(await res.arrayBuffer());
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

        return { bytes: buf, trace };
      },
      { url },
    );
  }

  /**
   * 解析本次 GET 使用的 TLS 浏览器 profile。
   * @param getOptions - 输入：`WebFetchGetOptions` — 单次覆盖
   * @returns 输出：`TlsFingerprintConfig` — node-wreq browser 选项
   */

  resolveBrowser(getOptions: WebFetchGetOptions = {}): TlsFingerprintConfig {
    return this.options.tlsFingerprintCodec.resolveBrowser({
      tlsFingerprint: mergeTlsFingerprint(this.options.tlsFingerprint, getOptions.tlsFingerprint),
    });
  }

  /**
   * 构建本次 GET 附加请求头（context + 覆盖；profile 默认头由 node-wreq 注入）。
   * @param getOptions - 输入：`WebFetchGetOptions` — 单次覆盖
   * @returns 输出：`Record<string, string>` — 请求头
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
}

export const webFetch = new WebFetch();

/**
 * 创建 WebFetch 实例。
 * @param options - 输入：`WebFetchOptions` — TLS 指纹与 header 配置
 * @returns 输出：`WebFetch` — WebFetch 实例
 */
export function createWebFetch(options: WebFetchOptions = {}): WebFetch {
  return new WebFetch(options);
}

/**
 * 合并默认与单次 TLS profile 覆盖。
 * @param base - 输入：`TlsFingerprintConfig | undefined` — 实例默认 profile
 * @param override - 输入：`TlsFingerprintConfig | undefined` — 单次覆盖
 * @returns 输出：`TlsFingerprintConfig | undefined` — 合并结果
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
 * 从 node-wreq 响应组装 FetchTransportTrace。
 * @param args - 输入：`object` — url、browser、status、responseHeaders、timings、tlsPeer
 * @returns 输出：`FetchTransportTrace` — 传输层追踪对象
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
  };
}

/**
 * 判断 browser profile 是否启用 HTTP/2 指纹。
 * @param browser - 输入：`TlsFingerprintConfig` — node-wreq browser 选项
 * @returns 输出：`boolean` — true 表示配置 ALPN/h2 指纹
 */
function isHttp2FingerprintEnabled(browser: TlsFingerprintConfig): boolean {
  if (typeof browser === "string") return true;
  return browser.http2 !== false;
}

/**
 * 判断 browser profile 是否注入默认浏览器头。
 * @param browser - 输入：`TlsFingerprintConfig` — node-wreq browser 选项
 * @returns 输出：`boolean` — true 表示使用 profile 默认头顺序
 */
function isProfileHeadersEnabled(browser: TlsFingerprintConfig): boolean {
  if (typeof browser === "string") return true;
  return browser.headers !== false;
}

/**
 * 将 Headers 转为普通对象。
 * @param headers - 输入：`Headers` — node-wreq 响应头
 * @returns 输出：`Record<string, string>` — 键值对
 */
function headersToRecord(headers: { entries(): IterableIterator<[string, string]> }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    out[key] = value;
  }
  return out;
}

/** Google Earth Web 默认上下文头 */
export { EARTH_WEB_CONTEXT_HEADERS };
