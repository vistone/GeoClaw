import { readFileSync } from "node:fs";

import type { DnsOptions } from "node-wreq";
import { parse as parseYaml } from "yaml";

import { GeoClawConfig } from "../core/GeoClawConfig.js";
import { Logger } from "../core/Logger.js";

/** YAML 中单条 IP 记录 */
export type HostPinRecord = {
  ip: string;
  family: "ipv4" | "ipv6";
  hostname?: string;
  city?: string;
  region?: string;
  country?: string;
  loc?: string;
  org?: string;
  timezone?: string;
};

type YamlIpEntry = {
  ip: string;
  hostname?: string;
  city?: string;
  region?: string;
  country?: string;
  loc?: string;
  org?: string;
  timezone?: string;
};

export type HostPinPoolOptions = {
  /** 要 pin 的域名（如 kh.google.com） */
  hostname: string;
  /** 预置 IP 列表（测试注入；优先于 yamlPath） */
  ips?: readonly string[];
  /** YAML 文件路径（相对项目根或绝对路径）；无 ips 时必填 */
  yamlPath?: string;
  /** 轮询地址族：all 为 ipv4+ipv6 合并列表 */
  family?: "all" | "ipv4" | "ipv6";
};

export type HostPinResolveResult = {
  hostname: string;
  pinnedIp: string;
  record: HostPinRecord;
  dns: DnsOptions;
};

/**
 * 创建 HostPinPoolFromConfig。
 * @returns 输出：`undefined | HostPinPool` — undefined | HostPinPool 实例
 */
export function createHostPinPoolFromConfig(): HostPinPool | undefined {
  const opts = GeoClawConfig.get().getHostPinPoolOptions();
  return opts ? new HostPinPool(opts) : undefined;
}

/**
 * 从 kh.google.com.yaml 加载 IP 并按轮询分配（绕过 DNS 解析）。
 */
export class HostPinPool {
  private static readonly logger = new Logger("HostPinPool");
  private readonly options: Required<Pick<HostPinPoolOptions, "hostname" | "family">> &
    Pick<HostPinPoolOptions, "ips" | "yamlPath">;
  private records: HostPinRecord[] | null = null;
  private roundRobinIndex = 0;

  /**
   * 构造实例。
   * @param options - 输入：`HostPinPoolOptions` — 配置选项
   * @returns 输出：`HostPinPool` — HostPinPool 实例
   * @throws {Error} 条件不满足或 I/O 失败时
   */

  constructor(options: HostPinPoolOptions) {
    if (!options.hostname) {
      throw new Error("HostPinPool: hostname is required");
    }
    this.options = {
      hostname: options.hostname,
      family: options.family ?? "all",
      ips: options.ips,
      yamlPath: options.yamlPath,
    };
  }

  /**
   * 执行 size。
   * @returns 输出：`number` — 数值结果
   */

  size(): number {
    return this.loadRecords().length;
  }

  /**
   * 执行 nextIp。
   * @returns 输出：`string` — 字符串结果
   */

  nextIp(): string {
    return this.nextRecord().ip;
  }

  /**
   * 执行 nextRecord。
   * @returns 输出：`HostPinRecord` — HostPinRecord 实例
   * @throws {Error} 条件不满足或 I/O 失败时
   */

  nextRecord(): HostPinRecord {
    const list = this.loadRecords();
    if (list.length === 0) {
      HostPinPool.logger.error("HostPin 池为空", { hostname: this.options.hostname });
      throw new Error(`HostPinPool empty for ${this.options.hostname}`);
    }
    const record = list[this.roundRobinIndex % list.length]!;
    this.roundRobinIndex = (this.roundRobinIndex + 1) % list.length;
    HostPinPool.logger.debug("轮询 HostPin", {
      hostname: this.options.hostname,
      ip: record.ip,
      family: record.family,
      index: this.roundRobinIndex,
      poolSize: list.length,
    });
    return record;
  }

  /**
   * 执行 resolveForUrl。
   * @param url - 输入：`string` — 完整 HTTP URL
   * @returns 输出：`undefined | HostPinResolveResult` — undefined | HostPinResolveResult 实例
   */

  resolveForUrl(url: string): HostPinResolveResult | undefined {
    return this.resolveForUrlWithRecord(url);
  }

  /**
   * 执行 resolveForUrlWithRecord。
   * @param url - 输入：`string` — 完整 HTTP URL
   * @returns 输出：`undefined | HostPinResolveResult` — undefined | HostPinResolveResult 实例
   */

  resolveForUrlWithRecord(url: string): HostPinResolveResult | undefined {
    return HostPinPool.logger.measureSync(
      "resolveForUrl",
      () => {
        const hostname = new URL(url).hostname;
        if (hostname !== this.options.hostname) {
          return undefined;
        }
        const pinnedIp = this.nextRecord();
        return {
          hostname,
          pinnedIp: pinnedIp.ip,
          record: pinnedIp,
          dns: {
            hosts: {
              [hostname]: [pinnedIp.ip],
            },
          },
        };
      },
      { url },
    );
  }

  /**
   * 读取 YAML 并缓存 IP 列表。
   * @returns 输出：`HostPinRecord[]` — 解析后的 IP 记录
   */

  private loadRecords(): HostPinRecord[] {
    if (this.records) {
      return this.records;
    }
    if (this.options.ips && this.options.ips.length > 0) {
      this.records = this.options.ips.map((ip) => ({
        ip,
        family: ip.includes(":") ? "ipv6" : "ipv4",
      }));
      return this.records;
    }

    const yamlPath = this.options.yamlPath;
    if (!yamlPath) {
      throw new Error(
        `HostPinPool: yamlPath is required when ips are not provided (hostname=${this.options.hostname})`,
      );
    }
    const resolvedPath = GeoClawConfig.resolvePath(yamlPath);
    HostPinPool.logger.info("加载 HostPin YAML", {
      yamlPath: resolvedPath,
      hostname: this.options.hostname,
    });
    const text = readFileSync(resolvedPath, "utf8");
    const parsed = parseKhGoogleYaml(text);
    const selected =
      this.options.family === "ipv4"
        ? parsed.ipv4
        : this.options.family === "ipv6"
          ? parsed.ipv6
          : parsed.all;

    this.records = selected;
    HostPinPool.logger.info("HostPin 池就绪", {
      hostname: this.options.hostname,
      ipv4: parsed.ipv4.length,
      ipv6: parsed.ipv6.length,
      total: selected.length,
    });
    return this.records;
  }
}

/**
 * 解析 KhGoogleYaml。
 * @param yamlText - 输入：`string` — yamlText 参数
 * @returns 输出：`object` — object 实例
 */
export function parseKhGoogleYaml(yamlText: string): {
  ipv4: HostPinRecord[];
  ipv6: HostPinRecord[];
  all: HostPinRecord[];
} {
  const doc = parseYaml(yamlText) as { ipv4?: YamlIpEntry[]; ipv6?: YamlIpEntry[] } | null;
  const ipv4 = (doc?.ipv4 ?? [])
    .filter((e): e is YamlIpEntry => Boolean(e?.ip))
    .map((e) => yamlEntryToRecord(e, "ipv4"));
  const ipv6 = (doc?.ipv6 ?? [])
    .filter((e): e is YamlIpEntry => Boolean(e?.ip))
    .map((e) => yamlEntryToRecord(e, "ipv6"));
  return { ipv4, ipv6, all: [...ipv4, ...ipv6] };
}

/**
 * 执行 yamlEntryToRecord。
 * @param entry - 输入：`YamlIpEntry` — entry 参数
 * @param family - 输入：`"ipv4" | "ipv6"` — family 参数
 * @returns 输出：`HostPinRecord` — HostPinRecord 实例
 */
function yamlEntryToRecord(entry: YamlIpEntry, family: "ipv4" | "ipv6"): HostPinRecord {
  return {
    ip: entry.ip,
    family,
    hostname: entry.hostname,
    city: entry.city,
    region: entry.region,
    country: entry.country,
    loc: entry.loc,
    org: entry.org,
    timezone: entry.timezone,
  };
}

/**
 * 执行 loadHostPinRecordsFromYaml。
 * @param yamlPath - 输入：`string` — yamlPath 参数
 * @param family - 输入：`"ipv4" | "ipv6" | "all"` — family 参数
 * @returns 输出：`HostPinRecord[]` — HostPinRecord[] 实例
 */
export function loadHostPinRecordsFromYaml(
  yamlPath: string,
  family: "all" | "ipv4" | "ipv6",
): HostPinRecord[] {
  const text = readFileSync(yamlPath, "utf8");
  const parsed = parseKhGoogleYaml(text);
  if (family === "ipv4") return parsed.ipv4;
  if (family === "ipv6") return parsed.ipv6;
  return parsed.all;
}
