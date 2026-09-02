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
  private readonly byIp = new Map<string, IpGeoInfo>();

  /**
   * 构造实例。
   * @param records - 输入：`HostPinRecord[]` — records 参数
   * @returns 输出：`IpGeoRegistry` — IpGeoRegistry 实例
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
   * 执行 lookup。
   * @param ip - 输入：`string` — ip 参数
   * @returns 输出：`undefined | IpGeoInfo` — undefined | IpGeoInfo 实例
   */

  lookup(ip: string): IpGeoInfo | undefined {
    return this.byIp.get(ip);
  }

  /**
   * 执行 entries。
   * @returns 输出：`IterableIterator` — IterableIterator 实例
   */
  entries(): IterableIterator<[string, IpGeoInfo]> {
    return this.byIp.entries();
  }

  /**
   * 执行 size。
   * @returns 输出：`number` — 数值结果
   */

  size(): number {
    return this.byIp.size;
  }
}
