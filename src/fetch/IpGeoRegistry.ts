import { Logger } from "../core/Logger.js";
import type { HostPinRecord } from "./HostPinPool.js";

/** IP 地理信息（来自 kh.google.com.yaml） */
export type IpGeoInfo = {
  ip: string;
  city?: string;
  region?: string;
  country?: string;
  loc?: string;
  org?: string;
  timezone?: string;
};

/**
 * IP → 地区查询表；预热/下载统计时解析 IP 所属区域。
 */
export class IpGeoRegistry {
  private static readonly logger = new Logger("IpGeoRegistry");
  private readonly byIp = new Map<string, IpGeoInfo>();

  /**
   * 由 HostPin 记录构建 IP 地理索引。
   * @param records - 输入：`HostPinRecord[]` — HostPin YAML 解析出的 IP 记录
   */
  constructor(records: readonly HostPinRecord[]) {
    for (const record of records) {
      this.byIp.set(record.ip, {
        ip: record.ip,
        city: record.city,
        region: record.region,
        country: record.country,
        loc: record.loc,
        org: record.org,
        timezone: record.timezone,
      });
    }
  }

  /**
   * 按 IP 查询地理信息。
   * @param ip - 输入：`string` — 待查询的 IP 地址
   * @returns 输出：`undefined | IpGeoInfo` — 命中则返回城市、国家、loc
   */
  lookup(ip: string): IpGeoInfo | undefined {
    return IpGeoRegistry.logger.measureSync(
      "lookup",
      () => this.byIp.get(ip),
      { ip },
    );
  }

  /**
   * 迭代全部 IP 与地理信息条目。
   * @returns 输出：`IterableIterator<[string, IpGeoInfo]>` — [ip, info] 迭代器
   */
  entries(): IterableIterator<[string, IpGeoInfo]> {
    return this.byIp.entries();
  }

  /**
   * 返回已索引的 IP 数量。
   * @returns 输出：`number` — 表中 IP 条数
   */
  size(): number {
    return this.byIp.size;
  }
}
