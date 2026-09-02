/** SOCKS5/HTTP 代理使用策略（与 config/geoclaw.yaml proxy.mode 一致） */
export type ProxyMode = "auto" | "always" | "never";

/**
 * 按策略决定是否使用代理 URL。
 * @param input - 输入：`object` — pinnedIp、proxyMode、proxyUrl
 * @returns 输出：`string | undefined` — 代理 URL
 */
export function resolveProxyUrl(input: {
  pinnedIp?: string;
  proxyMode: ProxyMode;
  proxyUrl?: string;
}): string | undefined {
  if (input.proxyMode === "never" || !input.proxyUrl) {
    return undefined;
  }
  if (input.proxyMode === "always") {
    return input.proxyUrl;
  }
  if (input.pinnedIp?.includes(":")) {
    return input.proxyUrl;
  }
  return undefined;
}
