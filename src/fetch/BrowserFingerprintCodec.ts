import {
  HeaderGenerator,
  type HeaderGeneratorOptions,
  type Headers,
} from "header-generator";

import { Logger } from "../core/Logger.js";

/** 可配置的浏览器指纹选项（header-generator） */
export type BrowserFingerprintConfig = Partial<HeaderGeneratorOptions>;

/** 请求头合并配置 */
export type RequestHeaderConfig = {
  /** 覆盖本次指纹生成参数 */
  fingerprint?: BrowserFingerprintConfig;
  /** 站点上下文头（如 Origin / Referer） */
  context?: Record<string, string>;
  /** 覆盖指纹结果（优先级高于 context） */
  overrides?: Record<string, string>;
  /** 单次请求附加头 */
  perRequest?: Record<string, string>;
};

/** Google Earth Web 默认上下文头 */
export const EARTH_WEB_CONTEXT_HEADERS: Readonly<Record<string, string>> = {
  Origin: "https://earth.google.com",
  Referer: "https://earth.google.com/",
};

/** 默认桌面 Chrome / Linux 指纹（对齐 header-generator MODERN_LINUX_CHROME） */
export const DEFAULT_BROWSER_FINGERPRINT: BrowserFingerprintConfig = {
  browserListQuery: "last 5 chrome versions",
  operatingSystems: ["linux"],
  devices: ["desktop"],
  locales: ["en-US", "en"],
  httpVersion: "2",
};

/**
 * 基于 header-generator 的浏览器指纹请求头对象。
 */
export class BrowserFingerprintCodec {
  private static readonly logger = new Logger("BrowserFingerprintCodec");
  private readonly generator: HeaderGenerator;

  /**
   * @param defaultConfig - 输入：`BrowserFingerprintConfig` — 构造时默认指纹参数
   */

  constructor(defaultConfig: BrowserFingerprintConfig = DEFAULT_BROWSER_FINGERPRINT) {
    this.generator = new HeaderGenerator(defaultConfig);
    BrowserFingerprintCodec.logger.debug("初始化 HeaderGenerator", { defaultConfig });
  }

  /**
   * 生成并合并 HTTP 请求头。
   * @param config - 输入：`RequestHeaderConfig` — 指纹、context、overrides、perRequest
   * @returns 输出：`Record<string, string>` — 合并后的请求头
   */

  build(config: RequestHeaderConfig = {}): Record<string, string> {
    return BrowserFingerprintCodec.logger.measureSync(
      "build",
      () => {
        const generated = this.generator.getHeaders(
          config.fingerprint ?? {},
          config.perRequest ?? {},
        );
        const merged = mergeHeaderRecords(
          generated,
          config.context,
          config.overrides,
          config.perRequest,
        );
        BrowserFingerprintCodec.logger.debug("生成请求头", {
          keys: Object.keys(merged),
        });
        return merged;
      },
      { hasOverrides: Boolean(config.overrides) },
    );
  }

  /**
   * 返回新的 HeaderGenerator 选项快照（只读复制）。
   * @returns 输出：`BrowserFingerprintConfig` — 当前 generator 全局选项
   */

  getDefaultConfig(): BrowserFingerprintConfig {
    return { ...this.generator.globalOptions };
  }
}

export const browserFingerprintCodec = new BrowserFingerprintCodec();

/**
 * 按顺序合并多层请求头（后者覆盖前者）。
 * @param layers - 输入：`Headers | undefined` — 指纹、context、overrides、perRequest 各层
 * @returns 输出：`Record<string, string>` — 合并后的请求头
 */
function mergeHeaderRecords(...layers: (Headers | undefined)[]): Record<string, string> {
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
