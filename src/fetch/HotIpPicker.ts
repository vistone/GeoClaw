/**
 * 热池 IP 公平选路：按 assignCount 均摊，同次数优先久未用。
 */

/** 选路候选 */
export type HotIpPickCandidate = {
  ip: string;
  lastUsedAt: number;
  assignCount: number;
};

/**
 * 按 assignCount 升序均摊选路；次数相同则选 lastUsedAt 更早者。
 * @param candidates - 输入：`readonly HotIpPickCandidate[]` — 可用热连接候选
 * @param _now - 输入：`number` — 当前时间戳（兼容旧签名，未参与排序）
 * @param _idleExpireMs - 输入：`number` — 空闲窗口（兼容旧签名，未参与排序）
 * @returns 输出：`undefined | string` — 选中的 IP；无候选时为 undefined
 */
export function pickFairHotIp(
  candidates: readonly HotIpPickCandidate[],
  _now = Date.now(),
  _idleExpireMs = 0,
): string | undefined {
  if (candidates.length === 0) return undefined;

  const sorted = [...candidates].sort((a, b) => {
    if (a.assignCount !== b.assignCount) return a.assignCount - b.assignCount;
    if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt - b.lastUsedAt;
    return a.ip.localeCompare(b.ip);
  });
  return sorted[0]?.ip;
}

/**
 * 兼容旧名：行为与 pickFairHotIp 相同。
 * @param candidates - 输入：`readonly object[]` — 含可选 assignCount 的候选
 * @param now - 输入：`number` — 当前时间戳
 * @param idleExpireMs - 输入：`number` — 空闲窗口毫秒
 * @returns 输出：`undefined | string` — 选中的 IP
 */
export function pickNearestExpiryHotIp(
  candidates: readonly { ip: string; lastUsedAt: number; assignCount?: number }[],
  now: number,
  idleExpireMs: number,
): string | undefined {
  return pickFairHotIp(
    candidates.map((c) => ({
      ip: c.ip,
      lastUsedAt: c.lastUsedAt,
      assignCount: c.assignCount ?? 0,
    })),
    now,
    idleExpireMs,
  );
}
