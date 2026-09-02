import type { RequestTimings } from "node-wreq";
import type { Client } from "node-wreq";

import { Logger } from "../core/Logger.js";
import {
  FetchTaskMaxAttemptsError,
  HotFetchNoHotIpError,
  HotFetchNotOkError,
  HotFetchTransportError,
  isFetchRequeueError,
} from "./FetchErrors.js";
import type { HotConnectionPool } from "./HotConnectionPool.js";

/** 任务池配置 */
export type FetchTaskPoolOptions = {
  /** 并发 worker 数 */
  concurrency: number;
  /** 单任务最大尝试次数；null 表示不限 */
  maxAttempts: number | null;
};

/** 任务成功结果 */
export type FetchTaskResult = {
  response: Awaited<ReturnType<Client["get"]>>;
  ip: string;
  timings?: RequestTimings;
};

type PendingTask = {
  url: string;
  headers: Record<string, string>;
  attempts: number;
  resolve: (value: FetchTaskResult) => void;
  reject: (reason: Error) => void;
};

/**
 * 非阻塞 fetch 任务池：非 200 立即放弃当前尝试，任务回队，worker 不等待、不换 IP 同步重试。
 */
export class FetchTaskPool {
  private static readonly logger = new Logger("FetchTaskPool");
  private readonly hotPool: HotConnectionPool;
  private readonly options: FetchTaskPoolOptions;
  private readonly queue: PendingTask[] = [];
  private activeWorkers = 0;

  /**
   * @param hotPool - 输入：`HotConnectionPool` — 热连接池
   * @param options - 输入：`FetchTaskPoolOptions` — 并发与最大尝试次数
   */

  constructor(hotPool: HotConnectionPool, options: FetchTaskPoolOptions) {
    this.hotPool = hotPool;
    this.options = options;
  }

  /**
   * 提交 GET 任务；仅 HTTP 200 时 resolve，否则在池内异步重试。
   * @param url - 输入：`string` — 完整 URL
   * @param headers - 输入：`Record<string, string>` — 请求头
   * @returns 输出：`Promise<FetchTaskResult>` — 成功响应
   * @throws {FetchTaskMaxAttemptsError} 超过 maxAttempts 时
   */

  submit(url: string, headers: Record<string, string> = {}): Promise<FetchTaskResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        url,
        headers,
        attempts: 0,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  /**
   * 待处理任务数（含正在执行）。
   * @returns 输出：`number` — 队列长度 + activeWorkers
   */

  pendingCount(): number {
    return this.queue.length + this.activeWorkers;
  }

  /**
   * 启动 worker 消费队列。
   * @returns 输出：无（`void`）
   */

  private pump(): void {
    while (this.activeWorkers < this.options.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.activeWorkers++;
      void this.runTask(task).finally(() => {
        this.activeWorkers--;
        this.pump();
      });
    }
  }

  /**
   * 执行单次任务尝试；失败则立即回队。
   * @param task - 输入：`PendingTask` — 待执行任务
   * @returns 输出：`Promise<void>`
   */

  private async runTask(task: PendingTask): Promise<void> {
    task.attempts++;

    if (
      this.options.maxAttempts !== null &&
      task.attempts > this.options.maxAttempts
    ) {
      task.reject(new FetchTaskMaxAttemptsError(task.url, this.options.maxAttempts));
      return;
    }

    try {
      const result = await this.hotPool.fetchOnce(task.url, task.headers);
      task.resolve(result);
    } catch (err) {
      if (isFetchRequeueError(err)) {
        FetchTaskPool.logger.debug("任务快速失败，回队", {
          url: task.url,
          attempts: task.attempts,
          error: err instanceof Error ? err.message : String(err),
        });
        this.queue.push(task);
        return;
      }
      task.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
