import { fetch as wreqFetch } from "node-wreq";

import { Logger } from "../core/Logger.js";

/** ipinfo.io 返回的 IP 地理信息 */
export type IpInfoRecord = {
  ip: string;
  city?: string;
  region?: string;
  country?: string;
  loc?: string;
  org?: string;
  timezone?: string;
};

/** IpInfoClient 配置 */
export type IpInfoClientOptions = {
  token: string;
  baseUrl: string;
  timeoutMs: number;
};

/**
 * ipinfo.io 客户端：查询 IP 或出口 IP 的地理坐标。
 */
export class IpInfoClient {
  private static readonly logger = new Logger("IpInfoClient");
  private readonly options: IpInfoClientOptions;

  /**
   * 构造实例。
   * @param options - 输入：`IpInfoClientOptions` — 配置选项
   * @returns 输出：`IpInfoClient` — IpInfoClient 实例
   */

  constructor(options: IpInfoClientOptions) {
    this.options = options;
  }

  /**
   * 执行 lookupSelf。
   * @param proxyUrl - 输入：`undefined | string` — proxyUrl 参数
   * @returns 输出：`Promise<IpInfoRecord>` — 异步返回 IpInfoRecord
   */

  async lookupSelf(proxyUrl?: string): Promise<IpInfoRecord> {
    return this.fetchJson(`${this.options.baseUrl}/json`, proxyUrl);
  }

  /**
   * 执行 lookupIp。
   * @param ip - 输入：`string` — ip 参数
   * @returns 输出：`Promise<IpInfoRecord>` — 异步返回 IpInfoRecord
   */

  async lookupIp(ip: string): Promise<IpInfoRecord> {
    const encoded = encodeURIComponent(ip);
    return this.fetchJson(`${this.options.baseUrl}/${encoded}/json`);
  }

  /**
   * @param url - 输入：`string` — 请求 URL（已含 token 查询参数）
   * @param proxyUrl - 输入：`string | undefined` — 代理
   * @returns 输出：`Promise<IpInfoRecord>` — 解析结果
   */

  private async fetchJson(url: string, proxyUrl?: string): Promise<IpInfoRecord> {
    const sep = url.includes("?") ? "&" : "?";
    const fullUrl = `${url}${sep}token=${encodeURIComponent(this.options.token)}`;
    IpInfoClient.logger.debug("ipinfo 查询", { url: fullUrl.replace(this.options.token, "***") });

    const res = await wreqFetch(fullUrl, {
      method: "GET",
      timeout: this.options.timeoutMs,
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    });

    if (!res.ok) {
      throw new Error(`ipinfo HTTP ${res.status}: ${fullUrl.split("?")[0]}`);
    }

    const data = (await res.json()) as IpInfoRecord & { error?: string };
    if (data.error) {
      throw new Error(`ipinfo error: ${data.error}`);
    }
    if (!data.ip) {
      throw new Error("ipinfo: missing ip in response");
    }
    return data;
  }
}
