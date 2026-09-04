/**
 * IP Stats Worker：独占 IndexedDB + HTTP 全量灌入 + WS 增量合并。
 * 只向主线程下发轻量 UI 指令（摘要 / 分片行 / 行补丁），不碰地图与脉冲。
 */

import {
  loadIpStatsCache,
  saveIpStatsCache,
  upsertIpStatsCache,
  clearIpStatsCache,
} from "./ip-stats-db.js";

/** @type {MessagePort | null} */
let wsPort = null;
/** @type {string} */
let watchingHost = "";
/** @type {string} */
let httpOrigin = "";
/** @type {AbortController | null} */
let bootstrapAbort = null;
/** @type {number} */
let renderGen = 0;

/** @type {Map<string, object>} */
const rows = new Map();

/** @type {object} */
let meta = {};

self.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "bindWsPort") {
    wsPort = ev.ports[0] ?? null;
    if (wsPort) {
      wsPort.onmessage = (e) => {
        void onIpStatsFromWs(e.data);
      };
    }
    return;
  }

  if (msg.type === "configure") {
    httpOrigin = String(msg.origin || "").replace(/\/$/, "");
    return;
  }

  if (msg.type === "watch") {
    void watchHostname(String(msg.hostname || "").trim().toLowerCase(), {
      bootstrapHttp: Boolean(msg.bootstrapHttp),
    });
    return;
  }

  if (msg.type === "resetLocal") {
    const host = String(msg.hostname || "").trim().toLowerCase();
    void (async () => {
      // 打断进行中的 HTTP 全量，避免与重置抢画
      if (bootstrapAbort) {
        bootstrapAbort.abort();
        bootstrapAbort = null;
      }
      bootstrappingHost = null;

      if (host) await clearIpStatsCache(host);
      rows.clear();
      meta = host
        ? {
            hostname: host,
            totalIps: 0,
            activeIps: 0,
            activeIpv4: 0,
            activeIpv6: 0,
            totalRequests: 0,
            totalSuccess: 0,
            totalFailed: 0,
            totalBytes: 0,
          }
        : {};
      watchingHost = host;
      renderGen += 1;
      const gen = renderGen;
      self.postMessage({
        type: "ipStatsUi",
        action: "clear",
        hint: host ? `已重置 ${host} 统计，等待新请求…` : "请填写请求 URL",
      });
      if (host) {
        self.postMessage({
          type: "ipStatsUi",
          action: "summary",
          meta: { ...meta },
        });
        // 空表立刻画出来，不必等下一次刷新
        postFullChunks(gen);
      }
    })();
    return;
  }
};

/** @type {string | null} */
let bootstrappingHost = null;

/**
 * @param {string} hostname
 * @param {{ bootstrapHttp?: boolean }} [opts]
 */
async function watchHostname(hostname, opts = {}) {
  if (bootstrapAbort) {
    bootstrapAbort.abort();
    bootstrapAbort = null;
    bootstrappingHost = null;
  }

  watchingHost = hostname;
  const gen = ++renderGen;

  if (!hostname) {
    rows.clear();
    meta = {};
    self.postMessage({
      type: "ipStatsUi",
      action: "clear",
      hint: "请填写请求 URL",
    });
    return;
  }

  const cached = await loadIpStatsCache(hostname);
  if (hostname !== watchingHost || gen !== renderGen) return;

  // WS 实时路径：只恢复摘要，不把 IDB 里上千行一次灌进 DOM
  rows.clear();
  if (cached?.meta) {
    meta = {
      hostname,
      updatedAt: cached.updatedAt,
      ...(cached.meta ?? {}),
    };
    self.postMessage({ type: "ipStatsUi", action: "summary", meta: { ...meta } });
  } else {
    meta = { hostname };
    self.postMessage({ type: "ipStatsUi", action: "summary", meta: { ...meta } });
  }

  // 无 WS 时才 HTTP/IDB 灌表
  if (opts.bootstrapHttp) {
    if (cached?.rows) {
      for (const [ip, row] of Object.entries(cached.rows)) {
        rows.set(ip, row);
      }
      postFullChunks(gen);
    }
    await bootstrapHttp(hostname, gen);
  }
}

/**
 * @param {string} hostname
 * @param {number} gen
 */
async function bootstrapHttp(hostname, gen) {
  if (!httpOrigin) return;
  // 同域名已有灌入：打断旧的，用当前 gen 重拉（重置后必须能画上）
  if (bootstrapAbort) {
    bootstrapAbort.abort();
    bootstrapAbort = null;
  }
  bootstrappingHost = hostname;
  const ac = new AbortController();
  bootstrapAbort = ac;
  try {
    const res = await fetch(
      `${httpOrigin}/api/ip-stats?hostname=${encodeURIComponent(hostname)}&limit=0`,
      { signal: ac.signal },
    );
    if (!res.ok) return;
    const data = await res.json();
    if (hostname !== watchingHost || gen !== renderGen) return;

    rows.clear();
    for (const row of data.top ?? data.rows ?? []) {
      if (row?.ip) rows.set(row.ip, row);
    }
    meta = {
      hostname: data.hostname ?? hostname,
      updatedAt: data.updatedAt,
      totalIps: data.totalIps,
      activeIps: data.activeIps,
      activeIpv4: data.activeIpv4,
      activeIpv6: data.activeIpv6,
      totalRequests: data.totalRequests,
      totalSuccess: data.totalSuccess,
      totalFailed: data.totalFailed,
      totalBytes: data.totalBytes,
    };
    await saveIpStatsCache(hostname, {
      updatedAt: meta.updatedAt,
      meta,
      rows,
    });
    if (hostname !== watchingHost || gen !== renderGen) return;
    postFullChunks(gen);
  } catch (err) {
    if (err?.name === "AbortError") return;
  } finally {
    if (bootstrapAbort === ac) bootstrapAbort = null;
    if (bootstrappingHost === hostname) bootstrappingHost = null;
  }
}

/**
 * @param {any} msg
 */
async function onIpStatsFromWs(msg) {
  if (!msg || msg.type !== "ipStats") return;
  if (msg.error) {
    rows.clear();
    meta = {};
    self.postMessage({ type: "ipStatsUi", action: "clear", hint: msg.error });
    return;
  }
  if (!msg.hostname) {
    rows.clear();
    meta = {};
    self.postMessage({
      type: "ipStatsUi",
      action: "clear",
      hint: "请填写请求 URL",
    });
    return;
  }
  if (watchingHost && msg.hostname !== watchingHost) return;

  meta = {
    hostname: msg.hostname,
    updatedAt: msg.updatedAt,
    totalIps: msg.totalIps,
    activeIps: msg.activeIps,
    activeIpv4: msg.activeIpv4,
    activeIpv6: msg.activeIpv6,
    totalRequests: msg.totalRequests,
    totalSuccess: msg.totalSuccess,
    totalFailed: msg.totalFailed,
    totalBytes: msg.totalBytes,
    byCountry: msg.byCountry,
    countryFilter: msg.countryFilter,
  };

  if (msg.mode === "full" || !msg.mode) {
    const legacy = msg.rows ?? msg.top;
    if (legacy?.length) {
      rows.clear();
      for (const row of legacy) {
        if (row?.ip) rows.set(row.ip, row);
      }
      await saveIpStatsCache(msg.hostname, {
        updatedAt: msg.updatedAt,
        meta,
        rows,
      });
      postFullChunks(renderGen);
    } else {
      self.postMessage({ type: "ipStatsUi", action: "summary", meta: { ...meta } });
      // 重置后无请求：直接空表 + 摘要，勿再 HTTP 全量（易与 resetLocal 抢画导致卡住）
      const idle =
        (Number(msg.activeIps) || 0) === 0 && (Number(msg.totalRequests) || 0) === 0;
      if (idle) {
        rows.clear();
        void saveIpStatsCache(msg.hostname, {
          updatedAt: msg.updatedAt,
          meta,
          rows,
        });
        postFullChunks(renderGen);
      } else if (msg.bootstrap === "http") {
        void bootstrapHttp(msg.hostname, renderGen);
      }
    }
    return;
  }

  if (msg.mode === "summary") {
    // 只更新摘要；禁止在此触发 HTTP 全量（压测中会每几百毫秒重拉 3000 行卡死）
    self.postMessage({ type: "ipStatsUi", action: "summary", meta: { ...meta } });
    return;
  }

  if (msg.mode === "window") {
    const upsert = msg.upsert ?? [];
    rows.clear();
    for (const row of upsert) {
      if (row?.ip) rows.set(row.ip, row);
    }
    void upsertIpStatsCache(msg.hostname, upsert, meta);
    self.postMessage({
      type: "ipStatsUi",
      action: "window",
      meta: { ...meta },
      window: msg.window,
      upsert,
    });
    return;
  }

  if (msg.mode === "delta") {
    const upsert = msg.upsert ?? [];
    if (msg.replaceVisible) {
      rows.clear();
    }
    for (const row of upsert) {
      if (row?.ip) rows.set(row.ip, row);
    }
    void upsertIpStatsCache(msg.hostname, upsert, meta);
    if (msg.replaceVisible) {
      postFullChunks(renderGen);
    } else {
      self.postMessage({
        type: "ipStatsUi",
        action: "patch",
        meta: { ...meta },
        upsert,
      });
    }
  }
}

/**
 * @param {number} gen
 */
function postFullChunks(gen) {
  const ordered = buildOrdered();
  self.postMessage({
    type: "ipStatsUi",
    action: "fullStart",
    gen,
    meta: { ...meta },
    total: ordered.length,
  });
  const CHUNK = 40;
  let i = 0;
  const pump = () => {
    if (gen !== renderGen) return;
    if (i >= ordered.length) {
      self.postMessage({
        type: "ipStatsUi",
        action: "fullChunk",
        gen,
        rows: [],
        done: true,
      });
      return;
    }
    const end = Math.min(i + CHUNK, ordered.length);
    self.postMessage({
      type: "ipStatsUi",
      action: "fullChunk",
      gen,
      rows: ordered.slice(i, end),
      done: end >= ordered.length,
    });
    i = end;
    // 让出事件循环，避免一次同步灌 3000 行堵死
    setTimeout(pump, 0);
  };
  pump();
}

function buildOrdered() {
  const all = [...rows.values()];
  const v4 = all
    .filter((r) => (r.family ?? (String(r.ip).includes(":") ? "ipv6" : "ipv4")) === "ipv4")
    .sort(
      (a, b) =>
        (b.requests ?? 0) - (a.requests ?? 0) || String(a.ip).localeCompare(String(b.ip)),
    );
  const v6 = all
    .filter((r) => (r.family ?? (String(r.ip).includes(":") ? "ipv6" : "ipv4")) === "ipv6")
    .sort(
      (a, b) =>
        (b.requests ?? 0) - (a.requests ?? 0) || String(a.ip).localeCompare(String(b.ip)),
    );
  const top = [];
  let i = 0;
  let j = 0;
  while (i < v4.length || j < v6.length) {
    if (i < v4.length) top.push(v4[i++]);
    if (j < v6.length) top.push(v6[j++]);
  }
  return top;
}
