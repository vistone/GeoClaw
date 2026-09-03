import { existsSync } from "node:fs";
import { join } from "node:path";

import { GeoClawConfig } from "../core/GeoClawConfig.js";
import { FetchMetrics, type FetchMetricsOptions } from "./FetchMetrics.js";
import { loadHostPinRecordsFromYaml } from "./HostPinPool.js";
import { IpFetchStatsStore, type IpFetchStatsSeedIp } from "./IpFetchStatsStore.js";
import { IpGeoRegistry } from "./IpGeoRegistry.js";

/**
 * 从 geoclaw.yaml 的 fetchMetrics 段创建指标收集器。
 * @returns 输出：`undefined | FetchMetrics` — 未启用时为 undefined
 */
export function createFetchMetricsFromConfig(): FetchMetrics | undefined {
  const opts = GeoClawConfig.get().getFetchMetricsOptions();
  if (!opts?.enabled) {
    return undefined;
  }
  const geo = buildIpGeoRegistryFromConfig();
  const ipStats = createIpFetchStatsStoreFromConfig(opts);
  return new FetchMetrics(opts, geo, ipStats);
}

/**
 * 从 HostPin/warmPool YAML 构建 IP 地理注册表。
 * @returns 输出：`IpGeoRegistry` — 按 YAML IP 索引的地区表
 */
export function buildIpGeoRegistryFromConfig(): IpGeoRegistry {
  const cfg = GeoClawConfig.get();
  const hostPin = cfg.getRaw().hostPin;
  const warm = cfg.getRaw().warmPool;
  const ipsFile = warm?.ipsFile ?? hostPin.ipsFile;
  const yamlPath = GeoClawConfig.resolvePath(ipsFile);
  const records = loadHostPinRecordsFromYaml(yamlPath, hostPin.family);
  return new IpGeoRegistry(records);
}

/**
 * 从 fetchMetrics 选项创建按域名分文件的 IP 统计存储。
 * @param opts - 输入：`FetchMetricsOptions` — 含 ipStatsDir 与刷盘间隔
 * @returns 输出：`undefined | IpFetchStatsStore` — 未配置目录时为 undefined
 */
export function createIpFetchStatsStoreFromConfig(
  opts: FetchMetricsOptions = GeoClawConfig.get().getFetchMetricsOptions(),
): IpFetchStatsStore | undefined {
  const rel = opts.ipStatsDir?.trim();
  if (!rel) return undefined;

  const dirPath = GeoClawConfig.resolvePath(rel);
  const seedForHostname =
    opts.ipStatsSeedFromHostPin === false
      ? undefined
      : (hostname: string): ReadonlyArray<IpFetchStatsSeedIp> | undefined =>
          seedIpsForHostname(hostname);

  return new IpFetchStatsStore({
    dirPath,
    flushIntervalMs: opts.ipStatsFlushIntervalMs ?? 5_000,
    seedForHostname,
  });
}

/**
 * 从 HostPin YAML 预填某域名的 IP 地理种子。
 * @param hostname - 输入：`string` — 请求主机名
 * @returns 输出：`undefined | IpFetchStatsSeedIp[]` — 无对应 YAML 时为 undefined
 */
function seedIpsForHostname(hostname: string): IpFetchStatsSeedIp[] | undefined {
  const cfg = GeoClawConfig.get();
  const hostPin = cfg.getRaw().hostPin;
  const configDir = GeoClawConfig.resolvePath(hostPin.configDir ?? "config");
  const autoPath = join(configDir, `${hostname}.yaml`);
  let yamlPath: string | null = existsSync(autoPath) ? autoPath : null;
  if (!yamlPath) {
    const warm = cfg.getRaw().warmPool;
    const fallback = warm?.ipsFile ?? hostPin.ipsFile;
    if (hostname === hostPin.hostname && fallback) {
      yamlPath = GeoClawConfig.resolvePath(fallback);
    }
  }
  if (!yamlPath || !existsSync(yamlPath)) return undefined;
  return loadHostPinRecordsFromYaml(yamlPath, hostPin.family).map((r) => ({
    ip: r.ip,
    city: r.city,
    region: r.region,
    country: r.country,
    loc: r.loc,
  }));
}

export type { FetchMetricsOptions };
