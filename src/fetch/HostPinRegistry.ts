import { existsSync } from "node:fs";
import { join } from "node:path";

import { GeoClawConfig } from "../core/GeoClawConfig.js";
import { Logger } from "../core/Logger.js";
import { HostPinPool, type HostPinResolveResult } from "./HostPinPool.js";

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
   * 按配置目录与 IP 族初始化域名 HostPin 注册表。
   * @param options - 输入：`{ configDir; family; fallbackHostname; fallbackYamlPath }` — 目录与回退 YAML
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
   * 判断域名是否存在对应 HostPin YAML。
   * @param hostname - 输入：`string` — 请求主机名
   * @returns 输出：`boolean` — 找到 YAML 路径则 true
   */
  hasYamlForHostname(hostname: string): boolean {
    return this.resolveYamlPath(hostname) !== null;
  }

  /**
   * 按 URL 主机名解析 HostPin IP 与 DNS 覆盖。
   * @param url - 输入：`string` — 完整 HTTP URL
   * @returns 输出：`undefined | HostPinRegistryResolve` — 无 YAML 或池为空则为 undefined
   */
  resolveForUrl(url: string): HostPinRegistryResolve | undefined {
    return HostPinRegistry.logger.measureSync(
      "resolveForUrl",
      () => {
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
      },
      { url },
    );
  }

  /**
   * 解析域名对应的 HostPin YAML 绝对路径。
   * @param hostname - 输入：`string` — 请求主机名
   * @returns 输出：`null | string` — 存在则为绝对路径，否则 null
   */
  resolveYamlPath(hostname: string): string | null {
    return HostPinRegistry.logger.measureSync(
      "resolveYamlPath",
      () => {
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
      },
      { hostname },
    );
  }
}

/**
 * 从 geoclaw.yaml 的 hostPin 段创建域名注册表。
 * @returns 输出：`undefined | HostPinRegistry` — hostPin 未启用时为 undefined
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
