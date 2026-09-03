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
   * 按冷池状态码配置初始化。
   * @param options - 输入：`ColdConnectionPoolOptions` — 触发入池的 HTTP 状态码列表
   */
  constructor(options: ColdConnectionPoolOptions) {
    this.options = options;
  }

  /**
   * 判断 HTTP 状态码是否应入冷池。
   * @param status - 输入：`number` — HTTP 响应状态码
   * @returns 输出：`boolean` — 在 coldPoolStatuses 中则 true
   */
  shouldAdmit(status: number): boolean {
    return ColdConnectionPool.logger.measureSync(
      "shouldAdmit",
      () => this.options.coldPoolStatuses.includes(status),
      { status },
    );
  }

  /**
   * 将 IP 记入冷池并安排下次预热时间。
   * @param ip - 输入：`string` — 被拒绝的连接 IP
   * @param status - 输入：`undefined | number` — 触发入池的 HTTP 状态码
   * @param backoffMs - 输入：`number` — 距下次预热的退避毫秒
   * @returns 输出：无（`void`）
   */
  admit(ip: string, status: number | undefined, backoffMs: number): void {
    ColdConnectionPool.logger.measureSync(
      "admit",
      () => {
        const now = Date.now();
        this.records.set(ip, {
          ip,
          lastStatus: status,
          admittedAt: now,
          nextReheatAt: now + backoffMs,
        });
        ColdConnectionPool.logger.warn("IP 入冷池，暂停下载", { ip, status, backoffMs });
      },
      { ip, status, backoffMs },
    );
  }

  /**
   * 将 IP 移出冷池，恢复下载资格。
   * @param ip - 输入：`string` — 待释放的连接 IP
   * @returns 输出：无（`void`）
   */
  release(ip: string): void {
    ColdConnectionPool.logger.measureSync(
      "release",
      () => {
        if (this.records.delete(ip)) {
          ColdConnectionPool.logger.info("IP 离开冷池，可参与下载", { ip });
        }
      },
      { ip },
    );
  }

  /**
   * 判断 IP 是否仍在冷池中。
   * @param ip - 输入：`string` — 待查询的连接 IP
   * @returns 输出：`boolean` — 在池中则 true
   */
  isCold(ip: string): boolean {
    return this.records.has(ip);
  }

  /**
   * 返回当前冷池内 IP 数量。
   * @returns 输出：`number` — 冷池记录条数
   */
  getColdCount(): number {
    return this.records.size;
  }

  /**
   * 列出已到预热时间的冷池 IP。
   * @param now - 输入：`number` — 当前时间戳毫秒；默认 Date.now()
   * @returns 输出：`string[]` — nextReheatAt 已到期的 IP 列表
   */
  getDueForReheat(now: number = Date.now()): string[] {
    return ColdConnectionPool.logger.measureSync(
      "getDueForReheat",
      () => {
        const due: string[] = [];
        for (const record of this.records.values()) {
          if (record.nextReheatAt <= now) {
            due.push(record.ip);
          }
        }
        return due;
      },
      { now, coldCount: this.records.size },
    );
  }

  /**
   * 推迟已在冷池中的 IP 的下次预热时间。
   * @param ip - 输入：`string` — 冷池中的连接 IP
   * @param backoffMs - 输入：`number` — 距下次预热的退避毫秒
   * @returns 输出：无（`void`）
   */
  scheduleReheat(ip: string, backoffMs: number): void {
    ColdConnectionPool.logger.measureSync(
      "scheduleReheat",
      () => {
        const record = this.records.get(ip);
        if (!record) {
          return;
        }
        record.nextReheatAt = Date.now() + backoffMs;
      },
      { ip, backoffMs },
    );
  }

  /**
   * 确保 IP 在冷池中；已在则更新状态并推迟预热。
   * @param ip - 输入：`string` — 连接 IP
   * @param status - 输入：`undefined | number` — 最近 HTTP 状态码
   * @param backoffMs - 输入：`number` — 距下次预热的退避毫秒
   * @returns 输出：无（`void`）
   */
  ensureCold(ip: string, status: number | undefined, backoffMs: number): void {
    ColdConnectionPool.logger.measureSync(
      "ensureCold",
      () => {
        if (this.isCold(ip)) {
          const record = this.records.get(ip)!;
          record.lastStatus = status ?? record.lastStatus;
          this.scheduleReheat(ip, backoffMs);
          return;
        }
        this.admit(ip, status, backoffMs);
      },
      { ip, status, backoffMs },
    );
  }
}
