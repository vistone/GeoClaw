import { mapDisplayArc, visualFromIp } from "./arc.js";

/** @typedef {{
 *   host: string;
 *   port: number;
 *   tileProvider?: "bing" | "custom";
 *   tileUrl: string;
 *   bingImagerySet?: "Road" | "Aerial" | "AerialWithLabels";
 *   bingMapsKey?: string | null;
 *   pollIntervalMs: number;
 *   demoFetchUrl: string | null;
 *   routeDrawMs?: number;
 *   routeHoldMs?: number;
 *   routeFadeMs?: number;
 *   earthRadiusKm?: number;
 *   leoAltitudeMinKm?: number;
 *   leoAltitudeMaxKm?: number;
 *   orbitDisplayExaggeration?: number;
 * }} FlightMapConfig */

const BING_TILE_PREFIX = {
  Road: "r",
  Aerial: "a",
  AerialWithLabels: "h",
};

/** @type {FlightMapConfig} */
let config = {
  host: "127.0.0.1",
  port: 8765,
  tileProvider: "bing",
  tileUrl: "",
  bingImagerySet: "Road",
  bingMapsKey: null,
  pollIntervalMs: 3000,
  demoFetchUrl: null,
  routeDrawMs: 1400,
  routeHoldMs: 500,
  routeFadeMs: 2800,
  earthRadiusKm: 6371,
  leoAltitudeMinKm: 12,
  leoAltitudeMaxKm: 48,
  orbitDisplayExaggeration: 2.5,
};

/** @type {{ lat: number; lng: number; city?: string; label?: string } | null} */
let mapOrigin = null;

/** @type {Map<string, { lat: number; lng: number; city?: string; country?: string }>} */
const ipCatalog = new Map();

/** @type {L.Map | null} */
let map = null;

/** @type {any} */
let routeLayer = null;

/** @type {import('geojson').FeatureCollection} */
let lastGeoJson = { type: "FeatureCollection", features: [] };

/**
 * @typedef {{
 *   id: string;
 *   color: string;
 *   latlngs: L.LatLng[];
 *   bornAt: number;
 *   drawMs: number;
 *   holdMs: number;
 *   fadeMs: number;
 *   pinnedIp?: string;
 * }} RoutePulse
 */

/** @type {Map<string, RoutePulse>} */
const pulses = new Map();

/** @type {object[]} */
let recentPulsePaths = [];

let didInitialFit = false;
let animRunning = false;

/** @type {Worker | null} */
let wsWorker = null;
/** @type {Worker | null} */
let ipStatsWorker = null;
/** @type {boolean} */
let wsConnected = false;

async function loadConfig() {
  const res = await fetch("/api/config");
  if (res.ok) {
    config = { ...config, ...(await res.json()) };
  }
}

async function loadMapAssets() {
  const res = await fetch("/api/map-assets");
  if (!res.ok) throw new Error(`map-assets HTTP ${res.status}`);
  const data = await res.json();
  if (data.origin?.lat != null && data.origin?.lng != null) {
    mapOrigin = {
      lat: data.origin.lat,
      lng: data.origin.lng,
      city: data.origin.city,
      label: data.origin.label,
    };
  }
  if (data.arc) {
    config.earthRadiusKm = data.arc.earthRadiusKm ?? config.earthRadiusKm;
    config.leoAltitudeMinKm = data.arc.leoAltitudeMinKm ?? config.leoAltitudeMinKm;
    config.leoAltitudeMaxKm = data.arc.leoAltitudeMaxKm ?? config.leoAltitudeMaxKm;
    config.orbitDisplayExaggeration =
      data.arc.orbitDisplayExaggeration ?? config.orbitDisplayExaggeration;
  }
  if (data.anim) {
    config.routeDrawMs = data.anim.drawMs ?? config.routeDrawMs;
    config.routeHoldMs = data.anim.holdMs ?? config.routeHoldMs;
    config.routeFadeMs = data.anim.fadeMs ?? config.routeFadeMs;
  }
  ipCatalog.clear();
  for (const [ip, row] of Object.entries(data.ips ?? {})) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const lat = Number(row[0]);
    const lng = Number(row[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    ipCatalog.set(ip, {
      lat,
      lng,
      city: row[2] ? String(row[2]) : undefined,
      country: row[3] ? String(row[3]) : undefined,
    });
  }
  setStatus(`已缓存 ${ipCatalog.size} 个 IP 坐标 · 原点 ${mapOrigin?.city ?? mapOrigin?.label ?? "?"}`);
}

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

function animTiming(override) {
  return {
    drawMs: Number(override?.drawMs ?? config.routeDrawMs) || 1400,
    holdMs: Number(override?.holdMs ?? config.routeHoldMs) || 500,
    fadeMs: Number(override?.fadeMs ?? config.routeFadeMs) || 2800,
  };
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
function toQuadKey(x, y, z) {
  let index = "";
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    index += String(digit);
  }
  return index;
}

function createBingTileLayer() {
  // 无 Key 直连 CDN：/tiles/{r|a|h}{quadkey}.png（G,L 前缀会 400）
  const prefix = BING_TILE_PREFIX[config.bingImagerySet ?? "Road"] ?? "r";
  const BingLayer = L.TileLayer.extend({
    options: {
      subdomains: ["t0", "t1", "t2", "t3"],
      attribution: '&copy; <a href="https://www.bing.com/maps">Bing Maps</a> &copy; Microsoft',
      maxZoom: 19,
      noWrap: false,
    },
    getTileUrl(coords) {
      const q = toQuadKey(coords.x, coords.y, coords.z);
      return `https://ecn.${this._getSubdomain(coords)}.tiles.virtualearth.net/tiles/${prefix}${q}.png?g=14783`;
    },
  });
  return new BingLayer();
}

async function createBingLayerFromMetadata() {
  const key = config.bingMapsKey?.trim();
  if (!key) return null;

  const set = config.bingImagerySet ?? "Road";
  const imagery =
    set === "Road"
      ? "RoadOnDemand"
      : set === "AerialWithLabels"
        ? "AerialWithLabelsOnDemand"
        : "Aerial";

  const metaUrl =
    `https://dev.virtualearth.net/REST/V1/Imagery/Metadata/${imagery}` +
    `?output=json&include=ImageryProviders&key=${encodeURIComponent(key)}`;

  const res = await fetch(metaUrl);
  if (!res.ok) throw new Error(`Bing Metadata HTTP ${res.status}`);
  const data = await res.json();
  const resource = data?.resourceSets?.[0]?.resources?.[0];
  if (!resource?.imageUrl) throw new Error("Bing Metadata 无 imageUrl");

  const subdomains = resource.imageUrlSubdomains ?? ["t0", "t1", "t2", "t3"];
  const template = resource.imageUrl
    .replace("{subdomain}", "{s}")
    .replace("{culture}", "zh-CN");

  const BingMetaLayer = L.TileLayer.extend({
    options: {
      subdomains,
      attribution: '&copy; <a href="https://www.bing.com/maps">Bing Maps</a> &copy; Microsoft',
      maxZoom: resource.zoomMax ?? 19,
      minZoom: resource.zoomMin ?? 1,
      noWrap: false,
    },
    getTileUrl(coords) {
      const q = toQuadKey(coords.x, coords.y, coords.z);
      return L.Util.template(template, {
        s: this._getSubdomain(coords),
        quadkey: q,
      });
    },
  });

  return new BingMetaLayer();
}

/** 虚线脉冲层：请求驱动绘出 → 停留 → 淡出 */
function createPulseRouteLayer() {
  return L.Layer.extend({
    initialize() {
      this._pulses = [];
      this._canvas = null;
      this._ctx = null;
      this._onView = null;
      this._raf = 0;
    },

    onAdd(mapInst) {
      this._map = mapInst;
      if (!this._canvas) {
        // 不要加 leaflet-zoom-animated：缩放时 CSS transform 会与自绘 container 坐标冲突，一挪就「消失」
        this._canvas = L.DomUtil.create("canvas", "flight-pulse-routes");
        this._canvas.style.position = "absolute";
        this._canvas.style.left = "0";
        this._canvas.style.top = "0";
        this._canvas.style.pointerEvents = "none";
        this._ctx = this._canvas.getContext("2d");
      }
      mapInst.getPanes().overlayPane.appendChild(this._canvas);
      this._onView = () => this._scheduleRedraw();
      mapInst.on("move zoom moveend zoomend resize viewreset", this._onView);
      this._redraw(performance.now());
    },

    onRemove(mapInst) {
      if (this._onView) {
        mapInst.off("move zoom moveend zoomend resize viewreset", this._onView);
        this._onView = null;
      }
      if (this._canvas?.parentNode) {
        this._canvas.parentNode.removeChild(this._canvas);
      }
      this._map = null;
    },

    setPulses(list) {
      this._pulses = list;
      this._scheduleRedraw();
    },

    getBounds() {
      const b = L.latLngBounds([]);
      for (const p of this._pulses) {
        for (const ll of p.latlngs) b.extend(ll);
      }
      return b;
    },

    _scheduleRedraw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame((now) => {
        this._raf = 0;
        this._redraw(now);
      });
    },

    _redraw(now) {
      const mapInst = this._map;
      const canvas = this._canvas;
      const ctx = this._ctx;
      if (!mapInst || !canvas || !ctx) return;

      // 始终以全局 pulses 为准，避免缩放过程中本地列表不同步
      const live = typeof pulses !== "undefined" ? [...pulses.values()] : this._pulses;
      this._pulses = live;

      const size = mapInst.getSize();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(size.x * dpr));
      const h = Math.max(1, Math.floor(size.y * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = `${size.x}px`;
        canvas.style.height = `${size.y}px`;
      }

      // 对齐 overlay 图层原点，清除残留 transform
      canvas.style.transform = "";
      canvas.style.webkitTransform = "";
      const topLeft = mapInst.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(canvas, topLeft);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);
      ctx.lineWidth = 1.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.setLineDash([7, 9]);

      for (const pulse of live) {
        const age = now - pulse.bornAt;
        const life = pulse.drawMs + pulse.holdMs + pulse.fadeMs;
        if (age >= life || pulse.latlngs.length < 2) continue;

        let drawT = 1;
        let opacity = 0.9;
        if (age < pulse.drawMs) {
          drawT = age / pulse.drawMs;
          opacity = 0.55 + 0.4 * drawT;
        } else if (age < pulse.drawMs + pulse.holdMs) {
          drawT = 1;
          opacity = 0.95;
        } else {
          const fadeAge = age - pulse.drawMs - pulse.holdMs;
          drawT = 1;
          opacity = Math.max(0, 1 - fadeAge / pulse.fadeMs) * 0.9;
        }

        const pts = samplePathPrefix(pulse.latlngs, drawT);
        if (pts.length < 2) continue;

        ctx.globalAlpha = opacity;
        ctx.strokeStyle = pulse.color;
        ctx.lineDashOffset = -(age / 28);
        ctx.beginPath();
        const p0 = mapInst.latLngToContainerPoint(pts[0]);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < pts.length; i++) {
          const p = mapInst.latLngToContainerPoint(pts[i]);
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();

        const head = pts[pts.length - 1];
        const hp = mapInst.latLngToContainerPoint(head);
        ctx.setLineDash([]);
        ctx.fillStyle = pulse.color;
        ctx.beginPath();
        ctx.arc(hp.x, hp.y, 2.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.setLineDash([7, 9]);
      }

      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    },
  });
}

function samplePathPrefix(latlngs, t) {
  if (t <= 0) return [latlngs[0]];
  if (t >= 1) return latlngs;
  const total = pathLength(latlngs);
  if (total <= 0) return [latlngs[0]];
  const target = total * t;
  const out = [latlngs[0]];
  let acc = 0;
  for (let i = 1; i < latlngs.length; i++) {
    const a = latlngs[i - 1];
    const b = latlngs[i];
    const seg = a.distanceTo(b);
    if (acc + seg >= target) {
      const local = seg > 0 ? (target - acc) / seg : 0;
      out.push(L.latLng(a.lat + (b.lat - a.lat) * local, a.lng + (b.lng - a.lng) * local));
      break;
    }
    out.push(b);
    acc += seg;
  }
  return out;
}

function pathLength(latlngs) {
  let n = 0;
  for (let i = 1; i < latlngs.length; i++) n += latlngs[i - 1].distanceTo(latlngs[i]);
  return n;
}

async function initMap() {
  if (typeof L === "undefined") {
    setStatus("Leaflet 加载失败，请检查网络");
    return;
  }

  map = L.map("map", {
    center: [40, 180],
    zoom: 2,
    zoomControl: true,
    worldCopyJump: true,
    preferCanvas: true,
  });

  try {
    let tiles = null;
    if ((config.tileProvider ?? "bing") === "bing") {
      tiles = await createBingLayerFromMetadata();
      if (!tiles) tiles = createBingTileLayer();
      setStatus(`Bing Maps · ${config.bingImagerySet ?? "Road"}`);
    } else if (config.tileUrl) {
      tiles = L.tileLayer(config.tileUrl, {
        attribution: "Custom tiles",
        maxZoom: 19,
        noWrap: false,
      });
    } else {
      tiles = createBingTileLayer();
    }
    tiles.addTo(map);
  } catch (err) {
    console.error(err);
    setStatus(`Bing 底图加载失败，回退直连瓦片: ${err instanceof Error ? err.message : String(err)}`);
    createBingTileLayer().addTo(map);
  }

  const PulseRouteLayer = createPulseRouteLayer();
  routeLayer = new PulseRouteLayer();
  routeLayer.addTo(map);

  connectFlightWs();
  startPulseLoop();
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function featureToLatLngs(feature) {
  const g = feature.geometry;
  if (!g) return [];
  if (g.type === "LineString") {
    return g.coordinates.map((c) => L.latLng(c[1], c[0]));
  }
  if (g.type === "MultiLineString") {
    return g.coordinates.flat().map((c) => L.latLng(c[1], c[0]));
  }
  return [];
}

function activatePulseItems(items) {
  const timing = animTiming();
  const now = performance.now();
  let added = 0;

  for (const item of items ?? []) {
    const id = String(item.id ?? "");
    const ip = String(item.ip ?? "");
    if (!id || !ip || pulses.has(id)) continue;

    const known = ipCatalog.get(ip);
    let lat = Number(item.lat);
    let lng = Number(item.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      lat = known?.lat;
      lng = known?.lng;
    } else if (!known) {
      ipCatalog.set(ip, {
        lat,
        lng,
        city: item.city,
      });
    }
    if (!mapOrigin || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const status = Number(item.st);
    const ok = Number.isFinite(status) && status >= 200 && status < 300;
    const visual = visualFromIp(ip, config);
    const color = ok ? visual.color : "#ef4444";
    const coords = mapDisplayArc(
      { lat: mapOrigin.lat, lng: mapOrigin.lng },
      { lat, lng },
      {
        earthRadiusKm: config.earthRadiusKm,
        altitudeKm: visual.leoAltitudeKm,
        orbitDisplayExaggeration: config.orbitDisplayExaggeration,
        minSteps: 16,
        maxSteps: 40,
      },
    );
    const latlngs = coords.map(([x, y]) => L.latLng(y, x));
    if (latlngs.length < 2) continue;

    pulses.set(id, {
      id,
      color,
      latlngs,
      bornAt: now,
      drawMs: timing.drawMs,
      holdMs: timing.holdMs,
      fadeMs: timing.fadeMs,
      pinnedIp: ip,
    });
    added += 1;
    recentPulsePaths = [
      {
        requestId: id,
        pinnedIp: ip,
        routeColor: color,
        totalDurationMs: item.ms,
        httpStatus: item.st,
        bodyBytes: item.b,
        targetCity: item.city ?? known?.city,
        viaHot: item.via === "hot",
        http2: item.h2 === true,
      },
      ...recentPulsePaths,
    ].slice(0, 20);
  }

  if (added > 0) {
    syncPulseLayer();
    renderRouteList(recentPulsePaths);
    if (!didInitialFit && routeLayer) {
      const bounds = routeLayer.getBounds();
      if (bounds.isValid()) {
        map?.fitBounds(bounds, { padding: [40, 40], maxZoom: 5 });
        didInitialFit = true;
      }
    }
  }
  return added;
}

function syncPulseLayer() {
  if (!routeLayer) return;
  routeLayer.setPulses([...pulses.values()]);
  lastGeoJson = {
    type: "FeatureCollection",
    features: [...pulses.values()].map((p) => ({
      type: "Feature",
      properties: { kind: "route", requestId: p.id, pinnedIp: p.pinnedIp, routeColor: p.color },
      geometry: {
        type: "LineString",
        coordinates: p.latlngs.map((ll) => [ll.lng, ll.lat]),
      },
    })),
  };
}

function pruneDeadPulses(now) {
  let changed = false;
  for (const [id, p] of pulses) {
    if (now - p.bornAt >= p.drawMs + p.holdMs + p.fadeMs) {
      pulses.delete(id);
      changed = true;
    }
  }
  if (changed) syncPulseLayer();
}

function startPulseLoop() {
  if (animRunning) return;
  animRunning = true;
  const tick = (now) => {
    pruneDeadPulses(now);
    if (routeLayer) routeLayer._redraw?.(now);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function wsSend(payload) {
  if (!wsWorker) return;
  wsWorker.postMessage({ type: "send", payload });
}

function ensureWorkers() {
  if (wsWorker && ipStatsWorker) return;

  wsWorker = new Worker(new URL("./ws-worker.js", import.meta.url), { type: "module" });
  ipStatsWorker = new Worker(new URL("./ip-stats-worker.js", import.meta.url), {
    type: "module",
  });

  const channel = new MessageChannel();
  wsWorker.postMessage({ type: "bindIpStatsPort" }, [channel.port1]);
  ipStatsWorker.postMessage({ type: "bindWsPort" }, [channel.port2]);
  ipStatsWorker.postMessage({ type: "configure", origin: location.origin });

  wsWorker.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "wsOpen") {
      wsConnected = true;
      setStatus("WebSocket 已连接 · 等待请求脉冲");
      wsSend({ type: "subscribe" });
      watchIpStatsHostname();
      return;
    }
    if (msg.type === "wsClose") {
      wsConnected = false;
      setStatus("WebSocket 断开，重连中…");
      return;
    }
    if (msg.type === "wsError") {
      return;
    }
    if (msg.type === "wsMessage") {
      handleFlightWsMessage(msg.data);
    }
  };

  ipStatsWorker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg?.type === "ipStatsUi") applyIpStatsUiCommand(msg);
  };
}

function connectFlightWs() {
  ensureWorkers();
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  wsWorker.postMessage({ type: "connect", url: `${proto}//${location.host}/ws` });
}

/**
 * 主线程只处理地图 / 脉冲 / 状态（不含 IP 统计原始包）
 * @param {any} msg
 */
function handleFlightWsMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "hello") return;

  if (msg.type === "poolStatus") {
    if (msg.anim) {
      config.routeDrawMs = msg.anim.drawMs ?? config.routeDrawMs;
      config.routeHoldMs = msg.anim.holdMs ?? config.routeHoldMs;
      config.routeFadeMs = msg.anim.fadeMs ?? config.routeFadeMs;
    }
    if (!mapOrigin && msg.origin?.lat != null && msg.origin?.lng != null) {
      mapOrigin = {
        lat: msg.origin.lat,
        lng: msg.origin.lng,
        city: msg.origin.city,
        label: msg.origin.label,
      };
    }
    renderStats(msg.stats);
    renderHotStats(msg.hotCount);
    setStatus(`WS · 热池 ${msg.hotCount ?? 0} · 活跃脉冲 ${pulses.size}`);
    return;
  }

  if (msg.type === "pulse" || msg.type === "routePulses") {
    const items = msg.items ?? msg.paths ?? [];
    const n = activatePulseItems(
      items.map((p) =>
        p.id
          ? p
          : {
              id: p.requestId,
              ip: p.pinnedIp,
              ms: p.totalDurationMs,
              st: p.httpStatus,
              b: p.bodyBytes,
              city: p.targetCity,
            },
      ),
    );
    setStatus(`脉冲 +${n} · 请求驱动 · 当前 ${pulses.size} 条`);
    return;
  }

  if (msg.type === "routeList" || msg.type === "flightPaths") {
    if (msg.stats) renderStats(msg.stats);
    if (msg.hotCount != null) renderHotStats(msg.hotCount);
    return;
  }

  if (msg.type === "stressStatus") {
    if (msg.status === "running") {
      setStatus(
        `高并发压测中… 并发 ${msg.concurrency} · 目标 ${msg.total} · 热池 ${msg.hotCount}`,
      );
    } else if (msg.status === "done") {
      setStatus(
        `压测完成 成功 ${msg.succeeded}/${msg.total} · 失败 ${msg.failed} · ${msg.elapsedMs} ms`,
      );
    }
    return;
  }

  if (msg.type === "stressResult") {
    const btn = document.getElementById("btn-stress");
    if (btn) btn.disabled = false;
    if (msg.ok) {
      setStatus(
        `压测完成 成功 ${msg.succeeded}/${msg.total} · 失败 ${msg.failed} · ${msg.elapsedMs} ms`,
      );
    } else {
      setStatus(`压测失败: ${msg.error ?? "unknown"}`);
    }
    return;
  }

  if (msg.type === "fetchStatus") {
    setStatus(`Fetch 进行中… ${msg.url ?? ""}`);
    return;
  }

  if (msg.type === "fetchResult") {
    const btn = document.getElementById("btn-fetch");
    if (btn) btn.disabled = false;
    if (msg.ok) {
      setStatus(
        `完成 ${msg.flightPath?.totalDurationMs ?? msg.elapsedMs ?? "?"} ms · IP ${msg.trace?.pinnedIp ?? msg.flightPath?.pinnedIp ?? "?"}`,
      );
    } else {
      setStatus(`Fetch 失败: ${msg.error ?? "unknown"}`);
    }
    return;
  }

  if (msg.type === "ipStatsReset") {
    const btn = document.getElementById("btn-reset-ip-stats");
    if (btn) btn.disabled = false;
    if (msg.ok) {
      setStatus(
        `统计已重置 ${msg.hostname} · ${msg.resetIps ?? 0} IP · 派发计数清零 ${msg.resetAssignSlots ?? 0}`,
      );
      ipStatsWorker?.postMessage({ type: "resetLocal", hostname: msg.hostname });
      watchIpStatsHostname();
    } else {
      setStatus(`重置失败: ${msg.error ?? "unknown"}`);
    }
  }
}

function renderStats(stats) {
  const el = document.getElementById("stats");
  if (!stats) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <div>请求 ${stats.submitted} · 成功 ${stats.succeeded} · 失败 ${stats.failed} · 进行中 ${stats.inFlight ?? 0}</div>
    <div id="hot-stats" style="margin-top:6px;color:#94a3b8"></div>
    <div class="legend" style="margin-top:8px;color:#94a3b8;font-size:12px">
      虚线脉冲：请求触发 → 绘出 → 淡出（不常驻全热池）
    </div>
  `;
}

function renderHotStats(hotCount) {
  const el = document.getElementById("hot-stats");
  if (!el) return;
  el.textContent =
    hotCount != null ? `热池存活 IP：${hotCount}（仅被请求的 IP 才出现弹道脉冲）` : "";
}

/** @type {Map<string, HTMLTableRowElement>} */
const ipStatsRowEls = new Map();

/** @type {number} */
let ipStatsFullGen = -1;

/** limit: 0 = HTTP 灌全量（在 IP Stats Worker）；WS 只推摘要 + 增量 */
const IP_STATS_WATCH_LIMIT = 0;

function currentRequestHostname() {
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById("fetch-url"));
  const raw = (input?.value || config.demoFetchUrl || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** 主线程只发指令；IDB/合并/HTTP 全在 IP Stats Worker */
function watchIpStatsHostname() {
  ensureWorkers();
  const hostname = currentRequestHostname();
  const domainEl = document.getElementById("ip-stats-domain");
  if (domainEl) {
    domainEl.textContent = hostname ? `域名：${hostname}` : "填写上方 URL 后显示该域名统计";
  }
  ipStatsWorker?.postMessage({ type: "watch", hostname });
  if (wsConnected) {
    wsSend({ type: "watchIpStats", hostname, limit: IP_STATS_WATCH_LIMIT });
  }
}

/**
 * 主线程只做 DOM（Worker 下发的轻量 UI 指令）
 * @param {{
 *   action: string;
 *   hint?: string;
 *   meta?: object;
 *   gen?: number;
 *   total?: number;
 *   rows?: object[];
 *   upsert?: object[];
 *   done?: boolean;
 * }} cmd
 */
function applyIpStatsUiCommand(cmd) {
  if (!cmd) return;
  if (cmd.action === "clear") {
    ipStatsRowEls.clear();
    ipStatsFullGen = -1;
    renderIpStatsView(null, cmd.hint || "等待数据…");
    return;
  }
  if (cmd.action === "summary") {
    renderIpStatsSummaryFromMeta(cmd.meta);
    if (cmd.meta?.hostname) {
      const domainEl = document.getElementById("ip-stats-domain");
      if (domainEl) domainEl.textContent = `域名：${cmd.meta.hostname}`;
    }
    return;
  }
  if (cmd.action === "fullStart") {
    ipStatsFullGen = cmd.gen ?? 0;
    const tbody = document.querySelector("#ip-stats-table tbody");
    if (tbody) tbody.innerHTML = "";
    ipStatsRowEls.clear();
    renderIpStatsSummaryFromMeta(cmd.meta);
    if (cmd.meta?.hostname) {
      const domainEl = document.getElementById("ip-stats-domain");
      if (domainEl) domainEl.textContent = `域名：${cmd.meta.hostname}`;
    }
    return;
  }
  if (cmd.action === "fullChunk") {
    if (cmd.gen !== ipStatsFullGen) return;
    const tbody = document.querySelector("#ip-stats-table tbody");
    if (!tbody) return;
    const frag = document.createDocumentFragment();
    for (const row of cmd.rows ?? []) {
      if (!row?.ip) continue;
      const tr = createIpStatsRowEl(row);
      ipStatsRowEls.set(String(row.ip), tr);
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    return;
  }
  if (cmd.action === "patch") {
    renderIpStatsSummaryFromMeta(cmd.meta);
    patchIpStatsRows(cmd.upsert ?? []);
  }
}

/** @param {object | undefined} meta */
function renderIpStatsSummaryFromMeta(meta) {
  const summary = document.getElementById("ip-stats-summary");
  if (!summary) return;
  if (!meta?.hostname) {
    summary.textContent = "等待数据…";
    return;
  }
  summary.textContent =
    `共 ${meta.totalIps ?? "?"} IP · 有请求 ${meta.activeIps ?? "?"}` +
    `（v4 ${meta.activeIpv4 ?? "?"} / v6 ${meta.activeIpv6 ?? "?"}）· ` +
    `req ${meta.totalRequests ?? 0} · ok ${meta.totalSuccess ?? 0} · fail ${meta.totalFailed ?? 0} · ` +
    `${formatBytes(meta.totalBytes ?? 0)}` +
    (meta.updatedAt ? ` · ${String(meta.updatedAt).replace("T", " ").slice(0, 19)}` : "");
}

/**
 * @param {object[]} upsert
 */
function patchIpStatsRows(upsert) {
  const tbody = document.querySelector("#ip-stats-table tbody");
  if (!tbody || !upsert?.length) return;
  for (const row of upsert) {
    if (!row?.ip) continue;
    const ip = String(row.ip);
    let tr = ipStatsRowEls.get(ip);
    if (tr) {
      fillIpStatsRowEl(tr, row);
    } else {
      tr = createIpStatsRowEl(row);
      ipStatsRowEls.set(ip, tr);
      tbody.appendChild(tr);
    }
  }
}

/**
 * @param {object} row
 * @returns {HTMLTableRowElement}
 */
function createIpStatsRowEl(row) {
  const tr = document.createElement("tr");
  fillIpStatsRowEl(tr, row);
  return tr;
}

/**
 * @param {HTMLTableRowElement} tr
 * @param {object} row
 */
function fillIpStatsRowEl(tr, row) {
  const place = [row.city, row.country].filter(Boolean).join(", ");
  const family = row.family ?? (String(row.ip).includes(":") ? "ipv6" : "ipv4");
  const hasCoord = Number.isFinite(row.lat) && Number.isFinite(row.lng);
  tr.dataset.ip = String(row.ip);
  tr.classList.toggle("clickable", hasCoord);
  tr.title = hasCoord
    ? `定位到 ${row.ip}${place ? ` · ${place}` : ""}`
    : place || "无坐标";
  tr.onclick = hasCoord ? () => focusIpOnMap(row.lat, row.lng, row.ip) : null;
  tr.innerHTML = `
      <td class="family">${family === "ipv6" ? "v6" : "v4"}</td>
      <td title="${escapeHtml(place)}">${escapeHtml(row.ip)}</td>
      <td class="num">${row.requests}</td>
      <td class="num">${row.success}</td>
      <td class="num">${row.failed}</td>
      <td class="num">${formatBytes(row.totalBytes)}</td>
      <td class="num">${row.avgDurationMs} ms</td>
    `;
}

/**
 * @param {null | undefined} data
 * @param {string} [emptyHint]
 */
function renderIpStatsView(data, emptyHint) {
  const summary = document.getElementById("ip-stats-summary");
  const tbody = document.querySelector("#ip-stats-table tbody");
  if (!summary || !tbody) return;
  if (!data) {
    summary.textContent = emptyHint || "未启用 IP 统计（检查 fetchMetrics.ipStatsDir）";
    tbody.innerHTML = "";
    ipStatsRowEls.clear();
  }
}

/**
 * @param {number} lat
 * @param {number} lng
 * @param {string} ip
 */
function focusIpOnMap(lat, lng, ip) {
  if (!map || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    setStatus(`无坐标：${ip}`);
    return;
  }
  map.flyTo([lat, lng], Math.max(map.getZoom(), 5), { duration: 0.8 });
  setStatus(`定位 ${ip} · ${lat.toFixed(3)}, ${lng.toFixed(3)}`);
}

/** @param {number} n */
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function renderRouteList(paths) {
  const ul = document.getElementById("route-list");
  ul.innerHTML = "";
  if (!paths) return;
  for (const p of paths.slice(0, 20)) {
    const li = document.createElement("li");
    const status = Number(p.httpStatus);
    const ok = Number.isFinite(status) && status >= 200 && status < 300;
    const viaHot = p.viaHot === true;
    const http2 = p.http2 === true;
    const color = ok ? (p.routeColor ?? "#64748b") : "#ef4444";
    li.style.borderLeftColor = color;
    li.style.setProperty("--route-color", color);
    if (!ok) li.classList.add("alert");
    if (!viaHot || !http2) li.classList.add("warn-transport");
    const remoteMs = Number.isFinite(p.totalDurationMs) ? Math.round(p.totalDurationMs) : null;
    // 热连接+H2 却远程等待过久：多半是对端 idle 拆连后静默重建 TLS/H2
    const suspectReconnect = viaHot && http2 && remoteMs != null && remoteMs >= 2000;
    if (suspectReconnect) li.classList.add("warn-slow");
    const ms = remoteMs != null ? `${remoteMs} ms` : "? ms";
    const statusText = Number.isFinite(status) ? `HTTP ${status}` : "请求失败";
    const transport = [
      viaHot ? '<span class="tag hot">热连接</span>' : '<span class="tag cold">冷连接</span>',
      http2 ? '<span class="tag h2">H2</span>' : '<span class="tag h1">非 H2</span>',
      suspectReconnect ? '<span class="tag slow">疑似重连</span>' : "",
    ]
      .filter(Boolean)
      .join(" ");
    li.innerHTML = `
      <div><strong>${escapeHtml(String(p.pinnedIp ?? "?"))}</strong></div>
      <div class="meta">${escapeHtml(String(p.targetCity ?? p.targetLabel ?? ""))}</div>
      <div class="meta">${ok ? "" : '<span class="alert-badge">警报</span> '}${transport} · 远程 ${ms} · ${statusText} · ${formatBytes(p.bodyBytes ?? 0)}</div>
    `;
    ul.appendChild(li);
  }
}

async function triggerFetch() {
  const input = /** @type {HTMLInputElement} */ (document.getElementById("fetch-url"));
  const url = input.value.trim();
  if (!url) {
    setStatus("请填写 URL");
    return;
  }
  const btn = document.getElementById("btn-fetch");
  btn.disabled = true;
  setStatus("Fetch 进行中…");

  if (wsConnected) {
    wsSend({ type: "fetch", url });
    // 结果经 WS fetchResult 回来，不堵主线程
    return;
  }

  try {
    const res = await fetch("/api/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok && res.status !== 202) throw new Error(data.error ?? res.statusText);
    if (res.status === 202) {
      setStatus("Fetch 已异步提交，等待结果…");
      return;
    }
    setStatus(`完成 ${data.flightPath?.totalDurationMs ?? "?"} ms`);
  } catch (err) {
    setStatus(`Fetch 失败: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    btn.disabled = false;
  }
}

async function triggerStress() {
  const input = /** @type {HTMLInputElement} */ (document.getElementById("fetch-url"));
  const url = input.value.trim() || config.demoFetchUrl || undefined;
  const btn = document.getElementById("btn-stress");
  btn.disabled = true;
  setStatus("高并发压测启动中…");

  if (wsConnected) {
    wsSend({ type: "stress", url });
    // 结果经 WS stressResult 回来
    return;
  }

  try {
    const res = await fetch("/api/stress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok && res.status !== 202) throw new Error(data.error ?? res.statusText);
    if (res.status === 202) {
      setStatus("压测已异步启动，等待 WS 结果…");
      return;
    }
    setStatus(
      `压测完成 成功 ${data.succeeded}/${data.total} · 失败 ${data.failed} · ${data.elapsedMs} ms`,
    );
  } catch (err) {
    setStatus(`压测失败: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    btn.disabled = false;
  }
}

async function triggerResetIpStats() {
  const hostname = currentRequestHostname();
  if (!hostname) {
    setStatus("请先填写请求 URL（用于确定域名）");
    return;
  }
  if (!confirm(`重置 ${hostname} 的 IP 请求统计，并清零热池派发计数？`)) return;

  const btn = document.getElementById("btn-reset-ip-stats");
  if (btn) btn.disabled = true;
  setStatus(`正在重置 ${hostname} 统计…`);

  // 先清本地库，避免旧数闪回
  ipStatsWorker?.postMessage({ type: "resetLocal", hostname });

  if (wsConnected) {
    wsSend({ type: "resetIpStats", hostname });
    return;
  }

  try {
    const res = await fetch("/api/ip-stats/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error ?? res.statusText);
    setStatus(
      `统计已重置 ${data.hostname} · ${data.resetIps ?? 0} IP · 派发计数清零 ${data.resetAssignSlots ?? 0}`,
    );
    watchIpStatsHostname();
  } catch (err) {
    setStatus(`重置失败: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function main() {
  await loadConfig();
  try {
    await loadMapAssets();
  } catch (err) {
    setStatus(`地图资源加载失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  const urlInput = /** @type {HTMLInputElement} */ (document.getElementById("fetch-url"));
  urlInput.value = config.demoFetchUrl ?? "";
  urlInput.addEventListener("change", () => watchIpStatsHostname());
  urlInput.addEventListener("input", () => {
    clearTimeout(urlInput._ipStatsTimer);
    urlInput._ipStatsTimer = setTimeout(() => watchIpStatsHostname(), 400);
  });
  document.getElementById("btn-fetch").addEventListener("click", () => void triggerFetch());
  document.getElementById("btn-stress").addEventListener("click", () => void triggerStress());
  document
    .getElementById("btn-reset-ip-stats")
    ?.addEventListener("click", () => void triggerResetIpStats());
  await initMap();
  if (mapOrigin) {
    map?.setView([mapOrigin.lat, mapOrigin.lng], 3);
  }
  watchIpStatsHostname();
}

void main();
