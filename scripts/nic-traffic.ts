/**
 * Linux 网卡流量采样（/proc/net/dev + 默认路由）。
 * 仅供 flight-map 服务使用。
 */

import { readFileSync } from "node:fs";

export type NicSample = {
  iface: string;
  rxBytes: number;
  txBytes: number;
  rxBps: number;
  txBps: number;
  ts: number;
};

/**
 * 从 /proc/net/route 文本解析默认路由网卡名。
 * @param text - 输入：`string` — route 文件全文
 * @returns 输出：`string | null` — 网卡名；无默认路由为 null
 */
export function parseDefaultRouteIface(text: string): string | null {
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i]!.trim().split(/\s+/);
    if (parts.length < 2) continue;
    if (parts[1] === "00000000") return parts[0]!;
  }
  return null;
}

/**
 * 从 /proc/net/dev 文本读取指定网卡累计字节。
 * @param text - 输入：`string` — net/dev 文件全文
 * @param iface - 输入：`string` — 网卡名
 * @returns 输出：`null | { rxBytes: number; txBytes: number }` — 收发累计字节
 */
export function parseProcNetDev(
  text: string,
  iface: string,
): { rxBytes: number; txBytes: number } | null {
  const want = iface.trim();
  if (!want) return null;
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (name !== want) continue;
    const cols = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/);
    // Receive bytes=0, Transmit bytes=8
    if (cols.length < 9) return null;
    const rxBytes = Number(cols[0]);
    const txBytes = Number(cols[8]);
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) return null;
    return { rxBytes, txBytes };
  }
  return null;
}

/**
 * 解析本机默认路由网卡；preferred 非空时优先使用。
 * @param preferred - 输入：`string | null | undefined` — YAML 指定网卡；空则自动
 * @returns 输出：`string | null` — 网卡名
 */
export function resolveNicIface(preferred?: string | null): string | null {
  const forced = preferred?.trim();
  if (forced) return forced;
  try {
    const route = readFileSync("/proc/net/route", "utf8");
    return parseDefaultRouteIface(route);
  } catch {
    return null;
  }
}

/**
 * 读取指定网卡当前累计收发字节。
 * @param iface - 输入：`string` — 网卡名
 * @returns 输出：`null | { rxBytes: number; txBytes: number; ts: number }` — 计数与时间戳
 */
export function readNicCounters(
  iface: string,
): { rxBytes: number; txBytes: number; ts: number } | null {
  try {
    const text = readFileSync("/proc/net/dev", "utf8");
    const parsed = parseProcNetDev(text, iface);
    if (!parsed) return null;
    return { ...parsed, ts: Date.now() };
  } catch {
    return null;
  }
}

/**
 * 周期性差分采样网卡速率。
 */
export class NicTrafficSampler {
  private iface: string | null = null;
  private prev: { rxBytes: number; txBytes: number; ts: number } | null = null;

  /**
   * @param preferredIface - 输入：`string | null | undefined` — 固定网卡；空则每次解析默认路由
   */
  constructor(private readonly preferredIface?: string | null) {}

  /**
   * 采样一次；首次仅建基线，速率为 0。
   * @returns 输出：`NicSample | null` — 样本；无法读取为 null
   */
  sample(): NicSample | null {
    const iface = resolveNicIface(this.preferredIface);
    if (!iface) return null;
    if (this.iface && this.iface !== iface) this.prev = null;
    this.iface = iface;
    const cur = readNicCounters(iface);
    if (!cur) return null;
    let rxBps = 0;
    let txBps = 0;
    if (this.prev) {
      const dtSec = (cur.ts - this.prev.ts) / 1000;
      if (dtSec > 0) {
        rxBps = Math.max(0, (cur.rxBytes - this.prev.rxBytes) / dtSec);
        txBps = Math.max(0, (cur.txBytes - this.prev.txBytes) / dtSec);
      }
    }
    this.prev = cur;
    return {
      iface,
      rxBytes: cur.rxBytes,
      txBytes: cur.txBytes,
      rxBps,
      txBps,
      ts: cur.ts,
    };
  }
}
