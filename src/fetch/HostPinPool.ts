import { readFileSync } from "node:fs";

import type { DnsOptions } from "node-wreq";

import { GeoClawConfig } from "../core/GeoClawConfig.js";
import { Logger } from "../core/Logger.js";

/** YAML 中单条 IP 记录（仅解析 ip 字段） */
export type HostPinRecord = {
  ip: string;
  family: "ipv4" | "ipv6";
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
  dns: DnsOptions;
};

/**
 * 从 geoclaw.yaml hostPin 段创建 HostPin 池；未启用时返回 undefined。
 * @returns 输出：`HostPinPool | undefined` — 配置启用时的池实例
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
   * @param options - 输入：`HostPinPoolOptions` — 域名、YAML 路径或预置 IP
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
   * 返回池中 IP 数量（懒加载 YAML）。
   * @returns 输出：`number` — 可用 IP 数
   */

  size(): number {
    return this.loadRecords().length;
  }

  /**
   * 轮询取下一条 IP。
   * @returns 输出：`string` — IPv4 或 IPv6 地址
   * @throws {Error} 池为空时
   */

  nextIp(): string {
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
    return record.ip;
  }

  /**
   * 若 URL 主机名匹配池域名，生成 node-wreq dns.hosts（单 IP，无 DNS 查询）。
   * @param url - 输入：`string` — 请求 URL
   * @returns 输出：`HostPinResolveResult | undefined` — 不匹配时 undefined
   */

  resolveForUrl(url: string): HostPinResolveResult | undefined {
    return HostPinPool.logger.measureSync(
      "resolveForUrl",
      () => {
        const hostname = new URL(url).hostname;
        if (hostname !== this.options.hostname) {
          return undefined;
        }
        const pinnedIp = this.nextIp();
        return {
          hostname,
          pinnedIp,
          dns: {
            hosts: {
              [hostname]: [pinnedIp],
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
 * 解析 kh.google.com.yaml 中的 ipv4 / ipv6 列表。
 * @param yamlText - 输入：`string` — YAML 全文
 * @returns 输出：`{ ipv4, ipv6, all }` — 分族与合并列表
 */
export function parseKhGoogleYaml(yamlText: string): {
  ipv4: HostPinRecord[];
  ipv6: HostPinRecord[];
  all: HostPinRecord[];
} {
  const ipv4: HostPinRecord[] = [];
  const ipv6: HostPinRecord[] = [];
  let section: "none" | "ipv4" | "ipv6" = "none";

  for (const line of yamlText.split("\n")) {
    if (line.startsWith("ipv4:")) {
      section = "ipv4";
      continue;
    }
    if (line.startsWith("ipv6:")) {
      section = "ipv6";
      continue;
    }
    const match = line.match(/^\s+- ip:\s+(\S+)/);
    if (!match?.[1]) continue;
    const ip = match[1];
    if (section === "ipv4") {
      ipv4.push({ ip, family: "ipv4" });
    } else if (section === "ipv6") {
      ipv6.push({ ip, family: "ipv6" });
    }
  }

  return { ipv4, ipv6, all: [...ipv4, ...ipv6] };
}

/**
 * 从 YAML 文件加载 IP 列表。
 * @param yamlPath - 输入：`string` — ipsFile 绝对路径
 * @param family - 输入：`"all" | "ipv4" | "ipv6"` — 地址族
 * @returns 输出：`HostPinRecord[]` — IP 记录
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
