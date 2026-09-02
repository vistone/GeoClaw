import { Logger } from "../core/Logger.js";

/** 冷池中单 IP 记录 */
export type ColdIpRecord = {
  ip: string;
  lastStatus?: number;
  admittedAt: number;
  nextReheatAt: number;
};

/** 冷连接池选项 */
export type ColdConnectionPoolOptions = {
  /** 触发入冷池的 HTTP 状态（如 403、429） */
  coldPoolStatuses: readonly number[];
};

/**
 * 冷连接池：下载中遭拒绝的 IP 暂存于此，不参与下载，直至预热 HTTP 200 后释放。
 */
export class ColdConnectionPool {
  private static readonly logger = new Logger("ColdConnectionPool");
  private readonly options: ColdConnectionPoolOptions;
  private readonly records = new Map<string, ColdIpRecord>();

  /**
   * 构造实例。
   * @param options - 输入：`ColdConnectionPoolOptions` — 配置选项
   * @returns 输出：`ColdConnectionPool` — ColdConnectionPool 实例
   */

  constructor(options: ColdConnectionPoolOptions) {
    this.options = options;
  }

  /**
   * 执行 shouldAdmit。
   * @param status - 输入：`number` — status 参数
   * @returns 输出：`boolean` — 布尔结果
   */

  shouldAdmit(status: number): boolean {
    return this.options.coldPoolStatuses.includes(status);
  }

  /**
   * 执行 admit。
   * @param ip - 输入：`string` — ip 参数
   * @param status - 输入：`undefined | number` — status 参数
   * @param backoffMs - 输入：`number` — backoffMs 参数
   * @returns 输出：无（`void`）
   */

  admit(ip: string, status: number | undefined, backoffMs: number): void {
    const now = Date.now();
    this.records.set(ip, {
      ip,
      lastStatus: status,
      admittedAt: now,
      nextReheatAt: now + backoffMs,
    });
    ColdConnectionPool.logger.warn("IP 入冷池，暂停下载", { ip, status, backoffMs });
  }

  /**
   * 执行 release。
   * @param ip - 输入：`string` — ip 参数
   * @returns 输出：无（`void`）
   */

  release(ip: string): void {
    if (this.records.delete(ip)) {
      ColdConnectionPool.logger.info("IP 离开冷池，可参与下载", { ip });
    }
  }

  /**
   * 判断 Cold。
   * @param ip - 输入：`string` — ip 参数
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */

  isCold(ip: string): boolean {
    return this.records.has(ip);
  }

  /**
   * 获取 ColdCount。
   * @returns 输出：`number` — 数值结果
   */

  getColdCount(): number {
    return this.records.size;
  }

  /**
   * 获取 DueForReheat。
   * @param now - 输入：`number` — now 参数
   * @returns 输出：`string[]` — string[] 实例
   */

  getDueForReheat(now: number = Date.now()): string[] {
    const due: string[] = [];
    for (const record of this.records.values()) {
      if (record.nextReheatAt <= now) {
        due.push(record.ip);
      }
    }
    return due;
  }

  /**
   * 执行 scheduleReheat。
   * @param ip - 输入：`string` — ip 参数
   * @param backoffMs - 输入：`number` — backoffMs 参数
   * @returns 输出：无（`void`）
   */

  scheduleReheat(ip: string, backoffMs: number): void {
    const record = this.records.get(ip);
    if (!record) {
      return;
    }
    record.nextReheatAt = Date.now() + backoffMs;
  }

  /**
   * 执行 ensureCold。
   * @param ip - 输入：`string` — ip 参数
   * @param status - 输入：`undefined | number` — status 参数
   * @param backoffMs - 输入：`number` — backoffMs 参数
   * @returns 输出：无（`void`）
   */

  ensureCold(ip: string, status: number | undefined, backoffMs: number): void {
    if (this.isCold(ip)) {
      const record = this.records.get(ip)!;
      record.lastStatus = status ?? record.lastStatus;
      this.scheduleReheat(ip, backoffMs);
      return;
    }
    this.admit(ip, status, backoffMs);
  }
}
