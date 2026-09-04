import { fetch as wreqFetch } from "node-wreq";

import { GeoClawConfig } from "../core/GeoClawConfig.js";
import { Logger } from "../core/Logger.js";
import type { ProxyMode } from "./FetchTypes.js";
import { resolveProxyUrl } from "./FetchTypes.js";

/** 出站 PUT 存档选项（与进站 fetch 配置分离） */
export type FetchExportOptions = {
  enabled: boolean;
  method: "PUT";
  url: string | null;
  headers: Record<string, string>;
  timeoutMs: number | null;
  proxyMode: ProxyMode;
  failOpen: boolean;
};

/** 可注入的出站 PUT（测试用） */
export type FetchExportPutFn = (input: {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  body: Uint8Array;
  proxy?: string;
  timeoutMs?: number;
}) => Promise<{ ok: boolean; status: number; statusText: string }>;

export type FetchExportSinkOptions = FetchExportOptions & {
  /** 全局 proxy URL（仅当 proxyMode 需要时使用） */
  proxyUrl?: string;
  putFn?: FetchExportPutFn;
};

/**
 * 进站成功后的响应原样 PUT 出站（不改字节、不借用进站头）。
 */
export class FetchExportSink {
  private static readonly logger = new Logger("FetchExportSink");
  private readonly options: FetchExportSinkOptions;
  private readonly putFn: FetchExportPutFn;

  /**
   * @param options - 输入：`FetchExportSinkOptions` — url/headers/代理与可选 putFn
   */
  constructor(options: FetchExportSinkOptions) {
    this.options = options;
    this.putFn = options.putFn ?? defaultPutFn;
  }

  /**
   * 是否会对传入字节发起出站 PUT。
   * @returns 输出：`boolean` — enabled 且 url 非空时为 true
   */
  isActive(): boolean {
    return this.options.enabled && Boolean(this.options.url?.trim());
  }

  /**
   * 将进站响应原样 PUT 到配置地址。
   * @param bytes - 输入：`Uint8Array` — 进站响应原始字节（禁止改写）
   * @returns 输出：`Promise<void>` — failOpen 时失败仅记日志
   * @throws {Error} failOpen=false 且 PUT 失败时
   */
  async putRaw(bytes: Uint8Array): Promise<void> {
    return FetchExportSink.logger.measureAsync(
      "putRaw",
      async () => {
        if (!this.isActive()) return;
        const url = this.options.url!.trim();
        const proxy = resolveProxyUrl({
          proxyMode: this.options.proxyMode,
          proxyUrl: this.options.proxyUrl,
        });
        const timeoutMs =
          this.options.timeoutMs === null || this.options.timeoutMs === undefined
            ? undefined
            : this.options.timeoutMs;
        try {
          const res = await this.putFn({
            url,
            method: "PUT",
            headers: { ...this.options.headers },
            body: bytes,
            ...(proxy ? { proxy } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
          if (!res.ok) {
            throw new Error(`fetchExport PUT HTTP ${res.status} ${res.statusText}: ${url}`);
          }
          FetchExportSink.logger.debug("出站 PUT 成功", {
            url,
            bytes: bytes.byteLength,
            status: res.status,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (this.options.failOpen) {
            FetchExportSink.logger.warn("出站 PUT 失败（failOpen，进站结果仍返回）", {
              url,
              bytes: bytes.byteLength,
              error: message,
            });
            return;
          }
          throw err instanceof Error ? err : new Error(message);
        }
      },
      { bytes: bytes.byteLength, url: this.options.url },
    );
  }
}

/**
 * 从 geoclaw.yaml 的 fetchExport 段创建出站 PUT；未启用或无 url 时返回 undefined。
 * @returns 输出：`undefined | FetchExportSink` — 可 PUT 的 sink
 */
export function createFetchExportSinkFromConfig(): FetchExportSink | undefined {
  const opts = GeoClawConfig.get().getFetchExportOptions();
  if (!opts.enabled || !opts.url?.trim()) {
    return undefined;
  }
  return new FetchExportSink({
    ...opts,
    proxyUrl: GeoClawConfig.get().getProxyUrl(),
  });
}

/**
 * 默认出站 PUT：node-wreq，不套进站 TLS 浏览器指纹。
 * @param input - 输入：`object` — url/headers/body/proxy/timeout
 * @returns 输出：`Promise<{ ok; status; statusText }>` — HTTP 结果摘要
 */
async function defaultPutFn(input: {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  body: Uint8Array;
  proxy?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; statusText: string }> {
  const res = await wreqFetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body,
    ...(input.proxy ? { proxy: input.proxy } : {}),
    ...(input.timeoutMs !== undefined ? { timeout: input.timeoutMs } : {}),
  });
  if (!res.ok) {
    void res.arrayBuffer().catch(() => undefined);
  } else {
    void res.arrayBuffer().catch(() => undefined);
  }
  return { ok: res.ok, status: res.status, statusText: res.statusText };
}
