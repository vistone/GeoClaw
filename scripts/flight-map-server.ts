#!/usr/bin/env tsx
/**
 * GeoJSON 飞行路线可视化服务（Leaflet + Bing Maps + WebSocket）。
 * 直接按热连接池存活 IP 绘制航线；数据经 WS 推送，有变化才下发。
 *
 * 用法：
 *   npm run flight:map
 *   浏览器打开 http://127.0.0.1:8765
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

import { GeoClawConfig } from "../src/core/GeoClawConfig.js";
import {
  buildIpGeoRegistryFromConfig,
  createFetchRouteResolverFromConfig,
  createWebFetch,
} from "../src/index.js";
import {
  filterFlightPathsByHotIps,
  flightPathTargetIp,
  flightPathsToGeoJsonCollection,
  assignDistinctRouteVisuals,
  routeVisualFromIp,
  type FetchFlightPath,
  type FetchRouteOrigin,
} from "../src/fetch/FetchFlightPath.js";

const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));
const VIZ_DIR = join(MODULE_DIR, "..", "viz", "flight-map");

const cfg = GeoClawConfig.get();
const mapCfg = cfg.getFlightMapConfig();
const webFetch = createWebFetch();
const ipGeo = buildIpGeoRegistryFromConfig();

/** ipinfo 解析的客户端原点（异步缓存） */
let cachedOrigin: FetchRouteOrigin | null = null;
let originResolveInFlight: Promise<void> | null = null;

async function ensureCachedOrigin(): Promise<FetchRouteOrigin | null> {
  if (cachedOrigin) return cachedOrigin;
  const route = cfg.getFetchRouteOptions();
  if (route.origin) {
    cachedOrigin = route.origin;
    return cachedOrigin;
  }
  if (!originResolveInFlight) {
    originResolveInFlight = (async () => {
      try {
        const resolver = createFetchRouteResolverFromConfig();
        const origin = await resolver?.resolveOrigin(cfg.getProxyUrl());
        if (origin) {
          cachedOrigin = origin;
          console.log("客户端原点已解析:", origin.city ?? origin.label, origin.lat, origin.lng);
        } else {
          console.warn("无法解析客户端原点（ipinfo），暂不绘制航线");
        }
      } catch (e) {
        console.warn("解析客户端原点失败:", e instanceof Error ? e.message : e);
      } finally {
        originResolveInFlight = null;
      }
    })();
  }
  await originResolveInFlight;
  return cachedOrigin;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".geojson": "application/geo+json; charset=utf-8",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...CORS_HEADERS,
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function staticFilePath(pathname: string): string | null {
  let rel = pathname === "/" ? "/index.html" : pathname;
  if (rel.includes("..")) return null;
  const file = join(VIZ_DIR, rel);
  if (!file.startsWith(VIZ_DIR) || !existsSync(file)) return null;
  return file;
}

function getHotIpSet(): Set<string> {
  const pool = webFetch.getHotConnectionPool();
  return new Set(pool?.getHotIps() ?? []);
}

/** 已向客户端推送过脉冲的 requestId（只推新请求，不画满热池） */
const pulsedRequestIds = new Set<string>();

/** 启动时吞掉历史航线，只对之后的新请求发脉冲 */
function seedPulsedFromHistory(): void {
  const metrics = webFetch.getFetchMetrics();
  const allRecent = metrics?.getSnapshot().recentFlightPaths ?? [];
  for (const p of allRecent) {
    if (p.requestId) pulsedRequestIds.add(p.requestId);
  }
}

function displayOptionsFor(paths: readonly FetchFlightPath[]) {
  const pathIps = paths
    .map((p) => flightPathTargetIp(p))
    .filter((ip): ip is string => !!ip);
  const visualByIp = assignDistinctRouteVisuals(pathIps, {
    leoAltitudeMinKm: mapCfg.leoAltitudeMinKm,
    leoAltitudeMaxKm: mapCfg.leoAltitudeMaxKm,
  });
  return {
    earthRadiusKm: mapCfg.earthRadiusKm,
    leoAltitudeMinKm: mapCfg.leoAltitudeMinKm,
    leoAltitudeMaxKm: mapCfg.leoAltitudeMaxKm,
    orbitDisplayExaggeration: mapCfg.orbitDisplayExaggeration,
    visualByIp,
  };
}

function slimPath(p: FetchFlightPath, display: ReturnType<typeof displayOptionsFor>) {
  const ip = flightPathTargetIp(p)!;
  const visual = routeVisualFromIp(ip, display);
  const target = p.waypoints.find((w) => w.role === "target");
  return {
    requestId: p.requestId,
    pinnedIp: ip,
    routeColor: visual.color,
    leoAltitudeKm: visual.leoAltitudeKm,
    totalDurationMs: p.totalDurationMs,
    httpStatus: p.httpStatus,
    bodyBytes: p.bodyBytes,
    targetCity: target?.city,
    targetLabel: target?.label,
  };
}

/** WS 绘制触发命令：不含坐标折线，前端用本地 IP 目录算弧 */
function pulseCommand(p: FetchFlightPath) {
  const ip = flightPathTargetIp(p) ?? "";
  const target = p.waypoints.find((w) => w.role === "target");
  const geo = ip ? ipGeo.lookup(ip) : undefined;
  const hasCatalogLoc = !!parseLoc(geo?.loc);
  const cmd: {
    id: string;
    ip: string;
    ms: number;
    st: number;
    b: number;
    via: "hot" | "cold";
    h2: boolean;
    city?: string;
    lat?: number;
    lng?: number;
  } = {
    id: p.requestId,
    ip,
    ms: Math.round(p.totalDurationMs ?? 0),
    st: p.httpStatus ?? 0,
    b: p.bodyBytes ?? 0,
    via: p.viaHot ? "hot" : "cold",
    h2: p.http2 === true,
  };
  const city = target?.city ?? geo?.city;
  if (city) cmd.city = city;
  // 目录里没有坐标时才带上，避免重复传输
  if (!hasCatalogLoc && target && Number.isFinite(target.lat) && Number.isFinite(target.lng)) {
    cmd.lat = target.lat;
    cmd.lng = target.lng;
  }
  return cmd;
}

/** 前端一次缓存：原点 + 弧参数 + 全量 IP 坐标目录 */
function buildMapAssetsPayload() {
  const ips: Record<string, [number, number, string?, string?]> = {};
  for (const [ip, info] of ipGeo.entries()) {
    const loc = parseLoc(info.loc);
    if (!loc) continue;
    ips[ip] = [loc.lat, loc.lng, info.city, info.country];
  }
  return {
    origin: cachedOrigin
      ? { lat: cachedOrigin.lat, lng: cachedOrigin.lng, city: cachedOrigin.city, label: cachedOrigin.label }
      : null,
    arc: {
      earthRadiusKm: mapCfg.earthRadiusKm,
      leoAltitudeMinKm: mapCfg.leoAltitudeMinKm,
      leoAltitudeMaxKm: mapCfg.leoAltitudeMaxKm,
      orbitDisplayExaggeration: mapCfg.orbitDisplayExaggeration,
    },
    anim: {
      drawMs: mapCfg.routeDrawMs,
      holdMs: mapCfg.routeHoldMs,
      fadeMs: mapCfg.routeFadeMs,
    },
    ips,
  };
}

/** 热池状态 + 统计（不含全量热池 IP / 航线，避免撑爆前端） */
function buildStatusPayload() {
  const metrics = webFetch.getFetchMetrics();
  const stats = metrics?.getSnapshot();
  const hotPool = webFetch.getHotConnectionPool();
  const hotCount = hotPool?.getHotCount() ?? getHotIpSet().size;
  return {
    hotCount,
    hotPoolStats: hotPool?.getStats() ?? null,
    origin: cachedOrigin,
    stats: stats
      ? {
          submitted: stats.submitted,
          succeeded: stats.succeeded,
          failed: stats.failed,
          inFlight: stats.inFlight,
        }
      : null,
    anim: {
      drawMs: mapCfg.routeDrawMs,
      holdMs: mapCfg.routeHoldMs,
      fadeMs: mapCfg.routeFadeMs,
    },
  };
}

/** 管理界面：当前请求域名下的每 IP 统计（含坐标便于点击定位）；topN≤0 表示全部 */
function buildIpStatsUiPayload(hostname: string, topN = 0) {
  const store = webFetch.getFetchMetrics()?.getIpStatsStore();
  if (!store) return null;
  const summary = store.summarizeForUi(hostname, topN);
  if (!summary) return null;
  return {
    ...summary,
    top: summary.top.map((r) => {
      const geo = ipGeo.lookup(r.ip);
      const loc = parseLoc(r.loc ?? geo?.loc);
      return {
        ip: r.ip,
        family: r.family,
        requests: r.requests,
        success: r.success,
        failed: r.failed,
        totalBytes: r.totalBytes,
        avgDurationMs: r.avgDurationMs,
        city: r.city ?? geo?.city,
        country: r.country ?? geo?.country,
        lat: loc?.lat,
        lng: loc?.lng,
      };
    }),
  };
}

function parseLoc(loc: string | undefined): { lat: number; lng: number } | null {
  if (!loc) return null;
  const parts = String(loc).split(",");
  if (parts.length < 2) return null;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function enrichIpStatRow(r: {
  ip: string;
  family: "ipv4" | "ipv6";
  requests: number;
  success: number;
  failed: number;
  totalBytes: number;
  avgDurationMs: number;
  city?: string;
  country?: string;
  loc?: string;
}) {
  const geo = ipGeo.lookup(r.ip);
  const loc = parseLoc(r.loc ?? geo?.loc);
  return {
    ip: r.ip,
    family: r.family,
    requests: r.requests,
    success: r.success,
    failed: r.failed,
    totalBytes: r.totalBytes,
    avgDurationMs: r.avgDurationMs,
    city: r.city ?? geo?.city,
    country: r.country ?? geo?.country,
    lat: loc?.lat,
    lng: loc?.lng,
  };
}

function rowSig(r: {
  requests: number;
  success: number;
  failed: number;
  totalBytes: number;
  avgDurationMs: number;
}): string {
  return `${r.requests}:${r.success}:${r.failed}:${r.totalBytes}:${r.avgDurationMs}`;
}

type IpStatsClientState = {
  hostname: string;
  limit: number;
  /** 需要下发全量（换域名 / 首次订阅） */
  needFull: boolean;
  /** 已与 store 对齐的 revision；无变化可跳过 */
  revision: number;
  /** 已推送给该客户端的 IP 签名 */
  lastSent: Map<string, string>;
};

const ipStatsClients = new WeakMap<WebSocket, IpStatsClientState>();

function sendIpStatsToClient(ws: WebSocket, forceFull = false): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const state = ipStatsClients.get(ws);
  if (!state?.hostname) return;
  const store = webFetch.getFetchMetrics()?.getIpStatsStore();
  if (!store) {
    ws.send(
      JSON.stringify({
        type: "ipStats",
        mode: "full",
        ts: Date.now(),
        hostname: state.hostname,
        error: "ip stats not enabled (fetchMetrics.ipStatsDir)",
      }),
    );
    return;
  }

  const rev = store.getDomainRevision(state.hostname);
  if (!forceFull && !state.needFull && rev === state.revision) return;

  if (forceFull || state.needFull) {
    // WS 全量仅摘要；limit=0 时也不在服务端组装三千行
    const payload = buildIpStatsUiPayload(state.hostname, state.limit > 0 ? state.limit : 1);
    if (!payload) return;
    // 全量只推摘要，行数据由前端 HTTP → IndexedDB 灌入，避免 WS 卡死
    const allSigs = store.collectChangedActive(state.hostname, new Map());
    state.lastSent.clear();
    if (allSigs) {
      for (const r of allSigs.changed) state.lastSent.set(r.ip, r.sig);
    } else {
      for (const r of payload.top) state.lastSent.set(r.ip, rowSig(r));
    }
    state.revision = rev;
    state.needFull = false;
    ws.send(
      JSON.stringify({
        type: "ipStats",
        mode: "full",
        bootstrap: "http",
        ts: Date.now(),
        hostname: payload.hostname,
        updatedAt: payload.updatedAt,
        totalIps: payload.totalIps,
        activeIps: payload.activeIps,
        activeIpv4: payload.activeIpv4,
        activeIpv6: payload.activeIpv6,
        totalRequests: payload.totalRequests,
        totalSuccess: payload.totalSuccess,
        totalFailed: payload.totalFailed,
        totalBytes: payload.totalBytes,
      }),
    );
    return;
  }

  const diff = store.collectChangedActive(state.hostname, state.lastSent);
  if (!diff) return;
  if (diff.changed.length === 0) {
    state.revision = rev;
    return;
  }

  // 单帧增量上限，未发送的下次继续推（不写入 lastSent）
  const MAX_DELTA = 40;
  const sorted = [...diff.changed].sort((a, b) => b.requests - a.requests);
  const changed = sorted.slice(0, MAX_DELTA);
  for (const r of changed) state.lastSent.set(r.ip, r.sig);
  state.revision = rev;

  ws.send(
    JSON.stringify({
      type: "ipStats",
      mode: "delta",
      ts: Date.now(),
      hostname: diff.hostname,
      updatedAt: diff.updatedAt,
      totalIps: diff.totalIps,
      activeIps: diff.activeIps,
      activeIpv4: diff.activeIpv4,
      activeIpv6: diff.activeIpv6,
      totalRequests: diff.totalRequests,
      totalSuccess: diff.totalSuccess,
      totalFailed: diff.totalFailed,
      totalBytes: diff.totalBytes,
      upsert: changed.map((r) => {
        const { sig: _sig, ...rest } = r;
        return enrichIpStatRow(rest);
      }),
    }),
  );
}

function pushIpStatsToWatchers(forceFull = false): void {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) sendIpStatsToClient(client, forceFull);
  }
}

/** 重置域名统计 + 热池派发计数，并强制订阅端全量刷新 */
function resetIpStatsForHostname(hostname: string): {
  ok: boolean;
  hostname: string;
  resetIps: number;
  resetAssignSlots: number;
  error?: string;
} {
  const host = String(hostname ?? "")
    .trim()
    .toLowerCase();
  if (!host) {
    return { ok: false, hostname: "", resetIps: 0, resetAssignSlots: 0, error: "missing hostname" };
  }
  const metrics = webFetch.getFetchMetrics();
  if (!metrics?.getIpStatsStore()) {
    return {
      ok: false,
      hostname: host,
      resetIps: 0,
      resetAssignSlots: 0,
      error: "ip stats not enabled (fetchMetrics.ipStatsDir)",
    };
  }
  const resetIps = metrics.resetIpStats(host);
  const resetAssignSlots = webFetch.getHotConnectionPool()?.resetAssignCounts() ?? 0;

  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const state = ipStatsClients.get(client);
    if (!state || state.hostname !== host) continue;
    state.needFull = true;
    state.revision = -1;
    state.lastSent.clear();
  }
  pushIpStatsToWatchers(true);

  return { ok: true, hostname: host, resetIps, resetAssignSlots };
}

/**
 * 仅打包「新出现」的实际 fetch 脉冲命令（无 GeoJSON 折线）。
 */
function drainNewRoutePulses(): ReturnType<typeof pulseCommand>[] | null {
  const metrics = webFetch.getFetchMetrics();
  const allRecent = metrics?.getSnapshot().recentFlightPaths ?? [];
  const hotIps = getHotIpSet();
  const fresh = filterFlightPathsByHotIps(allRecent, hotIps).filter(
    (p) => p.requestId && !pulsedRequestIds.has(p.requestId),
  );
  if (fresh.length === 0) return null;

  for (const p of fresh) pulsedRequestIds.add(p.requestId);
  if (pulsedRequestIds.size > 2000) {
    const keep = [...pulsedRequestIds].slice(-1000);
    pulsedRequestIds.clear();
    for (const id of keep) pulsedRequestIds.add(id);
  }

  return fresh.map((p) => pulseCommand(p));
}

/** REST / geojson.io：仅最近若干次真实请求（非全热池） */
function buildFlightPathsPayload() {
  const metrics = webFetch.getFetchMetrics();
  const allRecent = metrics?.getSnapshot().recentFlightPaths ?? [];
  const hotIps = getHotIpSet();
  const paths = filterFlightPathsByHotIps(allRecent, hotIps).slice(-40);
  const display = displayOptionsFor(paths);
  const status = buildStatusPayload();
  return {
    ...status,
    routeCount: paths.length,
    paths: paths.map((p) => slimPath(p, display)),
    geojson: flightPathsToGeoJsonCollection(paths, display, {
      includeWaypoints: false,
      compact: true,
    }),
  };
}

type StatusPayload = ReturnType<typeof buildStatusPayload>;

function statusFingerprint(payload: StatusPayload): string {
  return JSON.stringify({
    hot: payload.hotCount,
    stats: payload.stats,
    pool: payload.hotPoolStats
      ? {
          hot: payload.hotPoolStats.hot,
          denied: payload.hotPoolStats.denied,
          failed: payload.hotPoolStats.failed,
          pending: payload.hotPoolStats.pending,
          warming: payload.hotPoolStats.warming,
        }
      : null,
  });
}

let lastStatusFingerprint = "";

function broadcastJson(obj: unknown): void {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function broadcastStatus(force = false): void {
  const payload = buildStatusPayload();
  const fp = statusFingerprint(payload);
  if (!force && fp === lastStatusFingerprint) return;
  lastStatusFingerprint = fp;
  broadcastJson({ type: "poolStatus", ts: Date.now(), ...payload });
}

function broadcastNewPulses(): void {
  const items = drainNewRoutePulses();
  if (!items || items.length === 0) return;
  broadcastJson({
    type: "pulse",
    ts: Date.now(),
    items,
  });
}

function tickBroadcast(): void {
  broadcastNewPulses();
  broadcastStatus(false);
  pushIpStatsToWatchers(false);
}

async function runFetch(fetchUrl: string) {
  const hotPool = webFetch.getHotConnectionPool();
  if (hotPool && hotPool.getHotCount() === 0) {
    return {
      ok: false as const,
      error: "热连接池尚无存活 IP，请等待预热完成后再试",
      hotPoolStats: hotPool.getStats(),
    };
  }
  const started = Date.now();
  const result = await webFetch.getBytesWithTrace(fetchUrl, { trace: true });
  tickBroadcast();
  return {
    ok: true as const,
    bytes: result.bytes.length,
    elapsedMs: Date.now() - started,
    flightPath: result.flightPath,
    trace: { status: result.trace.status, pinnedIp: result.trace.pinnedIp },
  };
}

let stressRunning = false;

/**
 * 高并发压测：经热池 round-robin 取 IP 发请求，驱动前端脉冲。
 */
async function runStress(opts: {
  url?: string;
  concurrency?: number;
  total?: number;
} = {}) {
  if (stressRunning) {
    return { ok: false as const, error: "压测已在进行中" };
  }

  const fetchUrl = opts.url ?? mapCfg.demoFetchUrl;
  if (!fetchUrl) {
    return { ok: false as const, error: "missing url" };
  }

  const hotPool = webFetch.getHotConnectionPool();
  if (!hotPool || hotPool.getHotCount() === 0) {
    return {
      ok: false as const,
      error: "热连接池尚无存活 IP",
      hotPoolStats: hotPool?.getStats() ?? null,
    };
  }

  const hotCount = hotPool.getHotCount();
  const concurrency = Math.max(1, opts.concurrency ?? mapCfg.stressConcurrency ?? 40);
  const total = Math.max(
    1,
    opts.total ?? mapCfg.stressTotal ?? Math.max(hotCount * 2, concurrency * 2),
  );

  stressRunning = true;
  broadcastJson({
    type: "stressStatus",
    ts: Date.now(),
    status: "running",
    url: fetchUrl,
    concurrency,
    total,
    hotCount,
  });

  console.log("高并发压测开始:", { concurrency, total, hotCount, url: fetchUrl });
  const started = Date.now();
  let ok = 0;
  let fail = 0;
  let next = 0;
  let inFlight = 0;

  await new Promise<void>((resolve) => {
    const pump = () => {
      while (inFlight < concurrency && next < total) {
        next += 1;
        inFlight += 1;
        void webFetch
          .getBytesWithTrace(fetchUrl, { trace: false })
          .then(() => {
            ok += 1;
          })
          .catch(() => {
            fail += 1;
          })
          .finally(() => {
            inFlight -= 1;
            // 每次完成立刻推脉冲，前端实时心跳
            tickBroadcast();
            if (ok + fail >= total) resolve();
            else pump();
          });
      }
    };
    pump();
  });

  stressRunning = false;
  tickBroadcast();
  const summary = {
    ok: true as const,
    concurrency,
    total,
    succeeded: ok,
    failed: fail,
    hotCount,
    elapsedMs: Date.now() - started,
  };
  console.log("高并发压测结束:", summary);
  broadcastJson({ type: "stressStatus", ts: Date.now(), status: "done", ...summary });
  return summary;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/api/config") {
      sendJson(res, 200, {
        host: mapCfg.host,
        port: mapCfg.port,
        tileProvider: mapCfg.tileProvider,
        tileUrl: mapCfg.tileUrl,
        bingImagerySet: mapCfg.bingImagerySet,
        bingMapsKey: mapCfg.bingMapsKey,
        pollIntervalMs: mapCfg.pollIntervalMs,
        demoFetchUrl: mapCfg.demoFetchUrl,
        wsPath: "/ws",
        routeDrawMs: mapCfg.routeDrawMs,
        routeHoldMs: mapCfg.routeHoldMs,
        routeFadeMs: mapCfg.routeFadeMs,
        earthRadiusKm: mapCfg.earthRadiusKm,
        leoAltitudeMinKm: mapCfg.leoAltitudeMinKm,
        leoAltitudeMaxKm: mapCfg.leoAltitudeMaxKm,
        orbitDisplayExaggeration: mapCfg.orbitDisplayExaggeration,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/map-assets") {
      await ensureCachedOrigin();
      sendJson(res, 200, buildMapAssetsPayload());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/hot-ips") {
      const hotPool = webFetch.getHotConnectionPool();
      sendJson(res, 200, {
        hotIps: hotPool?.getHotIps() ?? [],
        stats: hotPool?.getStats() ?? null,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ip-stats") {
      // limit≤0 或省略：全部 IP；>0 时为 TopN
      const rawLimit = url.searchParams.get("limit");
      const limit =
        rawLimit == null || rawLimit === ""
          ? 0
          : Math.max(0, Number(rawLimit) || 0);
      const flush = url.searchParams.get("flush") === "1";
      if (flush) webFetch.getFetchMetrics()?.flushIpStats();
      const hostname =
        url.searchParams.get("hostname")?.trim() ||
        (() => {
          try {
            return new URL(mapCfg.demoFetchUrl ?? "").hostname;
          } catch {
            return cfg.getRaw().hostPin.hostname;
          }
        })();
      const payload = buildIpStatsUiPayload(hostname, limit);
      if (!payload) {
        sendJson(res, 404, { error: "ip stats not enabled (fetchMetrics.ipStatsDir) or missing hostname" });
        return;
      }
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ip-stats/reset") {
      const raw = await readBody(req);
      let body: { hostname?: string } = {};
      try {
        body = JSON.parse(raw || "{}") as { hostname?: string };
      } catch {
        body = {};
      }
      const hostname =
        body.hostname?.trim() ||
        (() => {
          try {
            return new URL(mapCfg.demoFetchUrl ?? "").hostname;
          } catch {
            return cfg.getRaw().hostPin.hostname;
          }
        })();
      const result = resetIpStatsForHostname(hostname);
      sendJson(res, result.ok ? 200 : 404, result);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/api/flight-paths" || url.pathname === "/api/flight-paths.geojson")) {
      const payload = buildFlightPathsPayload();
      if (url.pathname === "/api/flight-paths.geojson") {
        res.writeHead(200, {
          "Content-Type": "application/geo+json; charset=utf-8",
          ...CORS_HEADERS,
        });
        res.end(JSON.stringify(payload.geojson));
        return;
      }
      sendJson(res, 200, payload);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/fetch") {
      const raw = await readBody(req);
      const body = JSON.parse(raw || "{}") as { url?: string };
      const fetchUrl = body.url ?? mapCfg.demoFetchUrl;
      if (!fetchUrl) {
        sendJson(res, 400, { error: "missing url" });
        return;
      }
      // 异步执行，立即 202；结果走 WS fetchResult（若有订阅端）
      void runFetch(fetchUrl)
        .then((result) => {
          broadcastJson({ type: "fetchResult", ts: Date.now(), ...result });
        })
        .catch((err) => {
          broadcastJson({
            type: "fetchResult",
            ts: Date.now(),
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      sendJson(res, 202, { ok: true, accepted: true, url: fetchUrl });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/stress") {
      const raw = await readBody(req);
      const body = JSON.parse(raw || "{}") as {
        url?: string;
        concurrency?: number;
        total?: number;
      };
      if (stressRunning) {
        sendJson(res, 409, { ok: false, error: "压测已在进行中" });
        return;
      }
      void runStress(body)
        .then((result) => {
          broadcastJson({ type: "stressResult", ts: Date.now(), ...result });
        })
        .catch((err) => {
          broadcastJson({
            type: "stressResult",
            ts: Date.now(),
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      sendJson(res, 202, {
        ok: true,
        accepted: true,
        message: "压测已异步启动，进度/结果经 WebSocket 推送",
      });
      return;
    }

    const file = staticFilePath(url.pathname);
    if (file && req.method === "GET") {
      const data = readFileSync(file);
      const ext = extname(file);
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      res.end(data);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "hello",
      ts: Date.now(),
      message: "GeoClaw flight-map WebSocket · 仅请求脉冲航线",
    }),
  );

  // 连接时只下发热池状态，不回放历史航线（避免一上来画满）
  const status = buildStatusPayload();
  lastStatusFingerprint = statusFingerprint(status);
  ws.send(JSON.stringify({ type: "poolStatus", ts: Date.now(), ...status }));

  ws.on("message", (raw) => {
    void (async () => {
      try {
        const msg = JSON.parse(String(raw)) as {
          type?: string;
          url?: string;
          hostname?: string;
          limit?: number;
          concurrency?: number;
          total?: number;
        };
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
          return;
        }
        if (msg.type === "subscribe" || msg.type === "refresh") {
          ws.send(JSON.stringify({ type: "poolStatus", ts: Date.now(), ...buildStatusPayload() }));
          sendIpStatsToClient(ws, false);
          return;
        }
        if (msg.type === "watchIpStats") {
          const hostname = String(msg.hostname ?? "")
            .trim()
            .toLowerCase();
          // limit≤0：全部 IP（默认）；>0：TopN
          const rawLimit = Number(msg.limit);
          const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 0;
          if (!hostname) {
            ipStatsClients.delete(ws);
            ws.send(
              JSON.stringify({
                type: "ipStats",
                mode: "full",
                ts: Date.now(),
                hostname: "",
                rows: [],
              }),
            );
            return;
          }
          const prev = ipStatsClients.get(ws);
          const sameHost = prev?.hostname === hostname;
          ipStatsClients.set(ws, {
            hostname,
            limit,
            needFull: !sameHost,
            revision: sameHost ? (prev?.revision ?? -1) : -1,
            lastSent: sameHost ? (prev?.lastSent ?? new Map()) : new Map(),
          });
          // 同域名再订阅：若无变更则不推；换域名则全量
          sendIpStatsToClient(ws, !sameHost);
          return;
        }
        if (msg.type === "resetIpStats") {
          const hostname =
            String(msg.hostname ?? "").trim().toLowerCase() ||
            (() => {
              try {
                return new URL(mapCfg.demoFetchUrl ?? "").hostname.toLowerCase();
              } catch {
                return cfg.getRaw().hostPin.hostname;
              }
            })();
          const result = resetIpStatsForHostname(hostname);
          ws.send(JSON.stringify({ type: "ipStatsReset", ...result, ts: Date.now() }));
          return;
        }
        if (msg.type === "fetch") {
          const fetchUrl = msg.url ?? mapCfg.demoFetchUrl;
          if (!fetchUrl) {
            ws.send(JSON.stringify({ type: "fetchResult", ok: false, error: "missing url" }));
            return;
          }
          try {
            const h = new URL(fetchUrl).hostname.toLowerCase();
            const prev = ipStatsClients.get(ws);
            const sameHost = prev?.hostname === h;
            ipStatsClients.set(ws, {
              hostname: h,
              limit: prev?.limit ?? 0,
              needFull: !sameHost,
              revision: sameHost ? (prev?.revision ?? -1) : -1,
              lastSent: sameHost ? (prev?.lastSent ?? new Map()) : new Map(),
            });
          } catch {
            /* ignore */
          }
          ws.send(JSON.stringify({ type: "fetchStatus", status: "running", url: fetchUrl }));
          // 异步派发：不在 WS 消息回调里同步等完整请求，避免堵其它消息
          void runFetch(fetchUrl)
            .then((result) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "fetchResult", ...result }));
                sendIpStatsToClient(ws, false);
              }
            })
            .catch((err) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "fetchResult",
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                  }),
                );
              }
              tickBroadcast();
            });
          return;
        }
        if (msg.type === "stress") {
          ws.send(JSON.stringify({ type: "stressStatus", status: "accepted", ts: Date.now() }));
          if (msg.url) {
            try {
              const h = new URL(msg.url).hostname.toLowerCase();
              const prev = ipStatsClients.get(ws);
              const sameHost = prev?.hostname === h;
              ipStatsClients.set(ws, {
                hostname: h,
                limit: prev?.limit ?? 0,
                needFull: !sameHost,
                revision: sameHost ? (prev?.revision ?? -1) : -1,
                lastSent: sameHost ? (prev?.lastSent ?? new Map()) : new Map(),
              });
            } catch {
              /* ignore */
            }
          }
          void runStress({
            url: msg.url,
            concurrency: msg.concurrency,
            total: msg.total,
          })
            .then((result) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "stressResult", ...result }));
                sendIpStatsToClient(ws, false);
              }
            })
            .catch((err) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "stressResult",
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                  }),
                );
              }
            });
          return;
        }
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "error",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    })();
  });
});

/** 检测新请求脉冲 + 热池状态变化 */
setInterval(() => {
  if (!cachedOrigin) void ensureCachedOrigin().then(() => tickBroadcast());
  else tickBroadcast();
}, 400);

server.listen(mapCfg.port, mapCfg.host, () => {
  const base = `http://${mapCfg.host}:${mapCfg.port}`;
  console.log("=== GeoClaw 热池 IP 飞行地图 (WS + Bing) ===");
  console.log("地图:", base);
  console.log("WebSocket:", `ws://${mapCfg.host}:${mapCfg.port}/ws`);
  console.log("规则: 仅实际请求触发虚线脉冲 · 绘出后淡出 · 不画满热池");
  console.log(
    "LEO 轨道:",
    `${mapCfg.leoAltitudeMinKm}-${mapCfg.leoAltitudeMaxKm} km`,
    `R=${mapCfg.earthRadiusKm} km`,
  );
  console.log("配置:", cfg.getConfigPath());
  console.log("IP 地理表:", ipGeo.size(), "条");

  const hotPool = webFetch.getHotConnectionPool();
  if (hotPool) {
    console.log("热池预热中…", hotPool.getStats());
  }

  void (async () => {
    await ensureCachedOrigin();
    seedPulsedFromHistory();
    tickBroadcast();

    if (mapCfg.demoFetchOnStart && mapCfg.demoFetchUrl) {
      console.log("演示 Fetch（热池就绪后）:", mapCfg.demoFetchUrl);
      const pool = webFetch.getHotConnectionPool();
      for (let i = 0; i < 60; i++) {
        if (!pool || pool.getHotCount() > 0) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (pool && pool.getHotCount() === 0) {
        console.error("演示跳过: 热池仍无存活 IP");
        return;
      }
      try {
        const r = await runFetch(mapCfg.demoFetchUrl!);
        if (r.ok) {
          console.log(
            "演示完成:",
            r.bytes,
            "bytes",
            r.flightPath?.totalDurationMs,
            "ms",
            "ip=",
            r.flightPath?.pinnedIp ?? r.trace.pinnedIp,
          );
        } else {
          console.error("演示失败:", r.error);
        }
      } catch (e) {
        console.error("演示 Fetch 失败:", e instanceof Error ? e.message : e);
      }
    }

    if (mapCfg.stressOnStart) {
      const pool = webFetch.getHotConnectionPool();
      for (let i = 0; i < 90; i++) {
        if (pool && pool.getHotCount() >= Math.min(20, pool.getStats().total || 20)) break;
        if (pool && pool.getHotCount() > 0 && i >= 15) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!pool || pool.getHotCount() === 0) {
        console.error("压测跳过: 热池仍无存活 IP");
        return;
      }
      // 多等一会让热池更满，再轮询压测
      await new Promise((r) => setTimeout(r, 3000));
      void runStress({});
    }
  })();
});
