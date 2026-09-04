#!/usr/bin/env tsx
/**
 * 热路径压测客户端（测试工具）。
 *
 * 必须先启动 `npm run flight:map`：本脚本只向其 POST /api/stress，
 * 请求在主服务进程内跑，8765 地图才会亮线 / 涨统计。
 *
 * 默认策略：低并发 + 完成即补位（高频泵），全池公平；勿用超大并发堵死慢 IP 槽位。
 *
 * 用法：
 *   npm run stress:hot
 *   npm run stress:hot -- --concurrency 64 --total 100000
 *   npm run stress:hot -- --concurrency 32 --total 10000
 *   npm run stress:hot -- --url https://kh.google.com/rt/earth/PlanetoidMetadata
 *   npm run stress:hot -- --base http://127.0.0.1:8765
 *   npm run stress:hot -- --wait-hot
 */
import { WebSocket } from "ws";
import { GeoClawConfig } from "../src/core/GeoClawConfig.js";

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

function argFlag(name: string): boolean {
  return process.argv.includes(name);
}

const cfg = GeoClawConfig.get();
const stress = cfg.getStressTestOptions();
const mapCfg = cfg.getFlightMapConfig();
const planetoid = cfg.getPlanetoidMetadataUrl();

const listenHost = mapCfg.host === "0.0.0.0" || mapCfg.host === "::" ? "127.0.0.1" : mapCfg.host;
const base =
  (argValue("--base") ?? `http://${listenHost}:${mapCfg.port}`).replace(/\/$/, "");
const url = argValue("--url") ?? stress.url ?? mapCfg.demoFetchUrl ?? planetoid;
const concurrency = Math.max(
  1,
  Number(argValue("--concurrency") ?? stress.concurrency) || stress.concurrency,
);
const total = Math.max(1, Number(argValue("--total") ?? stress.total) || stress.total);
const waitHot = argFlag("--wait-hot") || stress.waitHot;

console.log("=== GeoClaw 热路径压测（经 flight:map）===");
console.log("配置:", cfg.getConfigPath());
console.log("服务:", base);
console.log("URL:", url);
console.log("并发:", concurrency, "· 总数:", total);
console.log("说明: 请先开 flight:map；本脚本只触发 /api/stress，地图才会动");
console.log("");

async function fetchJson(pathname: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${pathname}`, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: res.status, body };
}

try {
  const health = await fetchJson("/api/hot-ips");
  if (health.status >= 400) {
    console.error("无法连接 flight:map。请先运行: npm run flight:map");
    console.error(health.body);
    process.exit(1);
  }
} catch (err) {
  console.error("无法连接 flight:map。请先运行: npm run flight:map");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

if (waitHot) {
  const deadline = Date.now() + Math.max(5_000, stress.waitHotMs);
  while (Date.now() < deadline) {
    const { body } = await fetchJson("/api/hot-ips");
    const stats = (body as { stats?: { hot?: number } } | null)?.stats;
    const hot = stats?.hot ?? (body as { hotIps?: unknown[] })?.hotIps?.length ?? 0;
    process.stdout.write(`\r等待热连接… hot=${hot}   `);
    if (hot > 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  process.stdout.write("\n");
  const again = await fetchJson("/api/hot-ips");
  const hot =
    (again.body as { stats?: { hot?: number } } | null)?.stats?.hot ??
    (again.body as { hotIps?: unknown[] })?.hotIps?.length ??
    0;
  if (hot === 0) {
    console.error("超时仍无热连接，退出");
    process.exit(1);
  }
}

const wsUrl = base.replace(/^http/, "ws") + "/ws";

const result = await new Promise<{ ok: boolean; summary?: Record<string, unknown>; error?: string }>(
  async (resolve) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      resolve({ ok: false, error: "等待压测结果超时" });
    }, Math.max(60_000, stress.waitHotMs + 600_000));

    const finish = (value: { ok: boolean; summary?: Record<string, unknown>; error?: string }) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(value);
    };

    ws.on("error", (err) => {
      finish({ ok: false, error: err.message });
    });

    await new Promise<void>((openResolve, openReject) => {
      ws.once("open", () => openResolve());
      ws.once("error", (err) => openReject(err));
    }).catch((err) => {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });

    if (ws.readyState !== WebSocket.OPEN) return;

    ws.on("message", (data) => {
      let msg: { type?: string; status?: string; error?: string; ok?: boolean; [k: string]: unknown };
      try {
        msg = JSON.parse(String(data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === "stressStatus" && msg.status === "running") {
        const doneN = Number(msg.done ?? 0);
        const tot = Number(msg.total ?? total);
        console.log(
          `进度 ${doneN}/${tot} · 成 ${msg.succeeded ?? "?"} / 败 ${msg.failed ?? "?"} · 热池 ${msg.hotCount ?? "?"} · ${Math.round(Number(msg.elapsedMs ?? 0) / 1000)}s`,
        );
      }
      if (msg.type === "stressStatus" && msg.status === "done") {
        finish({ ok: true, summary: msg });
      }
      if (msg.type === "stressResult") {
        if (msg.ok === false) finish({ ok: false, error: String(msg.error ?? "压测失败") });
        else finish({ ok: true, summary: msg });
      }
    });

    const start = await fetchJson("/api/stress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, concurrency, total }),
    });

    if (start.status === 409) {
      finish({ ok: false, error: "压测已在进行中（服务端）" });
      return;
    }
    if (start.status !== 202) {
      finish({
        ok: false,
        error: `启动压测失败: ${start.status} ${JSON.stringify(start.body)}`,
      });
      return;
    }

    console.log("已提交压测 → 请看浏览器地图:", `http://${listenHost}:${mapCfg.port}`);
  },
);

if (!result.ok) {
  console.error("压测失败:", result.error ?? result.summary);
  process.exit(1);
}
console.log("压测结束:", result.summary);
process.exit(0);
