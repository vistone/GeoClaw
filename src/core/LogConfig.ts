/** 日志级别（数值越小越详细） */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

let globalLogLevel: LogLevel = LogLevel.INFO;

/**
 * 设置全局日志级别（由 GeoClawConfig.load 调用）。
 * @param level - 输入：`LogLevel` — 日志级别
 * @returns 输出：无（`void`）
 */

export function setGlobalLogLevel(level: LogLevel): void {
  globalLogLevel = level;
}

/**
 * 读取全局日志级别。
 * @returns 输出：`LogLevel` — 当前级别
 */

export function getGlobalLogLevel(): LogLevel {
  return globalLogLevel;
}

/**
 * 从字符串解析日志级别。
 * @param raw - 输入：`string` — debug | info | warn | error | silent
 * @returns 输出：`LogLevel` — 日志级别枚举
 */

export function logLevelFromString(raw: string): LogLevel {
  switch (raw.toLowerCase()) {
    case "debug":
      return LogLevel.DEBUG;
    case "info":
      return LogLevel.INFO;
    case "warn":
      return LogLevel.WARN;
    case "error":
      return LogLevel.ERROR;
    case "silent":
      return LogLevel.SILENT;
    default:
      return LogLevel.INFO;
  }
}
