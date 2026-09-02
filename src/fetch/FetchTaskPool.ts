import type { RequestTimings } from "node-wreq";
import type { Client } from "node-wreq";

import { Logger } from "../core/Logger.js";
import {
  FetchTaskMaxAttemptsError,
  HotFetchNoHotIpError,
  HotFetchNotOkError,
  HotFetchTimeoutError,
  HotFetchTransportError,
  isFetchRequeueError,
} from "./FetchErrors.js";
import type { FetchMetrics } from "./FetchMetrics.js";
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
  requestId: string;
  response: Awaited<ReturnType<Client["get"]>>;
  ip: string;
  timings?: RequestTimings;
};

type PendingTask = {
  requestId: string;
  url: string;
  headers: Record<string, string>;
  attempts: number;
  lastIp?: string;
  lastStatus?: number;
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
  private readonly metrics?: FetchMetrics;
  private readonly queue: PendingTask[] = [];
  private activeWorkers = 0;

  /**
   * 构造实例。
   * @param hotPool - 输入：`HotConnectionPool` — hotPool 参数
   * @param options - 输入：`FetchTaskPoolOptions` — 配置选项
   * @param metrics - 输入：`undefined | FetchMetrics` — metrics 参数
   * @returns 输出：`FetchTaskPool` — FetchTaskPool 实例
   */

  constructor(
    hotPool: HotConnectionPool,
    options: FetchTaskPoolOptions,
    metrics?: FetchMetrics,
  ) {
    this.hotPool = hotPool;
    this.options = options;
    this.metrics = metrics;
  }

  /**
   * 执行 submit。
   * @param url - 输入：`string` — 完整 HTTP URL
   * @param headers - 输入：`Record<string, string>` — headers 参数
   * @param requestId - 输入：`undefined | string` — requestId 参数
   * @returns 输出：`Promise<FetchTaskResult>` — 异步返回 FetchTaskResult
   */

  submit(
    url: string,
    headers: Record<string, string> = {},
    requestId?: string,
  ): Promise<FetchTaskResult> {
    const rid = requestId ?? this.metrics?.createRequestId() ?? cryptoRandomId();
    this.metrics?.onRequestStart(rid, url);

    return new Promise((resolve, reject) => {
      this.queue.push({
        requestId: rid,
        url,
        headers,
        attempts: 0,
        resolve: (result) => resolve({ ...result, requestId: rid }),
        reject,
      });
      this.pump();
    });
  }

  /**
   * 执行 pendingCount。
   * @returns 输出：`number` — 数值结果
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
      this.metrics?.onRequestFailed(task.requestId, task.lastIp, task.lastStatus);
      task.reject(new FetchTaskMaxAttemptsError(task.url, this.options.maxAttempts));
      return;
    }

    const started = Date.now();
    try {
      const result = await this.hotPool.fetchOnce(task.url, task.headers);
      const durationMs = durationFromTimings(result.timings, started);
      this.metrics?.onAttempt(
        task.requestId,
        task.url,
        task.attempts,
        result.ip,
        { kind: "success", httpStatus: result.response.status },
        durationMs,
      );
      this.metrics?.onRequestSuccess(
        task.requestId,
        result.ip,
        result.response.status,
        0,
      );
      task.resolve({
        requestId: task.requestId,
        response: result.response,
        ip: result.ip,
        timings: result.timings,
      });
    } catch (err) {
      const durationMs = Date.now() - started;
      if (err instanceof HotFetchTimeoutError) {
        // 超时不是错误：不记失败指标、不烧 attempts，直接回队换 IP
        task.attempts = Math.max(0, task.attempts - 1);
        task.lastIp = err.ip;
        FetchTaskPool.logger.debug("请求超时，任务回队换 IP", {
          url: task.url,
          ip: err.ip,
          durationMs,
        });
        this.queue.push(task);
        return;
      }
      if (err instanceof HotFetchNotOkError) {
        task.lastIp = err.ip;
        task.lastStatus = err.status;
        this.metrics?.onAttempt(
          task.requestId,
          task.url,
          task.attempts,
          err.ip,
          { kind: "http_error", httpStatus: err.status },
          durationMs,
        );
      } else if (err instanceof HotFetchTransportError) {
        task.lastIp = err.ip;
        this.metrics?.onAttempt(
          task.requestId,
          task.url,
          task.attempts,
          err.ip,
          { kind: "transport_error" },
          durationMs,
        );
      } else if (err instanceof HotFetchNoHotIpError) {
        this.metrics?.onAttempt(
          task.requestId,
          task.url,
          task.attempts,
          undefined,
          { kind: "no_hot_ip" },
          durationMs,
        );
      }

      if (isFetchRequeueError(err)) {
        FetchTaskPool.logger.debug("任务快速失败，回队", {
          url: task.url,
          attempts: task.attempts,
          error: err instanceof Error ? err.message : String(err),
        });
        this.queue.push(task);
        return;
      }

      this.metrics?.onRequestFailed(task.requestId, task.lastIp, task.lastStatus);
      task.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/**
 * 执行 durationFromTimings。
 * @param timings - 输入：`undefined | RequestTimings` — timings 参数
 * @param fallbackStart - 输入：`number` — fallbackStart 参数
 * @returns 输出：`number` — 数值结果
 */
function durationFromTimings(
  timings: RequestTimings | undefined,
  fallbackStart: number,
): number {
  // 优先 wait：远程首字节 RTT，不含 body 下载
  if (timings?.wait !== undefined) {
    return Math.round(timings.wait);
  }
  if (timings?.total !== undefined) {
    return Math.round(timings.total);
  }
  return Date.now() - fallbackStart;
}

/**
 * 执行 cryptoRandomId。
 * @returns 输出：`string` — 字符串结果
 */
function cryptoRandomId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
