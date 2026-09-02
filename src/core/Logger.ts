/**
 * 统一日志对象：区分 debug / info / warn / error。
 * 级别来自 config/geoclaw.yaml 的 log.level（经 LogConfig 同步）。
 */

import {
  getGlobalLogLevel,
  LogLevel,
  logLevelFromString,
} from "./LogConfig.js";

export { LogLevel, logLevelFromString } from "./LogConfig.js";

const LEVEL_LABEL: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARN]: "WARN",
  [LogLevel.ERROR]: "ERROR",
  [LogLevel.SILENT]: "SILENT",
};

/**
 * 读取当前全局日志级别（来自 YAML log.level）。
 * @returns 输出：`LogLevel` — 日志级别
 */

export function logLevelFromConfig(): LogLevel {
  return getGlobalLogLevel();
}

/**
 * @deprecated 使用 logLevelFromConfig
 * @returns 输出：`LogLevel` — 日志级别
 */

export function logLevelFromEnv(): LogLevel {
  return logLevelFromConfig();
}

/**
 * 作用域日志器：每个类持有一个实例，scope 通常为类名。
 */
export class Logger {
  private readonly minLevel: LogLevel;

  /**
   * 构造实例。
   * @param scope - 输入：`string` — 日志作用域
   * @param minLevel - 输入：`undefined | DEBUG | INFO | …` — 最低日志级别
   * @returns 输出：`Logger` — Logger 实例
   */

  constructor(
    private readonly scope: string,
    minLevel?: LogLevel,
  ) {
    this.minLevel = minLevel ?? logLevelFromConfig();
  }

  /**
   * 输出 DEBUG 日志。
   * @param message - 输入：`string` — 日志消息
   * @param data - 输入：`unknown` — 附加数据
   * @returns 输出：无（`void`）
   */

  debug(message: string, data?: unknown): void {
    this.write(LogLevel.DEBUG, message, data);
  }

  /**
   * 输出 INFO 日志。
   * @param message - 输入：`string` — 日志消息
   * @param data - 输入：`unknown` — 附加数据
   * @returns 输出：无（`void`）
   */

  info(message: string, data?: unknown): void {
    this.write(LogLevel.INFO, message, data);
  }

  /**
   * 输出 WARN 日志。
   * @param message - 输入：`string` — 日志消息
   * @param data - 输入：`unknown` — 附加数据
   * @returns 输出：无（`void`）
   */

  warn(message: string, data?: unknown): void {
    this.write(LogLevel.WARN, message, data);
  }

  /**
   * 输出 ERROR 日志。
   * @param message - 输入：`string` — 日志消息
   * @param err - 输入：`unknown` — 错误对象
   * @returns 输出：无（`void`）
   */

  error(message: string, err?: unknown): void {
    this.write(LogLevel.ERROR, message, err);
  }

  /**
   * DEBUG 模式下测量同步函数耗时（非 DEBUG 零开销直通）。
   * @param operation - 输入：`string` — 操作名（通常为方法名）
   * @param fn - 输入：`() => T` — 待测量函数
   * @param context - 输入：`Record<string, unknown>` — 可选附加上下文
   * @returns 输出：`T` — fn 的返回值
   */

  measureSync<T>(
    operation: string,
    fn: () => T,
    context?: Record<string, unknown>,
  ): T {
    if (this.minLevel > LogLevel.DEBUG) {
      return fn();
    }
    const start = performance.now();
    try {
      const result = fn();
      this.logDuration(operation, performance.now() - start, context);
      return result;
    } catch (err) {
      this.logDuration(operation, performance.now() - start, { ...context, failed: true });
      throw err;
    }
  }

  /**
   * DEBUG 模式下测量异步函数耗时（非 DEBUG 零开销直通）。
   * @param operation - 输入：`string` — 操作名（通常为方法名）
   * @param fn - 输入：`() => Promise<T>` — 待测量异步函数
   * @param context - 输入：`Record<string, unknown>` — 可选附加上下文
   * @returns 输出：`Promise<T>` — fn 的 Promise 结果
   */

  measureAsync<T>(
    operation: string,
    fn: () => Promise<T>,
    context?: Record<string, unknown>,
  ): Promise<T> {
    if (this.minLevel > LogLevel.DEBUG) {
      return fn();
    }
    const start = performance.now();
    return fn().then(
      (result) => {
        this.logDuration(operation, performance.now() - start, context);
        return result;
      },
      (err: unknown) => {
        this.logDuration(operation, performance.now() - start, { ...context, failed: true });
        throw err;
      },
    );
  }

  /**
   * 记录 DEBUG 耗时日志。
   * @param operation - 操作名
   * @param durationMs - 耗时毫秒
   * @param context - 附加上下文
   * @returns 输出：无（`void`）
   */

  private logDuration(
    operation: string,
    durationMs: number,
    context?: Record<string, unknown>,
  ): void {
    this.write(LogLevel.DEBUG, `耗时 ${operation}`, {
      durationMs: Math.round(durationMs * 1000) / 1000,
      ...context,
    });
  }

  /**
   * 内部写日志。
   * @param level - 本条日志级别
   * @param message - 消息
   * @param data - 附加数据
   */
  private write(level: LogLevel, message: string, data?: unknown): void {
    if (level < this.minLevel || this.minLevel === LogLevel.SILENT) {
      return;
    }
    const prefix = `[${LEVEL_LABEL[level]}] [${this.scope}] ${message}`;
    if (level === LogLevel.ERROR) {
      if (data !== undefined) {
        console.error(prefix, data);
      } else {
        console.error(prefix);
      }
      return;
    }
    if (level === LogLevel.WARN) {
      if (data !== undefined) {
        console.warn(prefix, data);
      } else {
        console.warn(prefix);
      }
      return;
    }
    if (data !== undefined) {
      console.log(prefix, data);
    } else {
      console.log(prefix);
    }
  }
}
