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
  routeHoldMs: 16000,
  routeFadeMs: 4000,
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

/**
 * @typedef {{
 *   id: string;
 *   color: string;
 *   idleColor: string;
 *   latlngs: L.LatLng[];
 *   bornAt: number;
 *   drawMs: number;
 *   holdMs: number;
 *   fadeMs: number;
 *   pinnedIp?: string;
 *   active: boolean;
 * }} RoutePulse
 */

/** @type {Map<string, RoutePulse>} */
const pulses = new Map();

/** 未激活线路颜色（预绘骨架） */
const IDLE_ROUTE_COLOR = "#64748b";
/** 未激活透明度 */
const IDLE_ROUTE_ALPHA = 0.28;

/** @type {object[]} */
let recentPulsePaths = [];

/** 压测进行中：避免 poolStatus / 普通脉冲文案盖掉进度 */
let stressActive = false;

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
  setStatus(
    `已缓存 ${ipCatalog.size} 个 IP · 落点 ${countUniqueRouteKeys()} 处 · 原点 ${mapOrigin?.city ?? mapOrigin?.label ?? "?"}`,
  );
}

/**
 * 统计目录中唯一落点（与绘制键一致）。
 * @returns {number}
 */
function countUniqueRouteKeys() {
  const keys = new Set();
  for (const [ip, info] of ipCatalog) {
    keys.add(pulseRouteKey(info.lat, info.lng, ip));
  }
  return keys.size;
}

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

function animTiming(override) {
  return {
    drawMs: Number(override?.drawMs ?? config.routeDrawMs) || 1400,
    holdMs: Number(override?.holdMs ?? config.routeHoldMs) || 16000,
    fadeMs: Number(override?.fadeMs ?? config.routeFadeMs) || 4000,
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

/** 虚线航线层：落点预绘灰骨架 → 请求点亮换色 → 淡回灰 */
function createPulseRouteLayer() {
  return L.Layer.extend({
    initialize() {
      this._pulses = [];
      this._canvas = null;
      this._ctx = null;
      this._onView = null;
      this._onZoomStart = null;
      this._onZoomEnd = null;
      this._raf = 0;
      /** 缩放动画中冻结重绘，避免 CSS transform 与 container 坐标双重变换 */
      this._zoomLock = false;
    },

    onAdd(mapInst) {
      this._map = mapInst;
      if (!this._canvas) {
        // 不要加 leaflet-zoom-animated：缩放时 CSS transform 会与自绘 container 坐标冲突
        this._canvas = L.DomUtil.create("canvas", "flight-pulse-routes");
        this._canvas.style.position = "absolute";
        this._canvas.style.left = "0";
        this._canvas.style.top = "0";
        this._canvas.style.pointerEvents = "none";
        this._ctx = this._canvas.getContext("2d");
      }
      mapInst.getPanes().overlayPane.appendChild(this._canvas);
      this._onZoomStart = () => {
        this._zoomLock = true;
      };
      this._onZoomEnd = () => {
        this._zoomLock = false;
        this._scheduleRedraw();
      };
      this._onView = () => {
        if (this._zoomLock) return;
        this._scheduleRedraw();
      };
      mapInst.on("zoomstart", this._onZoomStart);
      mapInst.on("zoomend", this._onZoomEnd);
      // 缩放过程中不跟 zoom 事件重画；平移/结束/尺寸变化再画
      mapInst.on("move moveend resize viewreset", this._onView);
      this._redraw(performance.now());
    },

    onRemove(mapInst) {
      if (this._onZoomStart) {
        mapInst.off("zoomstart", this._onZoomStart);
        this._onZoomStart = null;
      }
      if (this._onZoomEnd) {
        mapInst.off("zoomend", this._onZoomEnd);
        this._onZoomEnd = null;
      }
      if (this._onView) {
        mapInst.off("move moveend resize viewreset", this._onView);
        this._onView = null;
      }
      if (this._canvas?.parentNode) {
        this._canvas.parentNode.removeChild(this._canvas);
      }
      this._map = null;
      this._zoomLock = false;
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
      if (this._zoomLock) return;
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
      // 缩放动画中：父级 pane 已有 CSS 缩放，禁止用新 zoom 的 container 坐标重画
      if (this._zoomLock) return;

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

      const lngOffsets = visibleWorldLngOffsets(mapInst);

      for (const pulse of live) {
        if (pulse.latlngs.length < 2) continue;

        // 未激活：灰色常驻全长，作为预热骨架
        if (!pulse.active) {
          ctx.globalAlpha = IDLE_ROUTE_ALPHA;
          ctx.strokeStyle = pulse.idleColor || IDLE_ROUTE_COLOR;
          ctx.lineDashOffset = 0;
          for (const off of lngOffsets) {
            strokeLatLngPath(ctx, mapInst, pulse.latlngs, off);
            const head = pulse.latlngs[pulse.latlngs.length - 1];
            const hp = mapInst.latLngToContainerPoint([head.lat, head.lng + off]);
            ctx.setLineDash([]);
            ctx.fillStyle = pulse.idleColor || IDLE_ROUTE_COLOR;
            ctx.beginPath();
            ctx.arc(hp.x, hp.y, 2.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.setLineDash([7, 9]);
          }
          continue;
        }

        const age = now - pulse.bornAt;
        const life = pulse.drawMs + pulse.holdMs + pulse.fadeMs;
        if (age >= life) continue;

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

        for (const off of lngOffsets) {
          strokeLatLngPath(ctx, mapInst, pts, off);
          const head = pts[pts.length - 1];
          const hp = mapInst.latLngToContainerPoint([head.lat, head.lng + off]);
          ctx.setLineDash([]);
          ctx.fillStyle = pulse.color;
          ctx.beginPath();
          ctx.arc(hp.x, hp.y, 2.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.setLineDash([7, 9]);
        }
      }

      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    },
  });
}

/**
 * 当前视口需要绘制的世界副本经度偏移（缩小后可左右穿越多份地图）。
 * @param {L.Map} mapInst
 * @returns {number[]}
 */
function visibleWorldLngOffsets(mapInst) {
  const b = mapInst.getBounds();
  const west = b.getWest();
  const east = b.getEast();
  /** 视口跨度可能 >360（缩得很小） */
  const pad = 360;
  let kMin = Math.floor((west - pad) / 360);
  let kMax = Math.ceil((east + pad) / 360);
  // 防止极端缩放下副本过多
  if (kMax - kMin > 4) {
    const mid = Math.round((kMin + kMax) / 2);
    kMin = mid - 2;
    kMax = mid + 2;
  }
  /** @type {number[]} */
  const offsets = [];
  for (let k = kMin; k <= kMax; k++) offsets.push(k * 360);
  if (offsets.length === 0) offsets.push(0);
  return offsets;
}

/**
 * 在给定经度偏移下连续描线；若像素突变（跨副本缝）则断开，避免拉一根横穿整屏的错线。
 * @param {CanvasRenderingContext2D} ctx
 * @param {L.Map} mapInst
 * @param {L.LatLng[]} pts
 * @param {number} lngOffset
 */
function strokeLatLngPath(ctx, mapInst, pts, lngOffset) {
  if (pts.length < 2) return;
  const maxJump = Math.max(mapInst.getSize().x, mapInst.getSize().y) * 0.85;
  ctx.beginPath();
  let prev = mapInst.latLngToContainerPoint([pts[0].lat, pts[0].lng + lngOffset]);
  ctx.moveTo(prev.x, prev.y);
  for (let i = 1; i < pts.length; i++) {
    const p = mapInst.latLngToContainerPoint([pts[i].lat, pts[i].lng + lngOffset]);
    if (Math.hypot(p.x - prev.x, p.y - prev.y) > maxJump) {
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    } else {
      ctx.lineTo(p.x, p.y);
    }
    prev = p;
  }
  ctx.stroke();
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

  const seeded = seedRoutesFromCatalog();
  if (seeded > 0) {
    setStatus(`已预绘 ${seeded} 条落点航线（灰）· IP 目录 ${ipCatalog.size}`);
  }

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

/**
 * 弹道路线键：相同落点坐标共用一条线（无坐标时回退到 IP）。
 * @param {number} lat
 * @param {number} lng
 * @param {string} ip
 * @returns {string}
 */
function pulseRouteKey(lat, lng, ip) {
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return `ll:${lat.toFixed(4)},${lng.toFixed(4)}`;
  }
  return `ip:${ip}`;
}

/**
 * 按目录落点预绘全部线路（灰色骨架）；同坐标只一条。
 * @returns {number} 输出：`number` — 预绘线路数
 */
function seedRoutesFromCatalog() {
  if (!mapOrigin) return 0;
  const timing = animTiming();
  /** @type {Map<string, { lat: number; lng: number; ip: string }>} */
  const byKey = new Map();
  for (const [ip, info] of ipCatalog) {
    if (!Number.isFinite(info.lat) || !Number.isFinite(info.lng)) continue;
    const key = pulseRouteKey(info.lat, info.lng, ip);
    if (!byKey.has(key)) byKey.set(key, { lat: info.lat, lng: info.lng, ip });
  }

  let seeded = 0;
  for (const [key, { lat, lng, ip }] of byKey) {
    if (pulses.has(key)) continue;
    const visual = visualFromIp(ip, config);
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
    pulses.set(key, {
      id: key,
      color: IDLE_ROUTE_COLOR,
      idleColor: IDLE_ROUTE_COLOR,
      latlngs,
      bornAt: 0,
      drawMs: timing.drawMs,
      holdMs: timing.holdMs,
      fadeMs: timing.fadeMs,
      pinnedIp: ip,
      active: false,
    });
    seeded += 1;
  }
  syncPulseLayer();
  if (!didInitialFit && routeLayer && pulses.size > 0) {
    const bounds = routeLayer.getBounds();
    if (bounds.isValid()) {
      map?.fitBounds(bounds, { padding: [40, 40], maxZoom: 5 });
      didInitialFit = true;
    }
  }
  return seeded;
}

function activatePulseItems(items) {
  const timing = animTiming();
  const now = performance.now();
  let changed = 0;

  // 同一批内按落点坐标去重：同坐标只保留最后一次（换色激活）
  /** @type {Map<string, { item: object; lat: number; lng: number; ip: string }>} */
  const byRoute = new Map();
  for (const item of items ?? []) {
    const id = String(item.id ?? "");
    const ip = String(item.ip ?? "");
    if (!id || !ip) continue;

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
        country: item.country,
      });
    }
    const key = pulseRouteKey(lat, lng, ip);
    byRoute.set(key, { item, lat, lng, ip });
  }

  for (const [key, { item, lat, lng, ip }] of byRoute) {
    const id = String(item.id ?? "");
    const known = ipCatalog.get(ip);
    if (!mapOrigin || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const status = Number(item.st);
    const ok = Number.isFinite(status) && status >= 200 && status < 300;
    const visual = visualFromIp(ip, config);
    const color = ok ? visual.color : "#ef4444";

    const existing = pulses.get(key);
    if (existing) {
      // 预绘骨架上激活：只换 IP 色并重启动画
      existing.id = id;
      existing.color = color;
      existing.bornAt = now;
      existing.drawMs = timing.drawMs;
      existing.holdMs = timing.holdMs;
      existing.fadeMs = timing.fadeMs;
      existing.pinnedIp = ip;
      existing.active = true;
      changed += 1;
    } else {
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

      pulses.set(key, {
        id,
        color,
        idleColor: IDLE_ROUTE_COLOR,
        latlngs,
        bornAt: now,
        drawMs: timing.drawMs,
        holdMs: timing.holdMs,
        fadeMs: timing.fadeMs,
        pinnedIp: ip,
        active: true,
      });
      changed += 1;
    }

    recentPulsePaths = [
      {
        requestId: id,
        pinnedIp: ip,
        routeColor: color,
        totalDurationMs: item.ms,
        httpStatus: item.st,
        bodyBytes: item.b,
        targetCity: item.city ?? known?.city,
        targetCountry: item.country ?? known?.country,
        requestPath: item.path,
        viaHot: item.via === "hot",
        http2: item.h2 === true,
      },
      ...recentPulsePaths,
    ].slice(0, 20);
  }

  if (changed > 0) {
    syncPulseLayer();
    renderRouteList(recentPulsePaths);
  }
  return changed;
}

function syncPulseLayer() {
  if (!routeLayer) return;
  routeLayer.setPulses([...pulses.values()]);
}

function pruneDeadPulses(now) {
  let changed = false;
  for (const p of pulses.values()) {
    if (!p.active) continue;
    if (now - p.bornAt >= p.drawMs + p.holdMs + p.fadeMs) {
      // 淡出结束：回到灰色骨架，不删除线路
      p.active = false;
      p.color = p.idleColor || IDLE_ROUTE_COLOR;
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
      if (stressActive) {
        stressActive = false;
        const btn = document.getElementById("btn-stress");
        if (btn) btn.disabled = false;
      }
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
    if (!stressActive) {
      const activeN = [...pulses.values()].filter((p) => p.active).length;
      setStatus(`WS · 热池 ${msg.hotCount ?? 0} · 航线 ${pulses.size} · 点亮 ${activeN}`);
    }
    return;
  }

  if (msg.type === "nicTraffic") {
    applyNicTraffic(msg);
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
    if (!stressActive) {
      const activeN = [...pulses.values()].filter((p) => p.active).length;
      setStatus(`点亮 +${n} · 航线 ${pulses.size} · 激活中 ${activeN}`);
    }
    return;
  }

  if (msg.type === "routeList" || msg.type === "flightPaths") {
    if (msg.stats) renderStats(msg.stats);
    if (msg.hotCount != null) renderHotStats(msg.hotCount);
    return;
  }

  if (msg.type === "stressStatus") {
    const btn = document.getElementById("btn-stress");
    if (msg.status === "accepted") {
      stressActive = true;
      if (btn) btn.disabled = true;
      setStatus("高并发压测已受理，正在拉起…");
    } else if (msg.status === "running") {
      stressActive = true;
      if (btn) btn.disabled = true;
      const done = msg.done ?? (msg.succeeded ?? 0) + (msg.failed ?? 0);
      const total = msg.total ?? "?";
      const elapsed =
        msg.elapsedMs != null ? ` · ${Math.round(msg.elapsedMs / 1000)}s` : "";
      setStatus(
        `高并发压测中… ${done}/${total}（成 ${msg.succeeded ?? 0} / 败 ${msg.failed ?? 0}）· 并发 ${msg.concurrency ?? "?"} · 热池 ${msg.hotCount ?? "?"}${elapsed}`,
      );
    } else if (msg.status === "done") {
      stressActive = false;
      if (btn) btn.disabled = false;
      setStatus(
        `压测完成 成功 ${msg.succeeded}/${msg.total} · 失败 ${msg.failed} · ${msg.elapsedMs} ms`,
      );
    }
    return;
  }

  if (msg.type === "stressResult") {
    stressActive = false;
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
      // 点击时已 resetLocal；服务端已 push 空摘要，勿再清一次把总数冲成 0
    } else {
      setStatus(`重置失败: ${msg.error ?? "unknown"}`);
    }
  }
}

function renderStats(stats) {
  const el = document.getElementById("test-stats");
  if (!el) return;
  if (!stats) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <div>请求 ${stats.submitted} · 成功 ${stats.succeeded} · 失败 ${stats.failed} · 进行中 ${stats.inFlight ?? 0}</div>
    <div class="legend">灰线=落点骨架 · 彩色=该落点被请求点亮 · 超时淡回灰</div>
  `;
}

function renderHotStats(hotCount) {
  const el = document.getElementById("hot-stats");
  if (!el) return;
  el.textContent =
    hotCount != null ? `热池存活 IP：${hotCount}` : "热池：等待…";
}

/** @type {Map<string, HTMLTableRowElement>} */
const ipStatsRowEls = new Map();

/** @type {number} */
let ipStatsFullGen = -1;

/** 用户拖拽后的请求日志顺序（requestId） */
/** @type {string[]} */
let routeListManualOrder = [];

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
  setIpStatsMetaHost(hostname);
  ipStatsWorker?.postMessage({
    type: "watch",
    hostname,
    // 无 WS 时才 HTTP 兜底；有 WS 则等滚动窗口推送
    bootstrapHttp: !wsConnected,
  });
  if (wsConnected) {
    wsSend({ type: "watchIpStats", hostname, limit: IP_STATS_WATCH_LIMIT });
    requestIpStatsWindowFromScroll();
  }
}

/**
 * 采集 IP 统计表当前可视行。
 * @returns {string[]}
 */
function collectVisibleIpStatsIps() {
  const wrap = document.querySelector(".ip-stats-table-wrap");
  if (!wrap) return [];
  const box = wrap.getBoundingClientRect();
  /** @type {string[]} */
  const ips = [];
  for (const tr of wrap.querySelectorAll("tbody tr[data-ip]")) {
    if (!(tr instanceof HTMLElement)) continue;
    const r = tr.getBoundingClientRect();
    if (r.bottom < box.top || r.top > box.bottom) continue;
    const ip = tr.dataset.ip;
    if (ip) ips.push(ip);
  }
  return ips;
}

/** @type {number} */
let visibleIpStatsTimer = 0;
const IP_STATS_ROW_H = 28;
/** @type {number} */
let ipStatsListTotal = 0;
/** @type {number} */
let ipStatsWinStart = 0;
/** @type {number} */
let ipStatsWinEnd = 0;
/** @type {string} */
let ipStatsCountryFilter = "";
/** @type {object[]} */
let lastIpByCountry = [];

function updateIpStatsWindowLabel() {
  const el = document.getElementById("ip-stats-window");
  if (!el) return;
  if (ipStatsListTotal <= 0) {
    el.textContent = ipStatsCountryFilter
      ? `本屏：— · 筛选 ${ipStatsCountryFilter === "ZZ" ? "未知" : ipStatsCountryFilter}`
      : "本屏：—";
    return;
  }
  const a = ipStatsWinStart + 1;
  const b = Math.max(a, ipStatsWinEnd);
  const filterHint = ipStatsCountryFilter
    ? ` · ${ipStatsCountryFilter === "ZZ" ? "未知" : ipStatsCountryFilter}`
    : "";
  el.textContent = `本屏第 ${a}–${b} 条 · 共 ${ipStatsListTotal} 条${filterHint}（可滚动）`;
}

/** 按滚动位置向服务端要当前窗口行 */
function requestIpStatsWindowFromScroll() {
  if (!wsConnected) return;
  const hostname = currentRequestHostname();
  if (!hostname) return;
  const wrap = document.querySelector(".ip-stats-table-wrap");
  if (!wrap) return;
  clearTimeout(visibleIpStatsTimer);
  visibleIpStatsTimer = window.setTimeout(() => {
    const start = Math.max(0, Math.floor(wrap.scrollTop / IP_STATS_ROW_H) - 2);
    const count = Math.max(12, Math.ceil(wrap.clientHeight / IP_STATS_ROW_H) + 8);
    wsSend({
      type: "ipStatsWindow",
      hostname,
      start,
      count,
      country: ipStatsCountryFilter || null,
    });
  }, 80);
}

function reportVisibleIpStats() {
  requestIpStatsWindowFromScroll();
}

function setupVisibleIpStatsObserver() {
  const wrap = document.querySelector(".ip-stats-table-wrap");
  if (!wrap) return;
  wrap.addEventListener("scroll", () => requestIpStatsWindowFromScroll(), { passive: true });
  window.addEventListener("resize", () => requestIpStatsWindowFromScroll());
  setupCountryFlagsClick();
  requestIpStatsWindowFromScroll();
}

/**
 * @param {string} code
 * @returns {string}
 */
function countryDisplayName(code) {
  if (code === "ZZ") return "未知";
  try {
    return new Intl.DisplayNames(["zh-CN"], { type: "region" }).of(code) || code;
  } catch {
    return code;
  }
}

/**
 * @param {string} code
 */
function setIpStatsCountryFilter(code) {
  const next = String(code ?? "").trim().toUpperCase();
  ipStatsCountryFilter = !next || next === "ALL" ? "" : next;
  const wrap = document.querySelector(".ip-stats-table-wrap");
  if (wrap) wrap.scrollTop = 0;
  renderCountryFlags(lastIpByCountry);
  requestIpStatsWindowFromScroll();
}

function setupCountryFlagsClick() {
  const host = document.getElementById("ip-country-flags");
  if (!host || host.dataset.bound === "1") return;
  host.dataset.bound = "1";
  host.addEventListener("click", (ev) => {
    const btn =
      ev.target instanceof Element ? ev.target.closest("[data-country]") : null;
    if (!(btn instanceof HTMLElement)) return;
    const code = btn.getAttribute("data-country") || "ALL";
    if (code === "ALL" || code === ipStatsCountryFilter) {
      setIpStatsCountryFilter("");
    } else {
      setIpStatsCountryFilter(code);
    }
  });
}

/**
 * @param {object[] | undefined} list
 */
function renderCountryFlags(list) {
  const host = document.getElementById("ip-country-flags");
  if (!host) return;
  lastIpByCountry = Array.isArray(list) ? list : [];
  /** @type {string[]} */
  const parts = [
    `<button type="button" class="ip-flag-all${
      ipStatsCountryFilter ? "" : " is-active"
    }" data-country="ALL" title="显示全部国家">全</button>`,
  ];
  for (const c of lastIpByCountry) {
    const code = String(c.code || "ZZ").toUpperCase();
    const name = countryDisplayName(code);
    const tip = `${name}（${code}） · IP ${c.ips ?? 0} 个 · 请求 ${c.requests ?? 0}（成功 ${c.success ?? 0} / 失败 ${c.failed ?? 0}） · ${formatBytes(c.totalBytes ?? 0)}`;
    const active = ipStatsCountryFilter === code ? " is-active" : "";
    if (code === "ZZ") {
      parts.push(
        `<button type="button" class="ip-flag-btn ip-flag-unknown${active}" data-country="ZZ" title="${escapeHtml(tip)}">?</button>`,
      );
    } else {
      const src = `https://flagcdn.com/w20/${code.toLowerCase()}.png`;
      parts.push(
        `<button type="button" class="ip-flag-btn${active}" data-country="${escapeHtml(code)}" title="${escapeHtml(tip)}"><img src="${src}" alt="${escapeHtml(code)}" width="20" height="14" loading="lazy" decoding="async" /></button>`,
      );
    }
  }
  host.innerHTML = parts.join("");
}

/**
 * 渲染滚动窗口（含上下占位，保持总高度可滚完全表）。
 * @param {object | undefined} meta
 * @param {{ total?: number; start?: number; end?: number } | undefined} win
 * @param {object[]} upsert
 */
function renderIpStatsWindowView(meta, win, upsert) {
  renderIpStatsSummaryFromMeta(meta);
  const total = Number(win?.total) || 0;
  const start = Number(win?.start) || 0;
  const end = Number(win?.end) || 0;
  ipStatsListTotal = total;
  ipStatsWinStart = start;
  ipStatsWinEnd = end;
  updateIpStatsWindowLabel();

  const tbody = document.querySelector("#ip-stats-table tbody");
  const wrap = document.querySelector(".ip-stats-table-wrap");
  if (!tbody) return;
  const keepScroll = wrap?.scrollTop ?? 0;
  tbody.innerHTML = "";
  ipStatsRowEls.clear();

  if (start > 0) {
    const spacer = document.createElement("tr");
    spacer.className = "ip-stats-spacer";
    spacer.innerHTML = `<td colspan="9" style="height:${start * IP_STATS_ROW_H}px;padding:0;border:0;line-height:0"></td>`;
    tbody.appendChild(spacer);
  }
  for (const row of upsert) {
    if (!row?.ip) continue;
    const tr = createIpStatsRowEl(row);
    ipStatsRowEls.set(String(row.ip), tr);
    tbody.appendChild(tr);
  }
  if (end < total) {
    const spacer = document.createElement("tr");
    spacer.className = "ip-stats-spacer";
    spacer.innerHTML = `<td colspan="9" style="height:${(total - end) * IP_STATS_ROW_H}px;padding:0;border:0;line-height:0"></td>`;
    tbody.appendChild(spacer);
  }
  if (wrap) wrap.scrollTop = keepScroll;
  restoreIpFocusAfterTableRender();
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
    maybeRefreshIpStatsWindowForTotal(cmd.meta);
    return;
  }
  if (cmd.action === "fullStart") {
    ipStatsFullGen = cmd.gen ?? 0;
    const tbody = document.querySelector("#ip-stats-table tbody");
    if (tbody) tbody.innerHTML = "";
    ipStatsRowEls.clear();
    renderIpStatsSummaryFromMeta(cmd.meta);
    return;
  }
  if (cmd.action === "window") {
    renderIpStatsWindowView(cmd.meta, cmd.window, cmd.upsert ?? []);
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
    if (cmd.done) {
      applySavedIpRowOrder();
      reportVisibleIpStats();
    }
    return;
  }
  if (cmd.action === "patch") {
    scheduleIpStatsPatch(cmd.meta, cmd.upsert ?? []);
  }
}

/** @type {object | null} */
let pendingIpPatchMeta = null;
/** @type {Map<string, object>} */
const pendingIpPatchRows = new Map();
/** @type {number} */
let ipPatchRaf = 0;

/**
 * 合并同一帧内多次 patch，避免主线程连刷数千行 DOM。
 * @param {object | undefined} meta
 * @param {object[]} upsert
 */
/**
 * 活跃 IP 总数变化时重拉滚动窗口（编号与本屏范围会变）。
 * @param {object | undefined} meta
 */
function maybeRefreshIpStatsWindowForTotal(meta) {
  if (meta?.byCountry) renderCountryFlags(meta.byCountry);
  if (ipStatsCountryFilter) {
    updateIpStatsWindowLabel();
    return;
  }
  const active = Number(meta?.activeIps);
  if (!Number.isFinite(active)) return;
  if (active !== ipStatsListTotal) {
    requestIpStatsWindowFromScroll();
    return;
  }
  updateIpStatsWindowLabel();
}

function scheduleIpStatsPatch(meta, upsert) {
  if (meta) pendingIpPatchMeta = meta;
  for (const row of upsert) {
    if (row?.ip) pendingIpPatchRows.set(String(row.ip), row);
  }
  if (ipPatchRaf) return;
  ipPatchRaf = requestAnimationFrame(() => {
    ipPatchRaf = 0;
    const m = pendingIpPatchMeta;
    const rows = [...pendingIpPatchRows.values()];
    pendingIpPatchMeta = null;
    pendingIpPatchRows.clear();
    if (m) {
      renderIpStatsSummaryFromMeta(m);
      maybeRefreshIpStatsWindowForTotal(m);
    }
    // 窗口模式下只改已有行；新 IP 靠上面的窗口刷新进屏
    patchIpStatsRows(rows, { windowOnly: ipStatsListTotal > 0 });
  });
}

/** @param {string} hostname */
function setIpStatsMetaHost(hostname) {
  const el = document.getElementById("ip-meta-line-host");
  if (el) {
    el.textContent = hostname || "—";
  }
}

/** @param {object | undefined} meta */
function renderIpStatsSummaryFromMeta(meta) {
  const hint = document.getElementById("ip-stats-summary");
  const setHtml = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };
  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  if (!meta?.hostname) {
    setText("ip-meta-line-host", currentRequestHostname() || "—");
    setText("ip-meta-line-ip", "—");
    setText("ip-meta-line-req", "—");
    renderCountryFlags([]);
    if (hint) {
      hint.hidden = false;
      hint.textContent = "等待数据…";
    }
    return;
  }

  if (hint) {
    hint.hidden = true;
    hint.textContent = "";
  }
  const updated = meta.updatedAt
    ? String(meta.updatedAt).replace("T", " ").slice(0, 19)
    : "";
  setHtml(
    "ip-meta-line-host",
    `${escapeHtml(String(meta.hostname))}${
      updated ? ` <span class="meta-dim">${escapeHtml(updated)}</span>` : ""
    }`,
  );
  setText(
    "ip-meta-line-ip",
    `${meta.totalIps ?? "—"} 总数 · ${meta.activeIps ?? "—"} 有请求 · v4 ${meta.activeIpv4 ?? "—"} / v6 ${meta.activeIpv6 ?? "—"}`,
  );
  setText(
    "ip-meta-line-req",
    `${meta.totalRequests ?? 0} · 成功 ${meta.totalSuccess ?? 0} · 失败 ${meta.totalFailed ?? 0} · 业务 ${formatBytes(meta.totalBytes ?? 0)}`,
  );
  renderCountryFlags(meta.byCountry);
}

/**
 * @param {null | undefined} data
 * @param {string} [emptyHint]
 */
function renderIpStatsView(data, emptyHint) {
  const hint = document.getElementById("ip-stats-summary");
  const tbody = document.querySelector("#ip-stats-table tbody");
  if (!tbody) return;
  if (!data) {
    if (hint) {
      hint.hidden = false;
      hint.textContent = emptyHint || "未启用 IP 统计（检查 fetchMetrics.ipStatsDir）";
    }
    renderIpStatsSummaryFromMeta(undefined);
    tbody.innerHTML = "";
    ipStatsRowEls.clear();
  }
}

/**
 * @param {object[]} upsert
 * @param {{ windowOnly?: boolean }} [opts]
 */
function patchIpStatsRows(upsert, opts = {}) {
  const tbody = document.querySelector("#ip-stats-table tbody");
  if (!tbody || !upsert?.length) return;
  const windowOnly = Boolean(opts.windowOnly);
  let appended = false;
  for (const row of upsert) {
    if (!row?.ip) continue;
    const ip = String(row.ip);
    let tr = ipStatsRowEls.get(ip);
    if (tr) {
      updateIpStatsRowEl(tr, row);
    } else if (windowOnly) {
      // 滚动窗口模式：不向 tbody 乱塞新行，等 window 推送
      continue;
    } else {
      tr = createIpStatsRowEl(row);
      ipStatsRowEls.set(ip, tr);
      tbody.appendChild(tr);
      appended = true;
    }
  }
  // 仅新行才重排，避免每次补丁拖动 3000 节点
  if (appended) applySavedIpRowOrder();
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
 * 已有行：只改数字格，避免整行 innerHTML 重绘。
 * @param {HTMLTableRowElement} tr
 * @param {object} row
 */
function updateIpStatsRowEl(tr, row) {
  const place = [row.city, row.country].filter(Boolean).join(", ");
  const hasCoord = Number.isFinite(row.lat) && Number.isFinite(row.lng);
  tr.classList.toggle("clickable", hasCoord);
  applyIpRowAccentColor(tr, row.ip);
  tr.title = hasCoord
    ? `定位到 ${row.ip}${place ? ` · ${place}` : ""}`
    : place || "无坐标";
  tr.onclick = (ev) => {
    if (ev.target instanceof Element && ev.target.closest(".row-drag")) return;
    if (hasCoord) focusIpOnMap(row, tr);
  };
  const cells = tr.children;
  if (cells.length < 9) {
    fillIpStatsRowEl(tr, row);
    return;
  }
  if (row.index != null) cells[1].textContent = String(Number(row.index) + 1);
  cells[4].textContent = String(row.requests ?? 0);
  cells[5].textContent = String(row.success ?? 0);
  cells[6].textContent = String(row.failed ?? 0);
  cells[7].textContent = formatBytes(row.totalBytes ?? 0);
  cells[8].textContent = `${row.avgDurationMs ?? 0} ms`;
}

/**
 * @param {HTMLTableRowElement} tr
 * @param {object} row
 */
function fillIpStatsRowEl(tr, row) {
  const place = [row.city, row.country].filter(Boolean).join(", ");
  const family = row.family ?? (String(row.ip).includes(":") ? "ipv6" : "ipv4");
  const hasCoord = Number.isFinite(row.lat) && Number.isFinite(row.lng);
  const idx =
    row.index != null && Number.isFinite(Number(row.index))
      ? String(Number(row.index) + 1)
      : "—";
  tr.dataset.ip = String(row.ip);
  tr.classList.toggle("clickable", hasCoord);
  applyIpRowAccentColor(tr, row.ip);
  tr.title = hasCoord
    ? `定位到 ${row.ip}${place ? ` · ${place}` : ""}`
    : place || "无坐标";
  tr.onclick = (ev) => {
    if (ev.target instanceof Element && ev.target.closest(".row-drag")) return;
    if (hasCoord) focusIpOnMap(row, tr);
  };
  tr.innerHTML = `
      <td class="col-drag"><button type="button" class="row-drag" title="拖动换行" aria-label="拖动换行">⋮⋮</button></td>
      <td class="col-idx num">${idx}</td>
      <td class="family">${family === "ipv6" ? "v6" : "v4"}</td>
      <td title="${escapeHtml(place)}">${escapeHtml(row.ip)}</td>
      <td class="num">${row.requests}</td>
      <td class="num">${row.success}</td>
      <td class="num">${row.failed}</td>
      <td class="num">${formatBytes(row.totalBytes)}</td>
      <td class="num">${row.avgDurationMs} ms</td>
    `;
}

/** @type {L.LayerGroup | null} */
let ipFocusLayer = null;
/** @type {SVGSVGElement | null} */
let ipFocusConnectorSvg = null;
/** @type {SVGLineElement | null} */
let ipFocusConnectorLine = null;
/** @type {SVGLineElement | null} */
let ipFocusLeaderLine = null;
/** @type {HTMLElement | null} */
let ipFocusRowEl = null;
/** @type {string} */
let ipFocusSelectedIp = "";
/** @type {{ lat: number; lng: number; color: string } | null} */
let ipFocusAnchor = null;
/** @type {boolean} */
let ipFocusListenersBound = false;
/** @type {number} */
let ipFocusClearTimer = 0;
/** 选中连线自动消失（毫秒） */
const IP_FOCUS_TTL_MS = 10_000;

/**
 * 确保全屏连线 SVG（侧栏→落点 + 落点→信息卡短引线）。
 * @returns {SVGSVGElement}
 */
function ensureIpFocusConnectorSvg() {
  if (ipFocusConnectorSvg && ipFocusConnectorLine && ipFocusLeaderLine) {
    return ipFocusConnectorSvg;
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("ip-focus-connector-svg");
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.classList.add("ip-focus-connector-line");
  const leader = document.createElementNS("http://www.w3.org/2000/svg", "line");
  leader.classList.add("ip-focus-leader-line");
  svg.appendChild(line);
  svg.appendChild(leader);
  document.body.appendChild(svg);
  ipFocusConnectorSvg = svg;
  ipFocusConnectorLine = line;
  ipFocusLeaderLine = leader;
  return svg;
}

/**
 * 按当前选中 IP 找回表格行（窗口重绘后 DOM 会换）。
 * @returns {HTMLElement | null}
 */
function resolveIpFocusRowEl() {
  if (!ipFocusSelectedIp) return null;
  if (ipFocusRowEl && document.body.contains(ipFocusRowEl)) {
    const cur = ipFocusRowEl.dataset?.ip;
    if (cur === ipFocusSelectedIp) return ipFocusRowEl;
  }
  const hit =
    ipStatsRowEls.get(ipFocusSelectedIp) ||
    document.querySelector(
      `#ip-stats-table tbody tr[data-ip="${CSS.escape(ipFocusSelectedIp)}"]`,
    );
  if (hit instanceof HTMLElement) {
    ipFocusRowEl = hit;
    return hit;
  }
  ipFocusRowEl = null;
  return null;
}

/**
 * 连线起点：优先选中行；行暂不可见时落到侧栏左边。
 * @returns {{ x: number; y: number } | null}
 */
function ipFocusConnectorStart() {
  const row = resolveIpFocusRowEl();
  if (row) {
    const r = row.getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2 };
  }
  const panel = document.getElementById("panel") || document.querySelector("aside");
  if (panel) {
    const r = panel.getBoundingClientRect();
    return { x: r.left, y: r.top + Math.min(160, r.height * 0.25) };
  }
  return null;
}

/**
 * @param {number} x
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clampNum(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * 线段与轴对齐矩形是否相交（含端点在矩形内）。
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @param {{ left: number; top: number; right: number; bottom: number }} rect
 * @returns {boolean}
 */
function segmentIntersectsRect(x1, y1, x2, y2, rect) {
  const inside = (x, y) =>
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  if (inside(x1, y1) || inside(x2, y2)) return true;
  const edges = [
    [rect.left, rect.top, rect.right, rect.top],
    [rect.right, rect.top, rect.right, rect.bottom],
    [rect.right, rect.bottom, rect.left, rect.bottom],
    [rect.left, rect.bottom, rect.left, rect.top],
  ];
  for (const [ax, ay, bx, by] of edges) {
    if (segmentsIntersect(x1, y1, x2, y2, ax, ay, bx, by)) return true;
  }
  return false;
}

/**
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @param {number} d
 * @param {number} e
 * @param {number} f
 * @param {number} g
 * @param {number} h
 * @returns {boolean}
 */
function segmentsIntersect(a, b, c, d, e, f, g, h) {
  const cross = (x1, y1, x2, y2, x3, y3) => (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
  const d1 = cross(e, f, g, h, a, b);
  const d2 = cross(e, f, g, h, c, d);
  const d3 = cross(a, b, c, d, e, f);
  const d4 = cross(a, b, c, d, g, h);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

/**
 * 矩形外一点到矩形边界最近点。
 * @param {number} px
 * @param {number} py
 * @param {{ left: number; top: number; right: number; bottom: number }} rect
 * @returns {{ x: number; y: number }}
 */
function nearestPointOnRect(px, py, rect) {
  const cx = clampNum(px, rect.left, rect.right);
  const cy = clampNum(py, rect.top, rect.bottom);
  if (px > rect.left && px < rect.right && py > rect.top && py < rect.bottom) {
    const dl = px - rect.left;
    const dr = rect.right - px;
    const dt = py - rect.top;
    const db = rect.bottom - py;
    const m = Math.min(dl, dr, dt, db);
    if (m === dl) return { x: rect.left, y: py };
    if (m === dr) return { x: rect.right, y: py };
    if (m === dt) return { x: px, y: rect.top };
    return { x: px, y: rect.bottom };
  }
  return { x: cx, y: cy };
}

/**
 * 信息卡避让：躲开侧栏连线与地图边界，短引线只接到卡片边缘。
 */
function layoutIpFocusCard() {
  if (!map || !ipFocusAnchor) return;
  const card = document.querySelector(".leaflet-marker-icon .ip-focus-info");
  if (!(card instanceof HTMLElement)) return;

  const mapRect = map.getContainer().getBoundingClientRect();
  const pinPt = map.latLngToContainerPoint([ipFocusAnchor.lat, ipFocusAnchor.lng]);
  const pin = { x: mapRect.left + pinPt.x, y: mapRect.top + pinPt.y };
  const start = ipFocusConnectorStart();

  card.style.left = "0px";
  card.style.top = "0px";
  // 先按内容自然撑开，再量真实宽高做避让（不写死尺寸）
  card.style.width = "max-content";
  card.style.height = "auto";
  void card.offsetWidth;
  const cw = Math.max(1, card.offsetWidth);
  const ch = Math.max(1, card.offsetHeight);
  const gap = 18;

  /** @type {Array<{ left: number; top: number }>} */
  const candidates = [
    { left: gap, top: -ch / 2 },
    { left: -cw - gap, top: -ch / 2 },
    { left: -cw / 2, top: -ch - gap },
    { left: -cw / 2, top: gap },
    { left: gap, top: -ch - gap },
    { left: -cw - gap, top: -ch - gap },
    { left: gap, top: gap },
    { left: -cw - gap, top: gap },
    { left: gap * 1.5, top: -ch * 0.2 },
    { left: -cw - gap * 1.5, top: -ch * 0.2 },
  ];

  let best = candidates[0];
  let bestScore = -Infinity;
  for (const c of candidates) {
    const rect = {
      left: pin.x + c.left,
      top: pin.y + c.top,
      right: pin.x + c.left + cw,
      bottom: pin.y + c.top + ch,
    };
    let score = 100;
    const pad = 6;
    if (rect.left < mapRect.left + pad) score -= (mapRect.left + pad - rect.left) * 3;
    if (rect.right > mapRect.right - pad) score -= (rect.right - (mapRect.right - pad)) * 3;
    if (rect.top < mapRect.top + pad) score -= (mapRect.top + pad - rect.top) * 3;
    if (rect.bottom > mapRect.bottom - pad) score -= (rect.bottom - (mapRect.bottom - pad)) * 3;
    if (start && segmentIntersectsRect(start.x, start.y, pin.x, pin.y, rect)) {
      score -= 600;
    }
    if (start) {
      const vx = pin.x - start.x;
      const vy = pin.y - start.y;
      const mx = rect.left + cw / 2 - pin.x;
      const my = rect.top + ch / 2 - pin.y;
      const dot = vx * mx + vy * my;
      score += dot < 0 ? 50 : -90;
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  card.style.left = `${best.left}px`;
  card.style.top = `${best.top}px`;

  const cardRect = {
    left: pin.x + best.left,
    top: pin.y + best.top,
    right: pin.x + best.left + cw,
    bottom: pin.y + best.top + ch,
  };
  const attach = nearestPointOnRect(pin.x, pin.y, cardRect);
  if (ipFocusLeaderLine) {
    ipFocusLeaderLine.setAttribute("x1", String(pin.x));
    ipFocusLeaderLine.setAttribute("y1", String(pin.y));
    ipFocusLeaderLine.setAttribute("x2", String(attach.x));
    ipFocusLeaderLine.setAttribute("y2", String(attach.y));
    ipFocusLeaderLine.style.stroke = ipFocusAnchor.color;
  }
}

/** 刷新右侧选中行到地图落点的连线（航线刷新不清除选中） */
function refreshIpFocusConnector() {
  if (!map || !ipFocusAnchor || !ipFocusConnectorLine) return;
  layoutIpFocusCard();
  const start = ipFocusConnectorStart();
  if (!start) return;
  const mapPt = map.latLngToContainerPoint([ipFocusAnchor.lat, ipFocusAnchor.lng]);
  const mapRect = map.getContainer().getBoundingClientRect();
  const x2 = mapRect.left + mapPt.x;
  const y2 = mapRect.top + mapPt.y;
  ipFocusConnectorLine.setAttribute("x1", String(start.x));
  ipFocusConnectorLine.setAttribute("y1", String(start.y));
  ipFocusConnectorLine.setAttribute("x2", String(x2));
  ipFocusConnectorLine.setAttribute("y2", String(y2));
  ipFocusConnectorLine.style.stroke = ipFocusAnchor.color;
  ipFocusConnectorSvg?.classList.add("visible");
}

/** IP 表窗口重绘后恢复行高亮与连线 */
function restoreIpFocusAfterTableRender() {
  if (!ipFocusSelectedIp || !ipFocusAnchor) return;
  document
    .querySelectorAll("#ip-stats-table tbody tr.ip-selected")
    .forEach((el) => {
      el.classList.remove("ip-selected");
      if (el instanceof HTMLElement) el.style.removeProperty("--ip-select-color");
    });
  const row = resolveIpFocusRowEl();
  if (row) applyIpFocusRowSelection(row, ipFocusAnchor.color);
  refreshIpFocusConnector();
}

/**
 * 行悬停/强调色：与该 IP 航线色一致。
 * @param {HTMLElement} rowEl
 * @param {string} ip
 */
function applyIpRowAccentColor(rowEl, ip) {
  const color = visualFromIp(String(ip ?? ""), config).color;
  rowEl.style.setProperty("--ip-row-color", color);
}

/**
 * 选中行边框/高亮色与连线同色。
 * @param {HTMLElement} rowEl
 * @param {string} color
 */
function applyIpFocusRowSelection(rowEl, color) {
  rowEl.classList.add("ip-selected");
  rowEl.style.setProperty("--ip-select-color", color);
}

function bindIpFocusConnectorListeners() {
  if (ipFocusListenersBound || !map) return;
  ipFocusListenersBound = true;
  map.on("move zoom moveend zoomend", refreshIpFocusConnector);
  window.addEventListener("resize", refreshIpFocusConnector);
  const wrap = document.querySelector(".ip-stats-table-wrap");
  wrap?.addEventListener("scroll", refreshIpFocusConnector, { passive: true });
}

function clearIpFocusHighlight() {
  window.clearTimeout(ipFocusClearTimer);
  ipFocusClearTimer = 0;
  ipFocusLayer?.clearLayers();
  ipFocusAnchor = null;
  ipFocusRowEl = null;
  ipFocusSelectedIp = "";
  document
    .querySelectorAll("#ip-stats-table tbody tr.ip-selected")
    .forEach((el) => {
      el.classList.remove("ip-selected");
      if (el instanceof HTMLElement) el.style.removeProperty("--ip-select-color");
    });
  if (ipFocusConnectorSvg) ipFocusConnectorSvg.classList.remove("visible");
}

/**
 * 从右侧选中 IP：连线到地图落点并展示完整信息（与航线脉冲互不干扰）。
 * @param {object} row
 * @param {HTMLElement} [rowEl]
 */
function focusIpOnMap(row, rowEl) {
  const lat = Number(row?.lat);
  const lng = Number(row?.lng);
  const ip = String(row?.ip ?? "");
  if (!map || !ip || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    setStatus(`无坐标：${ip || "?"}`);
    return;
  }
  const color = visualFromIp(ip, config).color;
  const countryCode = String(row.country ?? "")
    .trim()
    .toUpperCase();
  const cc = /^[A-Z]{2}$/.test(countryCode) ? countryCode : "ZZ";
  const countryName = countryDisplayName(cc);
  const city = row.city ? String(row.city) : "";
  const place = [city, cc === "ZZ" ? "" : countryName].filter(Boolean).join(", ") || "—";
  const family = row.family ?? (ip.includes(":") ? "ipv6" : "ipv4");
  const familyLabel = family === "ipv6" ? "IPv6" : "IPv4";
  const flagHtml =
    cc === "ZZ"
      ? `<span class="ip-focus-flag ip-focus-flag-unknown" title="未知">?</span>`
      : `<img class="ip-focus-flag" src="https://flagcdn.com/w20/${cc.toLowerCase()}.png" alt="${escapeHtml(cc)}" title="${escapeHtml(countryName)}（${escapeHtml(cc)}）" width="20" height="14" loading="lazy" decoding="async" />`;

  if (!ipFocusLayer) {
    ipFocusLayer = L.layerGroup().addTo(map);
  }
  // 只清图层，保留选中状态变量随后立刻重设（避免航线刷新逻辑误伤）
  ipFocusLayer.clearLayers();
  document
    .querySelectorAll("#ip-stats-table tbody tr.ip-selected")
    .forEach((el) => {
      el.classList.remove("ip-selected");
      if (el instanceof HTMLElement) el.style.removeProperty("--ip-select-color");
    });

  ipFocusSelectedIp = ip;
  ipFocusRowEl = rowEl instanceof HTMLElement ? rowEl : null;
  if (ipFocusRowEl) applyIpFocusRowSelection(ipFocusRowEl, color);
  ipFocusAnchor = { lat, lng, color };
  ensureIpFocusConnectorSvg();
  bindIpFocusConnectorListeners();

  const infoHtml = `
    <div class="ip-focus-card" style="--ip-focus-color:${color}">
      <div class="ip-focus-pulse">
        <span class="ip-focus-ring"></span>
        <span class="ip-focus-ring ip-focus-ring-delay"></span>
        <span class="ip-focus-core"></span>
      </div>
      <div class="ip-focus-info">
        <div class="ip-focus-info-head">
          ${flagHtml}
          <div class="ip-focus-info-ip">${escapeHtml(ip)}</div>
        </div>
        <div>${escapeHtml(familyLabel)} · ${escapeHtml(place)}</div>
        <div>纬度 ${lat.toFixed(4)} · 经度 ${lng.toFixed(4)}</div>
        <div>请求 ${Number(row.requests) || 0} · 成功 ${Number(row.success) || 0} · 失败 ${Number(row.failed) || 0}</div>
        <div>流量 ${escapeHtml(formatBytes(Number(row.totalBytes) || 0))} · 均耗时 ${Number(row.avgDurationMs) || 0} ms</div>
      </div>
    </div>`;

  const icon = L.divIcon({
    className: "ip-focus-marker",
    html: infoHtml,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
  L.marker([lat, lng], { icon, interactive: false, keyboard: false, zIndexOffset: 1200 }).addTo(
    ipFocusLayer,
  );

  // 焦点层置顶，不被航线 canvas 盖住
  if (ipFocusLayer.bringToFront) ipFocusLayer.bringToFront();

  const targetZoom = Math.max(map.getZoom(), 5);
  map.flyTo([lat, lng], targetZoom, { duration: 0.8 });
  map.once("moveend", () => {
    requestAnimationFrame(() => refreshIpFocusConnector());
  });
  requestAnimationFrame(() => refreshIpFocusConnector());
  setStatus(`定位 ${ip} · ${place} · ${lat.toFixed(3)}, ${lng.toFixed(3)}`);

  window.clearTimeout(ipFocusClearTimer);
  ipFocusClearTimer = window.setTimeout(() => {
    clearIpFocusHighlight();
  }, IP_FOCUS_TTL_MS);
}

/** @param {number} n */
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** @param {number} bps */
function formatBitRate(bps) {
  if (!Number.isFinite(bps) || bps < 0) return "—";
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  if (bps < 1024 * 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
  return `${(bps / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
}

/** @type {{ rx: number; tx: number } | null} */
let nicSessionBase = null;

/**
 * 应用本机网卡采样：速率来自服务端差分；累计=相对本页首个样本。
 * @param {{
 *   iface?: string;
 *   rxBytes?: number;
 *   txBytes?: number;
 *   rxBps?: number;
 *   txBps?: number;
 * }} msg
 */
function applyNicTraffic(msg) {
  const el = document.getElementById("nic-meta-line");
  if (!el) return;
  const iface = String(msg.iface ?? "").trim();
  const rxBytes = Number(msg.rxBytes);
  const txBytes = Number(msg.txBytes);
  if (!iface || !Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) {
    el.textContent = "—";
    return;
  }
  if (!nicSessionBase) {
    nicSessionBase = { rx: rxBytes, tx: txBytes };
  }
  const rxRate = formatBitRate(Number(msg.rxBps) || 0);
  const txRate = formatBitRate(Number(msg.txBps) || 0);
  const rxSess = formatBytes(Math.max(0, rxBytes - nicSessionBase.rx));
  const txSess = formatBytes(Math.max(0, txBytes - nicSessionBase.tx));
  el.textContent = `${iface} · ↓${rxRate} (${rxSess}) · ↑${txRate} (${txSess})`;
}

function renderRouteList(paths) {
  const ul = document.getElementById("route-list");
  if (!ul) return;
  ul.innerHTML = "";
  if (!paths) return;
  const ordered = orderRoutePaths(paths);
  for (const p of ordered.slice(0, 20)) {
    const li = document.createElement("li");
    const status = Number(p.httpStatus);
    const ok = Number.isFinite(status) && status >= 200 && status < 300;
    const viaHot = p.viaHot === true;
    const http2 = p.http2 === true;
    const ip = String(p.pinnedIp ?? "");
    const color = visualFromIp(ip || "?", config).color;
    li.dataset.requestId = String(p.requestId ?? "");
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
    const countryRaw = String(p.targetCountry ?? "").trim().toUpperCase();
    const cc = /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : "ZZ";
    const countryName = countryDisplayName(cc);
    const city = p.targetCity ?? p.targetLabel;
    const place = [cc === "ZZ" ? "" : countryName, city].filter(Boolean).join(" · ");
    const flagHtml =
      cc === "ZZ"
        ? `<span class="route-flag route-flag-unknown" title="未知">?</span>`
        : `<img class="route-flag" src="https://flagcdn.com/w20/${cc.toLowerCase()}.png" alt="${escapeHtml(cc)}" title="${escapeHtml(countryName)}（${escapeHtml(cc)}）" width="20" height="14" loading="lazy" decoding="async" />`;
    const pathLine = p.requestPath
      ? `<div class="path" title="${escapeHtml(String(p.requestPath))}">${escapeHtml(String(p.requestPath))}</div>`
      : "";
    li.innerHTML = `
      <button type="button" class="row-drag" title="拖动换行" aria-label="拖动换行">⋮⋮</button>
      <div class="route-head">${flagHtml}<strong>${escapeHtml(ip || "?")}</strong></div>
      ${place ? `<div class="meta place">${escapeHtml(String(place))}</div>` : ""}
      ${pathLine}
      <div class="meta">${ok ? "" : '<span class="alert-badge">警报</span> '}${transport} · 远程 ${ms} · ${statusText} · ${formatBytes(p.bodyBytes ?? 0)}</div>
    `;
    ul.appendChild(li);
  }
}

/**
 * @param {object[]} paths
 * @returns {object[]}
 */
function orderRoutePaths(paths) {
  if (!routeListManualOrder.length) return paths;
  const byId = new Map(paths.map((p) => [String(p.requestId ?? ""), p]));
  const known = new Set(routeListManualOrder);
  const fresh = [];
  for (const p of paths) {
    const id = String(p.requestId ?? "");
    if (!known.has(id) && byId.has(id)) {
      fresh.push(p);
      byId.delete(id);
    }
  }
  const orderedOld = [];
  for (const id of routeListManualOrder) {
    const p = byId.get(id);
    if (p) {
      orderedOld.push(p);
      byId.delete(id);
    }
  }
  return [...fresh, ...orderedOld, ...byId.values()];
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
  stressActive = true;
  setStatus("高并发压测启动中…");

  if (wsConnected) {
    wsSend({ type: "stress", url });
    // 进度/结果经 WS stressStatus / stressResult
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
      setStatus("压测已异步启动，进度见状态栏（需保持 WS）…");
      // 按钮保持禁用，等 stressStatus done / stressResult
      return;
    }
    stressActive = false;
    setStatus(
      `压测完成 成功 ${data.succeeded}/${data.total} · 失败 ${data.failed} · ${data.elapsedMs} ms`,
    );
    btn.disabled = false;
  } catch (err) {
    stressActive = false;
    setStatus(`压测失败: ${err instanceof Error ? err.message : String(err)}`);
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
  // 重置统计：功能保留（triggerResetIpStats），入口改到后台设置面板后再挂 UI
  setupPanelResize();
  setupPanelDnD();
  setupVisibleIpStatsObserver();
  await initMap();
  if (mapOrigin) {
    map?.setView([mapOrigin.lat, mapOrigin.lng], 3);
  }
  watchIpStatsHostname();
}

/**
 * 侧栏左缘拖拽调宽；地图 right 随 --panel-width 变化。
 */
function setupPanelResize() {
  const handle = document.getElementById("panel-resize");
  if (!handle) return;

  const stored = Number(localStorage.getItem("geoclaw.panelWidth") || "");
  if (Number.isFinite(stored) && stored >= 280) {
    applyPanelWidth(stored);
  }

  /** @param {PointerEvent} ev */
  const onPointerMove = (ev) => {
    const maxPx = Math.floor(window.innerWidth * 0.72);
    const width = Math.min(maxPx, Math.max(280, window.innerWidth - ev.clientX));
    applyPanelWidth(width);
  };

  const onPointerUp = (ev) => {
    handle.releasePointerCapture(ev.pointerId);
    document.body.classList.remove("panel-resizing");
    handle.removeEventListener("pointermove", onPointerMove);
    handle.removeEventListener("pointerup", onPointerUp);
    handle.removeEventListener("pointercancel", onPointerUp);
    const w = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--panel-width"),
    );
    if (Number.isFinite(w)) localStorage.setItem("geoclaw.panelWidth", String(Math.round(w)));
    map?.invalidateSize();
  };

  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    document.body.classList.add("panel-resizing");
    handle.setPointerCapture(ev.pointerId);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);
  });
}

/**
 * @param {number} widthPx
 */
function applyPanelWidth(widthPx) {
  const maxPx = Math.floor(window.innerWidth * 0.72);
  const w = Math.min(maxPx, Math.max(280, Math.round(widthPx)));
  document.documentElement.style.setProperty("--panel-width", `${w}px`);
}

/**
 * 区块 / IP 行 / 请求日志行：拖拽换位。
 */
function setupPanelDnD() {
  const blocks = document.getElementById("panel-blocks");
  if (blocks) {
    restoreBlockOrder(blocks);
    // 拖动手柄点击不要触发展开/收起
    blocks.addEventListener("click", (ev) => {
      if (!(ev.target instanceof Element)) return;
      if (ev.target.closest(".block-drag")) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    });
    enablePointerSort(blocks, {
      itemSelector: ".panel-block",
      handleSelector: ".block-drag",
      onReorder: () => {
        const order = [...blocks.querySelectorAll(".panel-block")]
          .map((el) => el.getAttribute("data-block"))
          .filter(Boolean);
        localStorage.setItem("geoclaw.panelBlockOrder", JSON.stringify(order));
      },
    });
  }

  const ipWrap = document.querySelector(".ip-stats-table-wrap");
  const tbody = document.querySelector("#ip-stats-table tbody");
  if (ipWrap && tbody) {
    enablePointerSort(tbody, {
      itemSelector: "tr",
      handleSelector: ".row-drag",
      scrollParent: ipWrap,
      onReorder: () => {
        const host = currentRequestHostname() || "_";
        const ips = [...tbody.querySelectorAll("tr")]
          .map((tr) => tr.dataset.ip)
          .filter(Boolean);
        localStorage.setItem(`geoclaw.ipRowOrder.${host}`, JSON.stringify(ips));
      },
    });
  }

  const routeList = document.getElementById("route-list");
  if (routeList) {
    enablePointerSort(routeList, {
      itemSelector: "li",
      handleSelector: ".row-drag",
      scrollParent: routeList,
      onReorder: () => {
        routeListManualOrder = [...routeList.querySelectorAll("li")]
          .map((li) => li.dataset.requestId)
          .filter(Boolean);
        const byId = new Map(
          recentPulsePaths.map((p) => [String(p.requestId ?? ""), p]),
        );
        recentPulsePaths = routeListManualOrder
          .map((id) => byId.get(id))
          .filter(Boolean);
      },
    });
  }
}

/**
 * @param {HTMLElement} container
 */
function restoreBlockOrder(container) {
  let order = [];
  try {
    order = JSON.parse(localStorage.getItem("geoclaw.panelBlockOrder") || "[]");
  } catch {
    order = [];
  }
  if (!Array.isArray(order) || order.length === 0) return;
  for (const id of order) {
    const el = container.querySelector(`[data-block="${CSS.escape(String(id))}"]`);
    if (el) container.appendChild(el);
  }
}

function applySavedIpRowOrder() {
  const tbody = document.querySelector("#ip-stats-table tbody");
  if (!tbody) return;
  const host = currentRequestHostname() || "_";
  let order = [];
  try {
    order = JSON.parse(localStorage.getItem(`geoclaw.ipRowOrder.${host}`) || "[]");
  } catch {
    order = [];
  }
  if (!Array.isArray(order) || order.length === 0) return;
  for (const ip of order) {
    const tr = ipStatsRowEls.get(String(ip));
    if (tr && tr.parentElement === tbody) tbody.appendChild(tr);
  }
}

/**
 * Pointer 拖拽排序（仅手柄可拖，避免与点击定位冲突）。
 * @param {HTMLElement} container
 * @param {{
 *   itemSelector: string;
 *   handleSelector: string;
 *   scrollParent?: Element | null;
 *   onReorder?: () => void;
 * }} opts
 */
function enablePointerSort(container, opts) {
  let dragging = /** @type {HTMLElement | null} */ (null);

  container.addEventListener("pointerdown", (ev) => {
    if (!(ev.target instanceof Element)) return;
    if (ev.button !== 0) return;
    const handle = ev.target.closest(opts.handleSelector);
    if (!handle || !container.contains(handle)) return;
    const item = handle.closest(opts.itemSelector);
    if (!(item instanceof HTMLElement) || !container.contains(item)) return;

    ev.preventDefault();
    ev.stopPropagation();
    dragging = item;
    item.classList.add("dnd-ghost");
    document.body.classList.add("dnd-sorting");
    handle.setPointerCapture(ev.pointerId);

    /** @param {PointerEvent} moveEv */
    const onMove = (moveEv) => {
      if (!dragging) return;
      const over = itemFromPoint(container, opts.itemSelector, moveEv.clientX, moveEv.clientY, dragging);
      if (!over || over === dragging) return;
      const rect = over.getBoundingClientRect();
      const before = moveEv.clientY < rect.top + rect.height / 2;
      if (before) container.insertBefore(dragging, over);
      else container.insertBefore(dragging, over.nextSibling);
      autoScroll(opts.scrollParent ?? container, moveEv.clientY);
    };

    const onUp = (upEv) => {
      handle.releasePointerCapture(upEv.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      if (dragging) dragging.classList.remove("dnd-ghost");
      dragging = null;
      document.body.classList.remove("dnd-sorting");
      opts.onReorder?.();
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });
}

/**
 * @param {HTMLElement} container
 * @param {string} itemSelector
 * @param {number} x
 * @param {number} y
 * @param {HTMLElement} exclude
 * @returns {HTMLElement | null}
 */
function itemFromPoint(container, itemSelector, x, y, exclude) {
  const el = document.elementFromPoint(x, y);
  if (!(el instanceof Element)) return null;
  const item = el.closest(itemSelector);
  if (!(item instanceof HTMLElement) || !container.contains(item) || item === exclude) {
    return null;
  }
  return item;
}

/**
 * @param {Element} scroller
 * @param {number} clientY
 */
function autoScroll(scroller, clientY) {
  if (!(scroller instanceof HTMLElement)) return;
  const rect = scroller.getBoundingClientRect();
  const edge = 28;
  if (clientY < rect.top + edge) scroller.scrollTop -= 12;
  else if (clientY > rect.bottom - edge) scroller.scrollTop += 12;
}

void main();
