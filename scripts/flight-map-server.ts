#!/usr/bin/env tsx
/**
 * GeoJSON 飞行路线可视化服务（Leaflet + Bing Maps + WebSocket）。
 * 按落点预绘灰色骨架，请求点亮换色；数据经 WS 推送。
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
import { NicTrafficSampler } from "./nic-traffic.js";
import { normalizeCountryFilter } from "../src/fetch/IpFetchStatsStore.js";

const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));
const VIZ_DIR = join(MODULE_DIR, "..", "viz", "flight-map");

const cfg = GeoClawConfig.get();
const mapCfg = cfg.getFlightMapConfig();
const webFetch = createWebFetch();
const ipGeo = buildIpGeoRegistryFromConfig();
const nicSampler = new NicTrafficSampler(mapCfg.nicIface);

/** 请求速率采样（与网卡同一节拍，供前端心跳波峰图） */
let fetchRatePrev = {
  submitted: 0,
  succeeded: 0,
  failed: 0,
  at: Date.now(),
};
let fetchRateEwma = { submitted: 0, succeeded: 0, failed: 0 };

/**
 * 按 FetchMetrics 计数差分计算瞬时/指数平均 RPS。
 */
function sampleFetchRate(): {
  rps: number;
  rpsOk: number;
  rpsFail: number;
  avgRps: number;
  avgRpsOk: number;
  avgRpsFail: number;
  inFlight: number;
  submitted: number;
  succeeded: number;
  failed: number;
} {
  const snap = webFetch.getFetchMetrics()?.getSnapshot();
  const now = Date.now();
  const submitted = snap?.submitted ?? 0;
  const succeeded = snap?.succeeded ?? 0;
  const failed = snap?.failed ?? 0;
  const inFlight = snap?.inFlight ?? 0;
  const dtSec = Math.max(0.001, (now - fetchRatePrev.at) / 1000);
  const dSub = Math.max(0, submitted - fetchRatePrev.submitted);
  const dOk = Math.max(0, succeeded - fetchRatePrev.succeeded);
  const dFail = Math.max(0, failed - fetchRatePrev.failed);
  const rps = dSub / dtSec;
  const rpsOk = dOk / dtSec;
  const rpsFail = dFail / dtSec;
  const alpha = 0.35;
  fetchRateEwma = {
    submitted: fetchRateEwma.submitted * (1 - alpha) + rps * alpha,
    succeeded: fetchRateEwma.succeeded * (1 - alpha) + rpsOk * alpha,
    failed: fetchRateEwma.failed * (1 - alpha) + rpsFail * alpha,
  };
  fetchRatePrev = { submitted, succeeded, failed, at: now };
  return {
    rps,
    rpsOk,
    rpsFail,
    avgRps: fetchRateEwma.submitted,
    avgRpsOk: fetchRateEwma.succeeded,
    avgRpsFail: fetchRateEwma.failed,
    inFlight,
    submitted,
    succeeded,
    failed,
  };
}

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
  ".png": "image/png",
  ".svg": "image/svg+xml",
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

/** 已向客户端推送过脉冲的 requestId（只推新激活，避免重复点亮） */
const pulsedRequestIds = new Set<string>();

/** 启动时吞掉历史航线，只对之后的新请求发激活脉冲 */
function seedPulsedFromHistory(): void {
  const metrics = webFetch.getFetchMetrics();
  const allRecent = metrics?.getRecentFlightPaths() ?? [];
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
  const geo = ip ? ipGeo.lookup(ip) : undefined;
  return {
    requestId: p.requestId,
    pinnedIp: ip,
    routeColor: visual.color,
    leoAltitudeKm: visual.leoAltitudeKm,
    totalDurationMs: p.totalDurationMs,
    httpStatus: p.httpStatus,
    bodyBytes: p.bodyBytes,
    targetCity: target?.city ?? geo?.city,
    targetCountry: target?.country ?? geo?.country,
    targetLabel: target?.label,
    requestPath: requestPathOnly(p.url),
    viaHot: p.viaHot,
    http2: p.http2,
  };
}

/** 取 URL 斜杠后的路径（pathname + search + hash） */
function requestPathOnly(url: string): string | undefined {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}` || "/";
  } catch {
    return undefined;
  }
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
    country?: string;
    path?: string;
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
  const country = target?.country ?? geo?.country;
  if (country) cmd.country = country;
  const path = requestPathOnly(p.url);
  if (path) cmd.path = path;
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

/** 管理界面：当前请求域名下的每 IP 统计；topN≤0 表示全部；includeRows=false 只返回汇总 */
function buildIpStatsUiPayload(hostname: string, topN = 0, includeRows = true) {
  const store = webFetch.getFetchMetrics()?.getIpStatsStore();
  if (!store) return null;
  const summary = store.summarizeForUi(hostname, topN, includeRows);
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
  /** 摘要已推送的 revision（压测中可只推摘要） */
  summaryRevision: number;
  /** 已推送给该客户端的 IP 签名 */
  lastSent: Map<string, string>;
  /** 浏览器表格可视区域内的 IP（只对这些行做实时增量） */
  visibleIps: Set<string>;
  /** 当前窗口起始下标 */
  windowStart: number;
  /** 当前窗口条数 */
  windowCount: number;
  /** 国别筛选（ISO2 / ZZ）；null=全部 */
  countryFilter: string | null;
};

const ipStatsClients = new WeakMap<WebSocket, IpStatsClientState>();

/**
 * 按 IP 列表组装带地理信息的行（供可见区推送）。
 */
function buildEnrichedRowsForIps(hostname: string, ips: Iterable<string>) {
  const store = webFetch.getFetchMetrics()?.getIpStatsStore();
  if (!store) return [] as ReturnType<typeof enrichIpStatRow>[];
  const out: ReturnType<typeof enrichIpStatRow>[] = [];
  for (const ip of ips) {
    const row = store.get(hostname, ip);
    if (!row) continue;
    out.push(
      enrichIpStatRow({
        ip: row.ip,
        family: row.family,
        requests: row.requests,
        success: row.success,
        failed: row.failed,
        totalBytes: row.totalBytes,
        avgDurationMs: row.avgDurationMs,
        city: row.city,
        country: row.country,
        loc: row.loc,
      }),
    );
  }
  return out;
}

/**
 * 只推汇总数字（不含行），供压测中限频刷新侧栏摘要表。
 */
function sendIpStatsMetaToClient(ws: WebSocket): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const state = ipStatsClients.get(ws);
  if (!state?.hostname) return;
  const store = webFetch.getFetchMetrics()?.getIpStatsStore();
  if (!store) return;
  const rev = store.getDomainRevision(state.hostname);
  if (rev === state.summaryRevision) return;
  const payload = buildIpStatsUiPayload(state.hostname, 0, false);
  if (!payload) return;
  state.summaryRevision = rev;
  ws.send(
    JSON.stringify({
      type: "ipStats",
      mode: "summary",
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
      byCountry: payload.byCountry,
    }),
  );
}

function pushIpStatsMetaToWatchers(): void {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) sendIpStatsMetaToClient(client);
  }
}

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
    // 摘要对齐 + 推当前滚动窗口（默认首屏），不再死限 Top40 / HTTP 整表
    const payload = buildIpStatsUiPayload(state.hostname, 0, false);
    if (!payload) return;
    state.lastSent.clear();
    store.seedActiveSigsInto(state.hostname, state.lastSent);
    state.revision = rev;
    state.summaryRevision = rev;
    state.needFull = false;
    sendIpStatsWindowToClient(ws, state.windowStart, state.windowCount || 24);
    return;
  }

  const diff = store.collectChangedActive(state.hostname, state.lastSent);
  if (!diff) return;
  if (diff.changed.length === 0) {
    state.revision = rev;
    state.summaryRevision = rev;
    return;
  }

  // 屏外变更只记账；有任何变更则重推当前滚动窗口（编号/本屏内容随序更新）
  for (const r of diff.changed) {
    state.lastSent.set(r.ip, r.sig);
  }
  state.revision = rev;
  state.summaryRevision = rev;
  sendIpStatsWindowToClient(ws, state.windowStart, state.windowCount || 24);
}

/**
 * 客户端上报可视 IP 后：立即推这些行的当前值。
 */
function sendVisibleIpStatsToClient(ws: WebSocket, ips: string[]): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const state = ipStatsClients.get(ws);
  if (!state?.hostname) return;
  state.visibleIps = new Set(ips.filter(Boolean));
  const payload = buildIpStatsUiPayload(state.hostname, 0, false);
  if (!payload) return;
  const upsert = buildEnrichedRowsForIps(state.hostname, state.visibleIps);
  for (const r of upsert) state.lastSent.set(r.ip, rowSig(r));
  state.summaryRevision = storeRevision(state.hostname);
  ws.send(
    JSON.stringify({
      type: "ipStats",
      mode: "delta",
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
      byCountry: payload.byCountry,
      upsert,
    }),
  );
}

/**
 * 按滚动窗口推送一屏 IP 行（带起止编号）。
 */
function sendIpStatsWindowToClient(ws: WebSocket, start: number, count: number): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const state = ipStatsClients.get(ws);
  if (!state?.hostname) return;
  const store = webFetch.getFetchMetrics()?.getIpStatsStore();
  if (!store) return;
  const win = store.sliceActiveIpWindow(
    state.hostname,
    start,
    count,
    state.countryFilter,
  );
  if (!win) return;
  const payload = buildIpStatsUiPayload(state.hostname, 0, false);
  if (!payload) return;

  state.windowStart = win.start;
  state.windowCount = Math.max(1, win.end - win.start);
  state.visibleIps = new Set(win.rows.map((r) => r.ip));

  const upsert = win.rows.map((r) => {
    const enriched = enrichIpStatRow({
      ip: r.ip,
      family: r.family,
      requests: r.requests,
      success: r.success,
      failed: r.failed,
      totalBytes: r.totalBytes,
      avgDurationMs: r.avgDurationMs,
      city: r.city,
      country: r.country,
      loc: r.loc,
    });
    state.lastSent.set(r.ip, rowSig(enriched));
    return { ...enriched, index: r.index };
  });

  state.summaryRevision = store.getDomainRevision(state.hostname);
  ws.send(
    JSON.stringify({
      type: "ipStats",
      mode: "window",
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
      byCountry: payload.byCountry,
      countryFilter: state.countryFilter,
      window: { total: win.total, start: win.start, end: win.end },
      upsert,
      replaceVisible: true,
    }),
  );
}

function storeRevision(hostname: string): number {
  return webFetch.getFetchMetrics()?.getIpStatsStore()?.getDomainRevision(hostname) ?? 0;
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
    state.summaryRevision = -1;
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
  const allRecent = metrics?.getRecentFlightPaths() ?? [];
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

/** REST / geojson.io：仅最近若干次真实请求（激活脉冲，非重复全量航线） */
function buildFlightPathsPayload() {
  const metrics = webFetch.getFetchMetrics();
  const allRecent = metrics?.getRecentFlightPaths() ?? [];
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

/**
 * 推送脉冲：客户端发送缓冲过大则跳过（淘汰积压，避免撑爆前端）。
 */
function broadcastPulseJson(obj: unknown): void {
  const msg = JSON.stringify(obj);
  const maxBuf = Math.max(0, mapCfg.wsMaxBufferedBytes ?? 1_048_576);
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (maxBuf > 0 && client.bufferedAmount > maxBuf) continue;
    client.send(msg);
  }
}

function broadcastStatus(force = false): void {
  const payload = buildStatusPayload();
  const fp = statusFingerprint(payload);
  if (!force && fp === lastStatusFingerprint) return;
  lastStatusFingerprint = fp;
  broadcastJson({ type: "poolStatus", ts: Date.now(), ...payload });
}

function broadcastNewPulses(maxItems?: number): void {
  const items = drainNewRoutePulses();
  if (!items || items.length === 0) return;
  // 按落点坐标去重：同坐标本批只推一次（保留最后一次，前端只换色）
  const byRoute = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    const geo = item.ip ? ipGeo.lookup(item.ip) : undefined;
    const loc =
      parseLoc(geo?.loc) ??
      (Number.isFinite(item.lat) && Number.isFinite(item.lng)
        ? { lat: item.lat as number, lng: item.lng as number }
        : null);
    const key = loc
      ? `ll:${loc.lat.toFixed(4)},${loc.lng.toFixed(4)}`
      : `ip:${item.ip || item.id}`;
    byRoute.set(key, item);
  }
  let payload = [...byRoute.values()];
  if (maxItems != null && payload.length > maxItems) {
    payload = payload.slice(-maxItems);
  }
  broadcastPulseJson({
    type: "pulse",
    ts: Date.now(),
    items: payload,
  });
}

function tickBroadcast(): void {
  broadcastNewPulses();
  if (stressRunning) {
    // 压测中状态/IP 由 runStress 节流推送，避免与泵抢扫
    return;
  }
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
let stressPulseTimer: ReturnType<typeof setInterval> | null = null;
let stressLastProgressAt = 0;
let stressLastIpStatsAt = 0;

/** 压测期待推脉冲（按落点去重，避免每条请求建 FetchFlightPath） */
const stressPulseByRoute = new Map<
  string,
  { id: string; ip: string; ms: number; st: number; b: number; via: "hot"; h2: boolean; city?: string; country?: string; path?: string }
>();

/** 压测期 IP 计数暂存，批量刷入 IpFetchStatsStore */
const stressIpAgg = new Map<
  string,
  { ok: number; fail: number; bytes: number; durationSum: number }
>();

const stressCfg = cfg.getStressTestOptions();

function stressBumpIp(ip: string, success: boolean, durationMs: number, bytes: number): void {
  const cur = stressIpAgg.get(ip);
  if (cur) {
    if (success) cur.ok += 1;
    else cur.fail += 1;
    cur.bytes += bytes;
    cur.durationSum += durationMs;
  } else {
    stressIpAgg.set(ip, {
      ok: success ? 1 : 0,
      fail: success ? 0 : 1,
      bytes,
      durationSum: durationMs,
    });
  }
}

function stressFlushIpAgg(hostname: string): void {
  const store = webFetch.getFetchMetrics()?.getIpStatsStore();
  if (!store || stressIpAgg.size === 0) return;
  for (const [ip, a] of stressIpAgg) {
    const geo = ipGeo.lookup(ip);
    store.recordBatch({
      hostname,
      ip,
      success: a.ok,
      failed: a.fail,
      durationSumMs: a.durationSum,
      bytes: a.bytes,
      city: geo?.city,
      region: geo?.region,
      country: geo?.country,
      loc: geo?.loc,
    });
  }
  stressIpAgg.clear();
}

/**
 * 压测极速路径：热池选路 + 读 body；软公平复用热连接，间歇探索保证全池都会打到。
 */
async function leanStressFetch(fetchUrl: string, pathHint: string | undefined): Promise<void> {
  const hotPool = webFetch.getHotConnectionPool();
  if (!hotPool) throw new Error("无热池");

  const t0 = Date.now();
  try {
    const { response, ip, timings } = await hotPool.fetchOnce(fetchUrl, {}, {
      timeoutMs: stressRequestTimeoutMs,
      warmSlack: stressWarmSlack,
      exploreRatio: stressExploreRatio,
    });
    const durationMs = Math.max(0, Math.round(timings?.wait ?? Date.now() - t0));
    const buf = await response.arrayBuffer();
    const bytes = buf.byteLength;

    stressBumpIp(ip, true, durationMs, bytes);

    const geo = ipGeo.lookup(ip);
    const loc = parseLoc(geo?.loc);
    const key = loc
      ? `ll:${loc.lat.toFixed(4)},${loc.lng.toFixed(4)}`
      : `ip:${ip}`;
    stressSeq += 1;
    stressPulseByRoute.set(key, {
      id: `s-${stressSeq}-${ip}`,
      ip,
      ms: durationMs,
      st: response.status,
      b: bytes,
      via: "hot",
      h2: true,
      ...(geo?.city ? { city: geo.city } : {}),
      ...(geo?.country ? { country: geo.country } : {}),
      ...(pathHint ? { path: pathHint } : {}),
    });
  } catch (err) {
    const ip =
      err && typeof err === "object" && "ip" in err
        ? String((err as { ip?: string }).ip ?? "")
        : "";
    if (ip) {
      stressBumpIp(ip, false, Date.now() - t0, 0);
    }
    throw err;
  }
}

let stressSeq = 0;
/** 压测单次超时（只释放并发槽，选路不排除慢 IP） */
let stressRequestTimeoutMs = 3_000;
/** 软公平带宽：带内优先复用热连接 */
let stressWarmSlack = 64;
/** 严格公平探索比例：保证落后/冷 IP 仍会被打到 */
let stressExploreRatio = 0.08;


function flushStressPulses(): void {
  if (stressPulseByRoute.size === 0) return;
  const items = [...stressPulseByRoute.values()];
  stressPulseByRoute.clear();
  broadcastPulseJson({
    type: "pulse",
    ts: Date.now(),
    items,
  });
}

/**
 * 高并发压测：热池直打，尽量不碰 metrics/航线对象；地图靠稀疏脉冲点亮。
 */
async function runStress(
  opts: {
    url?: string;
    concurrency?: number;
    total?: number;
  } = {},
) {
  if (stressRunning) {
    return { ok: false as const, error: "压测已在进行中" };
  }

  const fetchUrl = opts.url ?? stressCfg.url ?? mapCfg.demoFetchUrl;
  if (!fetchUrl) {
    return { ok: false as const, error: "missing url" };
  }

  let hostname = "";
  let pathHint: string | undefined;
  try {
    const u = new URL(fetchUrl);
    hostname = u.hostname.toLowerCase();
    pathHint = `${u.pathname}${u.search}${u.hash}` || "/";
  } catch {
    return { ok: false as const, error: "invalid url" };
  }

  await ensureCachedOrigin();

  const hotPool = webFetch.getHotConnectionPool();
  if (!hotPool || hotPool.getHotCount() === 0) {
    return {
      ok: false as const,
      error: "热连接池尚无存活 IP",
      hotPoolStats: hotPool?.getStats() ?? null,
    };
  }

  const hotCount = hotPool.getHotCount();
  const concurrency = Math.max(1, opts.concurrency ?? stressCfg.concurrency);
  const total = Math.max(1, opts.total ?? stressCfg.total);

  stressRunning = true;
  stressLastProgressAt = 0;
  stressLastIpStatsAt = 0;
  stressSeq = 0;
  stressPulseByRoute.clear();
  stressIpAgg.clear();

  if (stressPulseTimer) clearInterval(stressPulseTimer);
  // 压测期 100ms 推一帧去重脉冲；中途不刷 IP 表；保活/重热继续跑
  const pulseMs = Math.max(100, mapCfg.pulseStreamMs);
  stressPulseTimer = setInterval(() => {
    flushStressPulses();
  }, pulseMs);

  // 低并发·高频补位；软公平复用热 TCP；间歇严格公平保证全池都会打到
  stressRequestTimeoutMs = stressCfg.requestTimeoutMs;
  stressWarmSlack = Math.max(concurrency, concurrency * 2);
  stressExploreRatio = 0.08;

  broadcastJson({
    type: "stressStatus",
    ts: Date.now(),
    status: "running",
    url: fetchUrl,
    concurrency,
    total,
    hotCount,
    succeeded: 0,
    failed: 0,
    done: 0,
  });

  console.log("压测开始（低并发高频·软公平复用·间歇全池探索）:", {
    concurrency,
    total,
    hotCount,
    requestTimeoutMs: stressRequestTimeoutMs,
    warmSlack: stressWarmSlack,
    exploreRatio: stressExploreRatio,
    url: fetchUrl,
  });
  const started = Date.now();
  let ok = 0;
  let fail = 0;
  let next = 0;
  let inFlight = 0;

  const maybeProgress = () => {
    const done = ok + fail;
    const now = Date.now();
    if (done < total && now - stressLastProgressAt < 500) return;
    stressLastProgressAt = now;
    broadcastJson({
      type: "stressStatus",
      ts: now,
      status: "running",
      url: fetchUrl,
      concurrency,
      total,
      hotCount: hotPool.getHotCount(),
      succeeded: ok,
      failed: fail,
      done,
      elapsedMs: now - started,
    });
  };

  try {
    await new Promise<void>((resolve) => {
      /** 有空槽就立刻补请求：低并发靠高频补位撑吞吐 */
      const pump = () => {
        while (inFlight < concurrency && next < total) {
          next += 1;
          inFlight += 1;
          void leanStressFetch(fetchUrl, pathHint)
            .then(() => {
              ok += 1;
            })
            .catch(() => {
              fail += 1;
            })
            .finally(() => {
              inFlight -= 1;
              maybeProgress();
              if (ok + fail >= total) resolve();
              else setImmediate(pump);
            });
        }
      };
      pump();
    });
  } finally {
    if (stressPulseTimer) {
      clearInterval(stressPulseTimer);
      stressPulseTimer = null;
    }
    stressRunning = false;
  }

  flushStressPulses();
  stressFlushIpAgg(hostname);
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const state = ipStatsClients.get(client);
    if (!state?.hostname) continue;
    state.needFull = true;
    state.revision = -1;
  }
  pushIpStatsToWatchers(true);
  broadcastStatus(false);
  const summary = {
    ok: true as const,
    concurrency,
    total,
    succeeded: ok,
    failed: fail,
    hotCount: hotPool.getHotCount(),
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

    // 测试入口：仅 API（主页无 UI）；npm run stress:hot 会打这里
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
        message: "压测已异步启动；进度经 WebSocket，地图会点亮航线",
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
      message: "GeoClaw flight-map WebSocket · 落点骨架 + 请求点亮",
    }),
  );

  // 连接时只下发热池状态；灰色骨架由前端 map-assets 预绘，不回放历史激活
  const status = buildStatusPayload();
  lastStatusFingerprint = statusFingerprint(status);
  ws.send(JSON.stringify({ type: "poolStatus", ts: Date.now(), ...status }));
  const nicNow = nicSampler.sample();
  const rateNow = sampleFetchRate();
  ws.send(
    JSON.stringify({
      type: "nicTraffic",
      ...(nicNow ?? {}),
      ...rateNow,
      ts: Date.now(),
    }),
  );

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
            summaryRevision: sameHost ? (prev?.summaryRevision ?? -1) : -1,
            lastSent: sameHost ? (prev?.lastSent ?? new Map()) : new Map(),
            visibleIps: sameHost ? (prev?.visibleIps ?? new Set()) : new Set(),
            windowStart: sameHost ? (prev?.windowStart ?? 0) : 0,
            windowCount: sameHost ? (prev?.windowCount ?? 24) : 24,
            countryFilter: sameHost ? (prev?.countryFilter ?? null) : null,
          });
          // 同域名再订阅：若无变更则不推；换域名则全量
          sendIpStatsToClient(ws, !sameHost);
          return;
        }
        if (msg.type === "visibleIpStats") {
          const hostname = String(msg.hostname ?? "")
            .trim()
            .toLowerCase();
          const state = ipStatsClients.get(ws);
          if (!state || (hostname && state.hostname !== hostname)) {
            return;
          }
          const ips = Array.isArray(msg.ips)
            ? msg.ips.map((x: unknown) => String(x ?? "").trim()).filter(Boolean)
            : [];
          sendVisibleIpStatsToClient(ws, ips);
          return;
        }
        if (msg.type === "ipStatsWindow") {
          const hostname = String(msg.hostname ?? "")
            .trim()
            .toLowerCase();
          const state = ipStatsClients.get(ws);
          if (!state || (hostname && state.hostname !== hostname)) return;
          const start = Number(msg.start);
          const count = Number(msg.count);
          if ("country" in msg) {
            state.countryFilter = normalizeCountryFilter(
              msg.country == null ? null : String(msg.country),
            );
          }
          sendIpStatsWindowToClient(
            ws,
            Number.isFinite(start) ? start : 0,
            Number.isFinite(count) ? count : 24,
          );
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
              summaryRevision: sameHost ? (prev?.summaryRevision ?? -1) : -1,
              lastSent: sameHost ? (prev?.lastSent ?? new Map()) : new Map(),
              visibleIps: sameHost ? (prev?.visibleIps ?? new Set()) : new Set(),
              windowStart: sameHost ? (prev?.windowStart ?? 0) : 0,
              windowCount: sameHost ? (prev?.windowCount ?? 24) : 24,
              countryFilter: sameHost ? (prev?.countryFilter ?? null) : null,
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

/** 本机网卡上下行速率 + 请求 RPS（全连接广播） */
setInterval(() => {
  const sample = nicSampler.sample();
  const rate = sampleFetchRate();
  broadcastJson({
    type: "nicTraffic",
    ...(sample ?? {}),
    ...rate,
    ts: Date.now(),
  });
}, Math.max(1, mapCfg.nicSampleMs));

server.listen(mapCfg.port, mapCfg.host, () => {
  const base = `http://${mapCfg.host}:${mapCfg.port}`;
  console.log("=== GeoClaw 热池 IP 飞行地图 (WS + Bing) ===");
  console.log("地图:", base);
  console.log("WebSocket:", `ws://${mapCfg.host}:${mapCfg.port}/ws`);
  console.log("规则: 按落点预绘灰色骨架 · 请求点亮换色 · 超时淡回灰");
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
  })();
});
