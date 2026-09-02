import {
  BROWSER_PROFILES,
  type BrowserEmulation,
  type BrowserEmulationOptions,
  type BrowserPlatform,
  type BrowserProfile,
} from "node-wreq";

import { GeoClawConfig } from "../core/GeoClawConfig.js";
import { Logger } from "../core/Logger.js";

/** TLS/JA3/JA4/HTTP2 浏览器指纹配置（node-wreq BrowserEmulation） */
export type TlsFingerprintConfig = BrowserEmulation;

/** 单次请求的 TLS 指纹与 header 合并配置 */
export type TlsRequestConfig = {
  /** 覆盖本次 TLS 浏览器 profile */
  tlsFingerprint?: TlsFingerprintConfig;
  /** 站点上下文头（如 Origin / Referer） */
  context?: Record<string, string>;
  /** 覆盖（优先级高于 context） */
  overrides?: Record<string, string>;
  /** 单次请求附加头 */
  perRequest?: Record<string, string>;
};

export type { BrowserProfile, BrowserPlatform, BrowserEmulationOptions };

/** 内置 TLS 浏览器 profile 列表（node-wreq BROWSER_PROFILES） */
export const BROWSER_TLS_PROFILES = BROWSER_PROFILES;

/**
 * TLS 浏览器指纹 codec：解析 node-wreq profile 并合并请求头。
 */
export class TlsFingerprintCodec {
  private static readonly logger = new Logger("TlsFingerprintCodec");
  private readonly defaultConfig: TlsFingerprintConfig;

  /**
   * @param defaultConfig - 输入：`TlsFingerprintConfig` — 默认 TLS profile；省略时从 geoclaw.yaml 读取
   */

  constructor(defaultConfig?: TlsFingerprintConfig) {
    this.defaultConfig = defaultConfig ?? GeoClawConfig.get().getTlsFingerprint();
    TlsFingerprintCodec.logger.debug("初始化 TLS 指纹", { defaultConfig: this.defaultConfig });
  }

  /**
   * 返回 YAML 中的 fetch.contextHeaders。
   * @returns 输出：`Record<string, string>` — contextHeaders
   */

  getContextHeaders(): Record<string, string> {
    return GeoClawConfig.get().getContextHeaders();
  }

  /**
   * 解析本次请求使用的 TLS 浏览器 profile。
   * @param config - 输入：`TlsRequestConfig` — 可选 tlsFingerprint 覆盖
   * @returns 输出：`BrowserEmulation` — 传给 node-wreq 的 browser 选项
   */

  resolveBrowser(config: TlsRequestConfig = {}): BrowserEmulation {
    return TlsFingerprintCodec.logger.measureSync(
      "resolveBrowser",
      () => mergeBrowserEmulation(this.defaultConfig, config.tlsFingerprint),
      { hasOverride: Boolean(config.tlsFingerprint) },
    );
  }

  /**
   * 合并 context / overrides / perRequest 请求头（TLS profile 默认头由 node-wreq 注入）。
   * @param config - 输入：`TlsRequestConfig` — context、overrides、perRequest
   * @returns 输出：`Record<string, string>` — 附加请求头
   */

  buildHeaders(config: TlsRequestConfig = {}): Record<string, string> {
    return TlsFingerprintCodec.logger.measureSync(
      "buildHeaders",
      () =>
        mergeHeaderRecords(
          config.context ?? GeoClawConfig.get().getContextHeaders(),
          config.overrides,
          config.perRequest,
        ),
      { keys: Object.keys(config.perRequest ?? {}) },
    );
  }

  /**
   * 返回当前默认 TLS 指纹配置副本。
   * @returns 输出：`TlsFingerprintConfig` — tls 段
   */

  getDefaultConfig(): TlsFingerprintConfig {
    return cloneBrowserEmulation(this.defaultConfig);
  }

  /**
   * 列出 node-wreq 内置 TLS 浏览器 profile。
   * @returns 输出：`readonly BrowserProfile[]` — profile 名称列表
   */

  listProfiles(): readonly BrowserProfile[] {
    return BROWSER_TLS_PROFILES;
  }
}

/**
 * 合并默认与单次 TLS profile 覆盖。
 * @param base - 输入：`TlsFingerprintConfig` — 默认 profile
 * @param override - 输入：`TlsFingerprintConfig | undefined` — 单次覆盖
 * @returns 输出：`BrowserEmulation` — 合并后的 browser 选项
 */
function mergeBrowserEmulation(
  base: TlsFingerprintConfig,
  override?: TlsFingerprintConfig,
): BrowserEmulation {
  if (!override) {
    return cloneBrowserEmulation(base);
  }
  if (typeof override === "string") {
    return override;
  }
  if (typeof base === "string") {
    return { ...override, profile: override.profile ?? base };
  }
  return { ...base, ...override };
}

/**
 * 复制 TLS profile 配置（避免 mutate 默认值）。
 * @param config - 输入：`TlsFingerprintConfig` — 源 profile
 * @returns 输出：`BrowserEmulation` — 副本
 */
function cloneBrowserEmulation(config: TlsFingerprintConfig): BrowserEmulation {
  return typeof config === "string" ? config : { ...config };
}

/**
 * 按顺序合并多层请求头（后者覆盖前者）。
 * @param layers - 输入：`Record<string, string> | undefined` — context、overrides、perRequest
 * @returns 输出：`Record<string, string>` — 合并后的请求头
 */
function mergeHeaderRecords(
  ...layers: (Record<string, string> | undefined)[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined && value !== "") {
        out[key] = value;
      }
    }
  }
  return out;
}
