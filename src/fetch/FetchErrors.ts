/** 热连接单次 GET 非 200 时抛出（任务应回队，不在此重试） */
export class HotFetchNotOkError extends Error {
  readonly status: number;
  readonly ip: string;

  /**
   * @param status - 输入：`number` — 非 200 的 HTTP 状态码
   * @param ip - 输入：`string` — 本次请求使用的热连接 IP
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
   * @param ip - 输入：`string` — 本次请求使用的热连接 IP
   * @param cause - 输入：`unknown` — 底层传输错误原因
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
   * @param ip - 输入：`string` — 超时的热连接 IP
   * @param cause - 输入：`unknown` — 可选超时细节
   */
  constructor(ip: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause != null ? String(cause) : "timeout";
    super(`timeout via hot IP ${ip}: ${detail}`);
    this.name = "HotFetchTimeoutError";
    this.ip = ip;
  }
}

/** 当前无可用热连接（任务应回队等待后台重加热） */
export class HotFetchNoHotIpError extends Error {
  /**
   * 无可用热连接时构造。
   */
  constructor() {
    super("HotConnectionPool: no hot connections available");
    this.name = "HotFetchNoHotIpError";
  }
}

/** 任务超过最大尝试次数 */
export class FetchTaskMaxAttemptsError extends Error {
  /**
   * @param url - 输入：`string` — 超限的完整 HTTP URL
   * @param attempts - 输入：`number` — 已达上限的尝试次数
   */
  constructor(url: string, attempts: number) {
    super(`FetchTaskPool: max attempts (${attempts}) exceeded for ${url}`);
    this.name = "FetchTaskMaxAttemptsError";
  }
}

/**
 * 判断错误是否应触发任务回队而非最终失败。
 * @param err - 输入：`unknown` — catch 到的错误对象
 * @returns 输出：`boolean` — 属于热连接可回队错误则 true
 */
export function isFetchRequeueError(err: unknown): boolean {
  return (
    err instanceof HotFetchNotOkError ||
    err instanceof HotFetchTransportError ||
    err instanceof HotFetchTimeoutError ||
    err instanceof HotFetchNoHotIpError
  );
}
