/** 热连接单次 GET 非 200 时抛出（任务应回队，不在此重试） */
export class HotFetchNotOkError extends Error {
  readonly status: number;
  readonly ip: string;

  /**
   * @param status - 输入：`number` — HTTP 状态码
   * @param ip - 输入：`string` — 使用的 IP
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
   * @param ip - 输入：`string` — 使用的 IP
   * @param cause - 输入：`unknown` — 原始错误
   */

  constructor(ip: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "HotFetchTransportError";
    this.ip = ip;
  }
}

/** 当前无可用热连接（任务应回队等待后台重加热） */
export class HotFetchNoHotIpError extends Error {
  /**
   * @returns 输出：`HotFetchNoHotIpError` — 错误实例
   */

  constructor() {
    super("HotConnectionPool: no hot connections available");
    this.name = "HotFetchNoHotIpError";
  }
}

/** 任务超过最大尝试次数 */
export class FetchTaskMaxAttemptsError extends Error {
  /**
   * @param url - 输入：`string` — 请求 URL
   * @param attempts - 输入：`number` — 上限次数
   * @returns 输出：`FetchTaskMaxAttemptsError` — 错误实例
   */

  constructor(url: string, attempts: number) {
    super(`FetchTaskPool: max attempts (${attempts}) exceeded for ${url}`);
    this.name = "FetchTaskMaxAttemptsError";
  }
}

/**
 * 可重新入队的 fetch 失败（非 200 / 无热 IP / 传输错误）。
 * @param err - 输入：`unknown` — 捕获的错误
 * @returns 输出：`boolean` — true 表示应回队
 */
export function isFetchRequeueError(err: unknown): boolean {
  return (
    err instanceof HotFetchNotOkError ||
    err instanceof HotFetchTransportError ||
    err instanceof HotFetchNoHotIpError
  );
}
