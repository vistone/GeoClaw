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
   * 按 token 与超时配置初始化客户端。
   * @param options - 输入：`IpInfoClientOptions` — token、baseUrl、timeoutMs
   */
  constructor(options: IpInfoClientOptions) {
    this.options = options;
  }

  /**
   * 查询当前出口 IP 的地理信息。
   * @param proxyUrl - 输入：`undefined | string` — 可选代理 URL；经代理则查代理出口
   * @returns 输出：`Promise<IpInfoRecord>` — 含 ip、loc、city 的地理记录
   */
  async lookupSelf(proxyUrl?: string): Promise<IpInfoRecord> {
    return IpInfoClient.logger.measureAsync(
      "lookupSelf",
      () => this.fetchJson(`${this.options.baseUrl}/json`, proxyUrl),
      { proxyUrl: proxyUrl ?? null },
    );
  }

  /**
   * 按 IP 查询地理信息。
   * @param ip - 输入：`string` — 待查询的 IP 地址
   * @returns 输出：`Promise<IpInfoRecord>` — 含 ip、loc、city 的地理记录
   */
  async lookupIp(ip: string): Promise<IpInfoRecord> {
    return IpInfoClient.logger.measureAsync(
      "lookupIp",
      () => {
        const encoded = encodeURIComponent(ip);
        return this.fetchJson(`${this.options.baseUrl}/${encoded}/json`);
      },
      { ip },
    );
  }

  /**
   * 向 ipinfo 发起 JSON GET 并校验响应。
   * @param url - 输入：`string` — 不含 token 的请求 URL
   * @param proxyUrl - 输入：`string | undefined` — 可选代理
   * @returns 输出：`Promise<IpInfoRecord>` — 解析后的地理记录
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
