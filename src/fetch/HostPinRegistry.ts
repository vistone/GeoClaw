import { existsSync } from "node:fs";
import { join } from "node:path";

import { GeoClawConfig } from "../core/GeoClawConfig.js";
import { Logger } from "../core/Logger.js";
import { HostPinPool, type HostPinRecord, type HostPinResolveResult } from "./HostPinPool.js";

/** 域名 HostPin 解析结果（含 YAML 路径与 IP 记录） */
export type HostPinRegistryResolve = HostPinResolveResult & {
  yamlPath?: string;
};

/**
 * 按请求域名查找 config/{hostname}.yaml；存在则 HostPin，否则走系统 DNS。
 */
export class HostPinRegistry {
  private static readonly logger = new Logger("HostPinRegistry");
  private readonly family: "all" | "ipv4" | "ipv6";
  private readonly configDir: string;
  private readonly fallbackHostname: string | null;
  private readonly fallbackYamlPath: string | null;
  private readonly pools = new Map<string, HostPinPool>();

  /**
   * 构造实例。
   * @param options - 输入：`object` — 配置选项
   * @returns 输出：`HostPinRegistry` — HostPinRegistry 实例
   */

  constructor(options: {
    configDir: string;
    family: "all" | "ipv4" | "ipv6";
    fallbackHostname: string | null;
    fallbackYamlPath: string | null;
  }) {
    this.configDir = options.configDir;
    this.family = options.family;
    this.fallbackHostname = options.fallbackHostname;
    this.fallbackYamlPath = options.fallbackYamlPath;
  }

  /**
   * 判断 YamlForHostname。
   * @param hostname - 输入：`string` — hostname 参数
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */

  hasYamlForHostname(hostname: string): boolean {
    return this.resolveYamlPath(hostname) !== null;
  }

  /**
   * 执行 resolveForUrl。
   * @param url - 输入：`string` — 完整 HTTP URL
   * @returns 输出：`undefined | HostPinResolveResult & object` — undefined | HostPinResolveResult & object 实例
   */

  resolveForUrl(url: string): HostPinRegistryResolve | undefined {
    const hostname = new URL(url).hostname;
    const yamlPath = this.resolveYamlPath(hostname);
    if (!yamlPath) {
      return undefined;
    }

    let pool = this.pools.get(hostname);
    if (!pool) {
      pool = new HostPinPool({
        hostname,
        yamlPath,
        family: this.family,
      });
      this.pools.set(hostname, pool);
      HostPinRegistry.logger.info("域名 HostPin 池已加载", { hostname, yamlPath });
    }

    const resolved = pool.resolveForUrlWithRecord(url);
    if (!resolved) {
      return undefined;
    }

    return {
      ...resolved,
      yamlPath,
    };
  }

  /**
   * 执行 resolveYamlPath。
   * @param hostname - 输入：`string` — hostname 参数
   * @returns 输出：`null | string` — null | string 实例
   */

  resolveYamlPath(hostname: string): string | null {
    const autoPath = join(this.configDir, `${hostname}.yaml`);
    const autoAbs = GeoClawConfig.resolvePath(autoPath);
    if (existsSync(autoAbs)) {
      return autoAbs;
    }

    if (
      this.fallbackHostname === hostname &&
      this.fallbackYamlPath &&
      existsSync(this.fallbackYamlPath)
    ) {
      return this.fallbackYamlPath;
    }

    return null;
  }
}

/**
 * 创建 HostPinRegistryFromConfig。
 * @returns 输出：`undefined | HostPinRegistry` — undefined | HostPinRegistry 实例
 */
export function createHostPinRegistryFromConfig(): HostPinRegistry | undefined {
  const cfg = GeoClawConfig.get();
  const hostPin = cfg.getRaw().hostPin;
  if (!hostPin.enabled) {
    return undefined;
  }

  const configDir = hostPin.configDir ?? "config";
  const fallbackYaml = hostPin.ipsFile
    ? GeoClawConfig.resolvePath(hostPin.ipsFile)
    : null;

  return new HostPinRegistry({
    configDir,
    family: hostPin.family,
    fallbackHostname: hostPin.hostname,
    fallbackYamlPath: fallbackYaml,
  });
}
