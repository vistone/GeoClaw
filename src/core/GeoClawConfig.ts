import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import type { BrowserEmulationOptions, BrowserPlatform, BrowserProfile } from "node-wreq";

import { setGlobalLogLevel, LogLevel, logLevelFromString } from "./LogConfig.js";
import type { HostPinPoolOptions } from "../fetch/HostPinPool.js";
import type { ProxyMode } from "../fetch/FetchTypes.js";

/** config/geoclaw.yaml 文件结构 */
export type GeoClawConfigFile = {
  log: { level: string };
  rocktree: { baseUrl: string };
  fetch: {
    contextHeaders: Record<string, string>;
    forceIdentityEncoding: boolean;
    logTransportTrace: boolean;
    timeoutMs: number | null;
  };
  tls: {
    profile: string;
    platform: string;
    http2: boolean;
    profileHeaders: boolean;
  };
  proxy: {
    enabled: boolean;
    url: string;
    mode: ProxyMode;
  };
  hostPin: {
    enabled: boolean;
    hostname: string;
    ipsFile: string;
    family: "all" | "ipv4" | "ipv6";
  };
  benchmark: {
    concurrency: number;
    timeoutMs: number;
    outDir: string;
    planetoidPath: string;
  };
};

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(MODULE_DIR, "..", "..");
const DEFAULT_CONFIG_REL = "config/geoclaw.yaml";

/**
 * 从外部 YAML 加载 GeoClaw 运行时配置（单例）。
 */
export class GeoClawConfig {
  private static instance: GeoClawConfig | null = null;
  private readonly file: GeoClawConfigFile;
  private readonly configPath: string;

  private constructor(configPath: string, file: GeoClawConfigFile) {
    this.configPath = configPath;
    this.file = file;
  }

  /**
   * 加载配置；重复调用返回同一实例，除非先 reset。
   * @param configPath - 输入：`string | undefined` — YAML 路径；默认 GEOCLAW_CONFIG 或 config/geoclaw.yaml
   * @returns 输出：`GeoClawConfig` — 配置单例
   */

  static load(configPath?: string): GeoClawConfig {
    if (GeoClawConfig.instance) {
      return GeoClawConfig.instance;
    }
    const resolved = GeoClawConfig.resolveConfigPath(configPath);
    const raw = readFileSync(resolved, "utf8");
    const parsed = parseYaml(raw) as GeoClawConfigFile;
    GeoClawConfig.validate(parsed);
    setGlobalLogLevel(logLevelFromString(parsed.log.level));
    GeoClawConfig.instance = new GeoClawConfig(resolved, parsed);
    return GeoClawConfig.instance;
  }

  /**
   * 获取已加载配置；未加载时自动 load。
   * @returns 输出：`GeoClawConfig` — 配置单例
   */

  static get(): GeoClawConfig {
    return GeoClawConfig.instance ?? GeoClawConfig.load();
  }

  /**
   * 测试用：清空单例。
   * @returns 输出：无（`void`）
   */

  static reset(): void {
    GeoClawConfig.instance = null;
  }

  /**
   * 配置文件绝对路径。
   * @returns 输出：`string` — geoclaw.yaml 路径
   */

  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * 原始 YAML 对象（只读引用）。
   * @returns 输出：`GeoClawConfigFile` — 配置对象
   */

  getRaw(): Readonly<GeoClawConfigFile> {
    return this.file;
  }

  /**
   * 日志级别。
   * @returns 输出：`LogLevel` — 来自 YAML log.level
   */

  getLogLevel(): LogLevel {
    return logLevelFromString(this.file.log.level);
  }

  /**
   * Rocktree API baseUrl。
   * @returns 输出：`string` — rocktree.baseUrl
   */

  getRocktreeBaseUrl(): string {
    return this.file.rocktree.baseUrl;
  }

  /**
   * PlanetoidMetadata 完整 URL。
   * @returns 输出：`string` — baseUrl + planetoidPath
   */

  getPlanetoidMetadataUrl(): string {
    return joinUrl(this.file.rocktree.baseUrl, this.file.benchmark.planetoidPath);
  }

  /**
   * fetch 上下文请求头。
   * @returns 输出：`Record<string, string>` — fetch.contextHeaders
   */

  getContextHeaders(): Record<string, string> {
    return { ...this.file.fetch.contextHeaders };
  }

  /**
   * 是否强制 Accept-Encoding: identity。
   * @returns 输出：`boolean` — fetch.forceIdentityEncoding
   */

  getForceIdentityEncoding(): boolean {
    return this.file.fetch.forceIdentityEncoding;
  }

  /**
   * 默认是否打印传输 trace。
   * @returns 输出：`boolean` — fetch.logTransportTrace
   */

  getLogTransportTrace(): boolean {
    return this.file.fetch.logTransportTrace;
  }

  /**
   * 默认请求超时（毫秒）；null 表示不设置。
   * @returns 输出：`number | undefined` — fetch.timeoutMs
   */

  getFetchTimeoutMs(): number | undefined {
    const v = this.file.fetch.timeoutMs;
    return v === null || v === undefined ? undefined : v;
  }

  /**
   * TLS 浏览器 profile（node-wreq）。
   * @returns 输出：`BrowserEmulationOptions` — tls 段
   */

  getTlsFingerprint(): BrowserEmulationOptions {
    return {
      profile: this.file.tls.profile as BrowserProfile,
      platform: this.file.tls.platform as BrowserPlatform,
      http2: this.file.tls.http2,
      headers: this.file.tls.profileHeaders,
    };
  }

  /**
   * 代理 URL；未启用时 undefined。
   * @returns 输出：`string | undefined` — proxy.url
   */

  getProxyUrl(): string | undefined {
    return this.file.proxy.enabled ? this.file.proxy.url : undefined;
  }

  /**
   * 代理策略。
   * @returns 输出：`ProxyMode` — proxy.mode
   */

  getProxyMode(): ProxyMode {
    return this.file.proxy.mode;
  }

  /**
   * HostPin 池选项；未启用时 null。
   * @returns 输出：`HostPinPoolOptions | null` — hostPin 段
   */

  getHostPinPoolOptions(): HostPinPoolOptions | null {
    if (!this.file.hostPin.enabled) {
      return null;
    }
    return {
      hostname: this.file.hostPin.hostname,
      yamlPath: GeoClawConfig.resolvePath(this.file.hostPin.ipsFile),
      family: this.file.hostPin.family,
    };
  }

  /**
   * benchmark 段配置。
   * @returns 输出：`GeoClawConfigFile["benchmark"]` — 测速默认值
   */

  getBenchmarkConfig(): GeoClawConfigFile["benchmark"] {
    return { ...this.file.benchmark };
  }

  /**
   * 解析相对/绝对路径为绝对路径（相对项目根）。
   * @param relOrAbs - 输入：`string` — 配置中的路径
   * @returns 输出：`string` — 绝对路径
   */

  static resolvePath(relOrAbs: string): string {
    return isAbsolute(relOrAbs) ? relOrAbs : join(PACKAGE_ROOT, relOrAbs);
  }

  /**
   * 解析 geoclaw.yaml 路径。
   * @param configPath - 输入：`string | undefined` — 可选覆盖
   * @returns 输出：`string` — 绝对路径
   */

  static resolveConfigPath(configPath?: string): string {
    const fromEnv = process.env.GEOCLAW_CONFIG;
    const rel = configPath ?? fromEnv ?? DEFAULT_CONFIG_REL;
    const abs = isAbsolute(rel) ? rel : join(PACKAGE_ROOT, rel);
    if (!existsSync(abs)) {
      throw new Error(`GeoClaw config not found: ${abs}`);
    }
    return abs;
  }

  private static validate(file: GeoClawConfigFile): void {
    if (!file?.rocktree?.baseUrl) {
      throw new Error("geoclaw.yaml: rocktree.baseUrl is required");
    }
    if (!file?.hostPin?.hostname) {
      throw new Error("geoclaw.yaml: hostPin.hostname is required");
    }
    if (!file?.tls?.profile) {
      throw new Error("geoclaw.yaml: tls.profile is required");
    }
  }
}

/**
 * 已加载的全局配置（懒加载 config/geoclaw.yaml）。
 */
export const geoclawConfig = {
  get value(): GeoClawConfig {
    return GeoClawConfig.get();
  },
};

/**
 * 拼接 base 与 path。
 * @param base - 输入：`string` — 基础 URL
 * @param pathSegment - 输入：`string` — 路径段
 * @returns 输出：`string` — 完整 URL
 */
function joinUrl(base: string, pathSegment: string): string {
  return `${base.replace(/\/+$/, "")}/${pathSegment.replace(/^\/+/, "")}`;
}
