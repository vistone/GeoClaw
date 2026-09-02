import { Logger } from "../core/Logger.js";
import {
  BrowserFingerprintCodec,
  browserFingerprintCodec,
  EARTH_WEB_CONTEXT_HEADERS,
  type BrowserFingerprintConfig,
  type RequestHeaderConfig,
} from "./BrowserFingerprintCodec.js";

export type WebFetchGetOptions = {
  /** 单次请求 header 覆盖（最高优先级） */
  headers?: Record<string, string>;
  /** 单次指纹参数覆盖 */
  fingerprint?: BrowserFingerprintConfig;
};

export type WebFetchOptions = {
  /** 自定义 fetch 实现 */
  fetch?: typeof globalThis.fetch;
  /** header-generator 默认指纹配置 */
  fingerprint?: BrowserFingerprintConfig;
  /** 每个请求附加的上下文头（默认 Google Earth） */
  contextHeaders?: Record<string, string>;
  /** 持久覆盖（高于 context，低于单次 headers） */
  headerOverrides?: Record<string, string>;
  /** protobuf 响应时使用 identity 编码；默认 true */
  forceIdentityEncoding?: boolean;
  /** 注入指纹 codec（测试用） */
  fingerprintCodec?: BrowserFingerprintCodec;
};

/**
 * 带浏览器指纹的 HTTP GET 抓取对象（非 Rocktree 专用）。
 */
export class WebFetch {
  private static readonly logger = new Logger("WebFetch");
  private readonly options: Required<
    Pick<WebFetchOptions, "contextHeaders" | "headerOverrides" | "forceIdentityEncoding">
  > &
    Pick<WebFetchOptions, "fetch" | "fingerprint"> & {
      fingerprintCodec: BrowserFingerprintCodec;
    };

  /**
   * @param options - 输入：`WebFetchOptions` — fetch、指纹、context、header 覆盖
   */

  constructor(options: WebFetchOptions = {}) {
    this.options = {
      fetch: options.fetch,
      fingerprint: options.fingerprint,
      contextHeaders: options.contextHeaders ?? { ...EARTH_WEB_CONTEXT_HEADERS },
      headerOverrides: options.headerOverrides ?? {},
      forceIdentityEncoding: options.forceIdentityEncoding ?? true,
      fingerprintCodec: options.fingerprintCodec ?? browserFingerprintCodec,
    };
  }

  /**
   * GET 请求并返回响应字节。
   * @param url - 输入：`string` — 完整 URL
   * @param getOptions - 输入：`WebFetchGetOptions` — 单次 headers / fingerprint 覆盖
   * @returns 输出：`Promise<Uint8Array>` — 响应体
   * @throws {Error} fetch 不可用或 HTTP 非 2xx
   */

  async getBytes(url: string, getOptions: WebFetchGetOptions = {}): Promise<Uint8Array> {
    return WebFetch.logger.measureAsync(
      "getBytes",
      async () => {
        const fetchFn = this.options.fetch ?? globalThis.fetch;
        if (!fetchFn) {
          WebFetch.logger.error("fetch 不可用");
          throw new Error("global fetch is unavailable; pass options.fetch");
        }

        const headers = this.buildHeaders(getOptions);
        WebFetch.logger.debug("发起 GET", { url, headerKeys: Object.keys(headers) });

        const res = await fetchFn(url, { method: "GET", headers });
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
   * 构建本次 GET 请求头（指纹 + context + 覆盖）。
   * @param getOptions - 输入：`WebFetchGetOptions` — 单次覆盖
   * @returns 输出：`Record<string, string>` — 请求头
   */

  buildHeaders(getOptions: WebFetchGetOptions = {}): Record<string, string> {
    return WebFetch.logger.measureSync(
      "buildHeaders",
      () => {
        const config: RequestHeaderConfig = {
          fingerprint: {
            ...this.options.fingerprint,
            ...getOptions.fingerprint,
          },
          context: this.options.contextHeaders,
          overrides: {
            ...(this.options.forceIdentityEncoding
              ? { "Accept-Encoding": "identity" }
              : {}),
            ...this.options.headerOverrides,
          },
          perRequest: getOptions.headers,
        };
        return this.options.fingerprintCodec.build(config);
      },
      { perRequestKeys: Object.keys(getOptions.headers ?? {}) },
    );
  }
}

export const webFetch = new WebFetch();

/**
 * 创建 WebFetch 实例。
 * @param options - 输入：`WebFetchOptions` — fetch、指纹与 header 配置
 * @returns 输出：`WebFetch` — WebFetch 实例
 */
export function createWebFetch(options: WebFetchOptions = {}): WebFetch {
  return new WebFetch(options);
}
