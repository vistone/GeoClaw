/**
 * 热池 IP 公平选路：按 assignCount 均摊；可选暖连接偏好（不永久闲置慢/冷 IP）。
 */

/** 选路候选 */
export type HotIpPickCandidate = {
  ip: string;
  lastUsedAt: number;
  assignCount: number;
};

/** pickFairHotIp 附加选项 */
export type PickFairHotIpOptions = {
  /**
   * 允许领先的 assignCount 差。
   * 0：旧行为（同次数优先最久未用）。
   * >0：在 [min, min+slack] 带内优先最近用过（复用热 TCP），落后的仍会因 assignCount 被补上。
   */
  warmSlack?: number;
};

/**
 * 按 assignCount 均摊选路。
 * @param candidates - 输入：`readonly HotIpPickCandidate[]` — 可用热连接候选
 * @param _now - 输入：`number` — 当前时间戳（兼容旧签名，未参与排序）
 * @param _idleExpireMs - 输入：`number` — 空闲窗口（兼容旧签名，未参与排序）
 * @param options - 输入：`undefined | PickFairHotIpOptions` — warmSlack 选项
 * @returns 输出：`undefined | string` — 选中的 IP；无候选时为 undefined
 */
export function pickFairHotIp(
  candidates: readonly HotIpPickCandidate[],
  _now = Date.now(),
  _idleExpireMs = 0,
  options?: PickFairHotIpOptions,
): string | undefined {
  if (candidates.length === 0) return undefined;

  const warmSlack = Math.max(0, Math.floor(options?.warmSlack ?? 0));
  if (warmSlack <= 0) {
    const sorted = [...candidates].sort((a, b) => {
      if (a.assignCount !== b.assignCount) return a.assignCount - b.assignCount;
      if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt - b.lastUsedAt;
      return a.ip.localeCompare(b.ip);
    });
    return sorted[0]?.ip;
  }

  let minCount = candidates[0]!.assignCount;
  for (const c of candidates) {
    if (c.assignCount < minCount) minCount = c.assignCount;
  }
  const band = candidates.filter((c) => c.assignCount <= minCount + warmSlack);
  const pool = band.length > 0 ? band : candidates;
  // 带内：仍先补落后（低 assignCount），同次数优先最近用过 → 复用热连接
  const sorted = [...pool].sort((a, b) => {
    if (a.assignCount !== b.assignCount) return a.assignCount - b.assignCount;
    if (a.lastUsedAt !== b.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
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
