import { existsSync } from "node:fs";
import { join } from "node:path";

import { GeoClawConfig } from "../core/GeoClawConfig.js";
import { FetchMetrics, type FetchMetricsOptions } from "./FetchMetrics.js";
import { loadHostPinRecordsFromYaml } from "./HostPinPool.js";
import { IpFetchStatsStore, type IpFetchStatsSeedIp } from "./IpFetchStatsStore.js";
import { IpGeoRegistry } from "./IpGeoRegistry.js";

/**
 * 创建 FetchMetricsFromConfig。
 * @returns 输出：`undefined | FetchMetrics` — undefined | FetchMetrics 实例
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
 * 执行 buildIpGeoRegistryFromConfig。
 * @returns 输出：`IpGeoRegistry` — IpGeoRegistry 实例
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
 * 创建 IpFetchStatsStoreFromConfig。
 * @param opts - 输入：`FetchMetricsOptions` — opts 参数
 * @returns 输出：`undefined | IpFetchStatsStore` — undefined | IpFetchStatsStore 实例
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
 * 执行 seedIpsForHostname。
 * @param hostname - 输入：`string` — hostname 参数
 * @returns 输出：`undefined | IpFetchStatsSeedIp[]` — undefined | IpFetchStatsSeedIp[] 实例
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
