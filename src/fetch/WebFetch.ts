import { fetch as wreqFetch } from "node-wreq";

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

export type WebFetchGetOptions = {
  /** 单次请求 header 覆盖（最高优先级） */
  headers?: Record<string, string>;
  /** 单次 TLS 浏览器 profile 覆盖 */
  tlsFingerprint?: TlsFingerprintConfig;
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
};

/**
 * 带 TLS 浏览器指纹的 HTTP GET 抓取对象（非 Rocktree 专用）。
 */
export class WebFetch {
  private static readonly logger = new Logger("WebFetch");
  private readonly options: Required<
    Pick<WebFetchOptions, "contextHeaders" | "headerOverrides" | "forceIdentityEncoding">
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
    return WebFetch.logger.measureAsync(
      "getBytes",
      async () => {
        const fetchFn = this.options.fetch ?? wreqFetch;
        const browser = this.resolveBrowser(getOptions);
        const headers = this.buildHeaders(getOptions);
        WebFetch.logger.debug("发起 TLS GET", {
          url,
          browser,
          headerKeys: Object.keys(headers),
        });

        const res = await fetchFn(url, {
          method: "GET",
          browser,
          headers,
          ...(this.options.timeout !== undefined ? { timeout: this.options.timeout } : {}),
        });

        if (!res.ok) {
          WebFetch.logger.error("HTTP 请求失败", { status: res.status, url });
          throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
        }

        const buf = new Uint8Array(await res.arrayBuffer());
        WebFetch.logger.debug("HTTP 响应", { url, bytes: buf.length, status: res.status });
        return buf;
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

/** Google Earth Web 默认上下文头 */
export { EARTH_WEB_CONTEXT_HEADERS };
