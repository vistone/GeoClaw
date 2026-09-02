/** 热连接单次 GET 非 200 时抛出（任务应回队，不在此重试） */
export class HotFetchNotOkError extends Error {
  readonly status: number;
  readonly ip: string;

  /**
   * 构造实例。
   * @param status - 输入：`number` — status 参数
   * @param ip - 输入：`string` — ip 参数
   * @returns 输出：`HotFetchNotOkError` — HotFetchNotOkError 实例
   */

  constructor(status: number, ip: string) {
    super(`HTTP ${status} via hot IP ${ip}`);
    this.name = "HotFetchNotOkError";
    this.status = status;
    this.ip = ip;
  }
}

/** 热连接传输层失败 */
export class HotFetchTransportError extends Error {
  readonly ip: string;

  /**
   * 构造实例。
   * @param ip - 输入：`string` — ip 参数
   * @param cause - 输入：`unknown` — cause 参数
   * @returns 输出：`HotFetchTransportError` — HotFetchTransportError 实例
   */

  constructor(ip: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "HotFetchTransportError";
    this.ip = ip;
  }
}

/**
 * 单次请求超时（非致命）：热连接保留，任务应回队换 IP，不计入错误踢池。
 */
export class HotFetchTimeoutError extends Error {
  readonly ip: string;

  /**
   * 构造实例。
   * @param ip - 输入：`string` — ip 参数
   * @param cause - 输入：`unknown` — cause 参数
   * @returns 输出：`HotFetchTimeoutError` — HotFetchTimeoutError 实例
   */constructor(ip: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause != null ? String(cause) : "timeout";
    super(`timeout via hot IP ${ip}: ${detail}`);
    this.name = "HotFetchTimeoutError";
    this.ip = ip;
  }
}

/** 当前无可用热连接（任务应回队等待后台重加热） */
export class HotFetchNoHotIpError extends Error {
  /**
   * 构造实例。
   * @returns 输出：`HotFetchNoHotIpError` — HotFetchNoHotIpError 实例
   */

  constructor() {
    super("HotConnectionPool: no hot connections available");
    this.name = "HotFetchNoHotIpError";
  }
}

/** 任务超过最大尝试次数 */
export class FetchTaskMaxAttemptsError extends Error {
  /**
   * 构造实例。
   * @param url - 输入：`string` — 完整 HTTP URL
   * @param attempts - 输入：`number` — attempts 参数
   * @returns 输出：`FetchTaskMaxAttemptsError` — FetchTaskMaxAttemptsError 实例
   */

  constructor(url: string, attempts: number) {
    super(`FetchTaskPool: max attempts (${attempts}) exceeded for ${url}`);
    this.name = "FetchTaskMaxAttemptsError";
  }
}

/**
 * 判断 FetchRequeueError。
 * @param err - 输入：`unknown` — 错误对象
 * @returns 输出：`boolean` — 条件成立返回 true，否则 false
 */
export function isFetchRequeueError(err: unknown): boolean {
  return (
    err instanceof HotFetchNotOkError ||
    err instanceof HotFetchTransportError ||
    err instanceof HotFetchTimeoutError ||
    err instanceof HotFetchNoHotIpError
  );
}
