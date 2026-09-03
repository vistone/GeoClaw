import type { HostPinRecord } from "./HostPinPool.js";
import { GeoClawConfig } from "../core/GeoClawConfig.js";

/** 地图航点（用于绘制飞行路线） */
export type FlightWaypoint = {
  role: "origin" | "proxy" | "target";
  lat: number;
  lng: number;
  label: string;
  city?: string;
  region?: string;
  country?: string;
  ip?: string;
  hostname?: string;
};

/** 航段：相邻航点间耗时 */
export type FlightLeg = {
  fromIndex: number;
  toIndex: number;
  durationMs: number;
};

/** 单次 fetch 飞行路线（客户端 → 代理 → 目标节点 → 数据返回） */
export type FetchFlightPath = {
  requestId: string;
  url: string;
  targetHostname: string;
  dnsMode: "hostpin" | "system";
  /** 目标 HostPin / 热池 IP（按 IP 着色与过滤用） */
  pinnedIp?: string;
  ipsYaml?: string;
  waypoints: FlightWaypoint[];
  legs: FlightLeg[];
  totalDurationMs: number;
  bodyBytes?: number;
  httpStatus?: number;
  /** 是否经热连接池（复用 per-IP Client） */
  viaHot?: boolean;
  /** 是否启用 HTTP/2 指纹（ALPN h2）且响应头呈 h2 形态 */
  http2?: boolean;
};

/** 客户端/origin 坐标（geoclaw.yaml fetchRoute.origin） */
export type FetchRouteOrigin = {
  lat: number;
  lng: number;
  city?: string;
  region?: string;
  country?: string;
  label?: string;
};

/** 代理节点坐标（可选） */
export type FetchRouteProxyGeo = {
  lat: number;
  lng: number;
  city?: string;
  country?: string;
  label?: string;
};

/** fetchRoute 配置 */
export type FetchRouteOptions = {
  /** origin 来源：ipinfo=出口 IP 自动解析；manual=使用 origin 字段 */
  originMode: "ipinfo" | "manual";
  origin: FetchRouteOrigin | null;
  includeProxyHop: boolean;
  proxyGeo: FetchRouteProxyGeo | null;
  /** system DNS 时经 ipinfo 解析目标域名坐标 */
  ipinfoForSystemDns: boolean;
};

/**
 * 解析 LocString。
 * @param loc - 输入：`undefined | string` — loc 参数
 * @returns 输出：`null | object` — null | object 实例
 */
export function parseLocString(loc: string | undefined): { lat: number; lng: number } | null {
  if (!loc) {
    return null;
  }
  const parts = loc.split(",").map((s) => s.trim());
  if (parts.length !== 2) {
    return null;
  }
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  return { lat, lng };
}

/**
 * 执行 waypointFromHostPinRecord。
 * @param record - 输入：`undefined | HostPinRecord` — record 参数
 * @param pinnedIp - 输入：`string` — pinnedIp 参数
 * @param hostname - 输入：`string` — hostname 参数
 * @returns 输出：`null | FlightWaypoint` — null | FlightWaypoint 实例
 */
export function waypointFromHostPinRecord(
  record: HostPinRecord | undefined,
  pinnedIp: string,
  hostname: string,
): FlightWaypoint | null {
  const coords = parseLocString(record?.loc);
  if (!coords) {
    return null;
  }
  return {
    role: "target",
    lat: coords.lat,
    lng: coords.lng,
    label: record?.city ?? pinnedIp,
    city: record?.city,
    region: record?.region,
    country: record?.country,
    ip: pinnedIp,
    hostname,
  };
}

export type BuildFlightPathArgs = {
  requestId: string;
  url: string;
  targetHostname: string;
  dnsMode: "hostpin" | "system";
  ipsYaml?: string;
  pinnedIp?: string;
  pinRecord?: HostPinRecord;
  route: FetchRouteOptions;
  proxyUrl?: string;
  durationMs: number;
  bodyBytes?: number;
  httpStatus?: number;
  viaHot?: boolean;
  http2?: boolean;
};

/**
 * 执行 buildFetchFlightPath。
 * @param args - 输入：`BuildFlightPathArgs` — 请求参数
 * @returns 输出：`FetchFlightPath` — FetchFlightPath 实例
 */
export function buildFetchFlightPath(args: BuildFlightPathArgs): FetchFlightPath {
  const waypoints: FlightWaypoint[] = [];
  const legs: FlightLeg[] = [];

  const origin = args.route.origin;
  if (origin) {
    waypoints.push({
      role: "origin",
      lat: origin.lat,
      lng: origin.lng,
      label: origin.label ?? origin.city ?? "origin",
      city: origin.city,
      region: origin.region,
      country: origin.country,
    });
  }

  let proxyIndex: number | undefined;
  if (args.route.includeProxyHop && args.proxyUrl && args.route.proxyGeo) {
    proxyIndex = waypoints.length;
    waypoints.push({
      role: "proxy",
      lat: args.route.proxyGeo.lat,
      lng: args.route.proxyGeo.lng,
      label: args.route.proxyGeo.label ?? args.route.proxyGeo.city ?? "proxy",
      city: args.route.proxyGeo.city,
      country: args.route.proxyGeo.country,
    });
  }

  const targetWp =
    args.pinnedIp
      ? waypointFromHostPinRecord(args.pinRecord, args.pinnedIp, args.targetHostname)
      : null;

  if (targetWp) {
    waypoints.push(targetWp);
  } else if (args.dnsMode === "system" && args.targetHostname) {
    waypoints.push({
      role: "target",
      lat: 0,
      lng: 0,
      label: args.targetHostname,
      hostname: args.targetHostname,
    });
  }

  const targetIndex = waypoints.length - 1;
  if (targetIndex >= 1) {
    const fromIdx = proxyIndex !== undefined ? proxyIndex : 0;
    if (proxyIndex !== undefined && proxyIndex > 0) {
      legs.push({
        fromIndex: 0,
        toIndex: proxyIndex,
        durationMs: Math.round(args.durationMs * 0.15),
      });
      legs.push({
        fromIndex: proxyIndex,
        toIndex: targetIndex,
        durationMs: Math.round(args.durationMs * 0.85),
      });
    } else {
      legs.push({
        fromIndex: fromIdx,
        toIndex: targetIndex,
        durationMs: args.durationMs,
      });
    }
  }

  return {
    requestId: args.requestId,
    url: args.url,
    targetHostname: args.targetHostname,
    dnsMode: args.dnsMode,
    pinnedIp: args.pinnedIp,
    ipsYaml: args.ipsYaml,
    waypoints,
    legs,
    totalDurationMs: args.durationMs,
    bodyBytes: args.bodyBytes,
    httpStatus: args.httpStatus,
    viaHot: args.viaHot,
    http2: args.http2,
  };
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export type GreatCircleArcOptions = {
  /** 固定插值点数（含起终点）；未指定则按大圆角距自动计算 */
  steps?: number;
  minSteps?: number;
  maxSteps?: number;
  /** 直接指定拱高（度）；一般不设，改由 LEO 高度计算 */
  bowDeg?: number;
  /** 侧向偏移（度） */
  lateralDeg?: number;
  /** LEO 轨道高度 (km) */
  altitudeKm?: number;
  /** 地球半径 (km) */
  earthRadiusKm?: number;
  /** 平面显示夸张系数 */
  orbitDisplayExaggeration?: number;
};

/** 航线平面显示的地球/LEO 参数 */
export type FlightArcDisplayOptions = {
  earthRadiusKm?: number;
  leoAltitudeMinKm?: number;
  leoAltitudeMaxKm?: number;
  orbitDisplayExaggeration?: number;
  /** 批量分配的视觉样式（颜色拉开、高度互不重复） */
  visualByIp?: ReadonlyMap<string, RouteVisualStyle>;
};

/**
 * 用 YAML flightMap 补齐航线显示参数（禁止在本模块硬编码默认值）。
 * @param display - 输入：`FlightArcDisplayOptions` — 调用方覆盖项
 * @returns 输出：`RequiredFlightArcDisplay` — 完整显示参数
 */
export function resolveFlightArcDisplay(display: FlightArcDisplayOptions = {}): RequiredFlightArcDisplay {
  const cfg = GeoClawConfig.get().getFlightMapConfig();
  return {
    earthRadiusKm: display.earthRadiusKm ?? cfg.earthRadiusKm,
    leoAltitudeMinKm: display.leoAltitudeMinKm ?? cfg.leoAltitudeMinKm,
    leoAltitudeMaxKm: display.leoAltitudeMaxKm ?? cfg.leoAltitudeMaxKm,
    orbitDisplayExaggeration: display.orbitDisplayExaggeration ?? cfg.orbitDisplayExaggeration,
    visualByIp: display.visualByIp,
  };
}

/** 已补齐的飞行弧显示参数 */
export type RequiredFlightArcDisplay = {
  earthRadiusKm: number;
  leoAltitudeMinKm: number;
  leoAltitudeMaxKm: number;
  orbitDisplayExaggeration: number;
  visualByIp?: ReadonlyMap<string, RouteVisualStyle>;
};

/**
 * 执行 greatCircleArc。
 * @param from - 输入：`object` — from 参数
 * @param to - 输入：`object` — to 参数
 * @param options - 输入：`GreatCircleArcOptions` — 配置选项
 * @returns 输出：`[number, number][]` — [number, number][] 实例
 */
export function greatCircleArc(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  options: GreatCircleArcOptions = {},
): [number, number][] {
  const start = latLngToUnitVector(from.lat, from.lng);
  const end = latLngToUnitVector(to.lat, to.lng);

  const dot = clamp(start[0] * end[0] + start[1] * end[1] + start[2] * end[2], -1, 1);
  const omega = Math.acos(dot);

  if (omega < 1e-10) {
    return [unitVectorToLngLat(start)];
  }

  const minSteps = options.minSteps ?? 32;
  const maxSteps = options.maxSteps ?? 160;
  const steps =
    options.steps ?? Math.max(minSteps, Math.min(maxSteps, Math.ceil((omega * RAD2DEG) / 1.5)));

  const sinOmega = Math.sin(omega);
  const points: [number, number][] = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = Math.sin((1 - t) * omega) / sinOmega;
    const b = Math.sin(t * omega) / sinOmega;
    points.push(
      unitVectorToLngLat([
        a * start[0] + b * end[0],
        a * start[1] + b * end[1],
        a * start[2] + b * end[2],
      ]),
    );
  }

  return points;
}

/**
 * 执行 validWaypoints。
 * @param path - 输入：`FetchFlightPath` — 八分体路径
 * @returns 输出：`FlightWaypoint[]` — FlightWaypoint[] 实例
 */
function validWaypoints(path: FetchFlightPath): FlightWaypoint[] {
  return path.waypoints.filter(
    (w) => Number.isFinite(w.lat) && Number.isFinite(w.lng) && (w.lat !== 0 || w.lng !== 0),
  );
}

/**
 * 执行 flightPathToGeoJsonLine。
 * @param path - 输入：`FetchFlightPath` — 八分体路径
 * @param arcOptions - 输入：`GreatCircleArcOptions` — arcOptions 参数
 * @param display - 输入：`FlightArcDisplayOptions` — display 参数
 * @returns 输出：`object` — object 实例
 */
export function flightPathToGeoJsonLine(
  path: FetchFlightPath,
  arcOptions: GreatCircleArcOptions = {},
  display: FlightArcDisplayOptions = {},
): {
  type: "Feature";
  properties: {
    requestId: string;
    url: string;
    totalDurationMs: number;
    legs: FlightLeg[];
  };
  geometry: {
    type: "LineString";
    coordinates: [number, number][];
  };
} {
  const wps = validWaypoints(path);

  if (wps.length < 2) {
    return {
      type: "Feature",
      properties: {
        requestId: path.requestId,
        url: path.url,
        totalDurationMs: path.totalDurationMs,
        legs: path.legs,
      },
      geometry: {
        type: "LineString",
        coordinates: wps.map((w) => [w.lng, w.lat] as [number, number]),
      },
    };
  }

  return {
    type: "Feature",
    properties: {
      requestId: path.requestId,
      url: path.url,
      totalDurationMs: path.totalDurationMs,
      legs: path.legs,
    },
    geometry: buildRouteLineGeometry(path, arcOptions, display),
  };
}

/**
 * 执行 latLngToUnitVector。
 * @param lat - 输入：`number` — lat 参数
 * @param lng - 输入：`number` — lng 参数
 * @returns 输出：`[number, number, number]` — [number, number, number] 实例
 */function latLngToUnitVector(lat: number, lng: number): [number, number, number] {
  const phi = lat * DEG2RAD;
  const lambda = lng * DEG2RAD;
  const cosPhi = Math.cos(phi);
  return [cosPhi * Math.cos(lambda), cosPhi * Math.sin(lambda), Math.sin(phi)];
}

/**
 * 执行 unitVectorToLngLat。
 * @param v - 输入：`[number, number, number]` — v 参数
 * @returns 输出：`[number, number]` — [number, number] 实例
 */function unitVectorToLngLat(v: [number, number, number]): [number, number] {
  const [x, y, z] = v;
  const lat = Math.asin(clamp(z, -1, 1)) * RAD2DEG;
  const lng = Math.atan2(y, x) * RAD2DEG;
  return [lng, lat];
}

/**
 * 执行 clamp。
 * @param n - 输入：`number` — n 参数
 * @param min - 输入：`number` — min 参数
 * @param max - 输入：`number` — max 参数
 * @returns 输出：`number` — 数值结果
 */function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** 每条请求的可视化样式：颜色 + LEO 高度 */
export type RouteVisualStyle = {
  color: string;
  /** LEO 轨道高度 (km) */
  leoAltitudeKm: number;
};

/** 黄金角（度），用于在色环上均匀散开 */
const GOLDEN_ANGLE_DEG = 137.508;

/**
 * 判断 hRequestId。
 * @param requestId - 输入：`string` — requestId 参数
 * @returns 输出：`number` — 数值结果
 */
export function hashRequestId(requestId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < requestId.length; i++) {
    hash ^= requestId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 四档饱和/明度，与均匀色相正交，避免相邻航线看起来「差不多」 */
const ROUTE_COLOR_BANDS: ReadonlyArray<{ sat: number; light: number }> = [
  { sat: 92, light: 38 },
  { sat: 78, light: 58 },
  { sat: 88, light: 46 },
  { sat: 72, light: 66 },
];

/**
 * 执行 assignDistinctRouteVisuals。
 * @param ips - 输入：`string[]` — ips 参数
 * @param display - 输入：`FlightArcDisplayOptions` — display 参数
 * @returns 输出：`Map` — Map 实例
 */
export function assignDistinctRouteVisuals(
  ips: readonly string[],
  display: FlightArcDisplayOptions = {},
): Map<string, RouteVisualStyle> {
  const unique = [...new Set(ips.filter((ip) => !!ip))].sort((a, b) => a.localeCompare(b));
  const n = unique.length;
  const out = new Map<string, RouteVisualStyle>();
  if (n === 0) return out;

  const minKm = resolveFlightArcDisplay(display).leoAltitudeMinKm;
  const configuredMax = resolveFlightArcDisplay(display).leoAltitudeMaxKm;
  // 保证区间至少能放下 n 个互不相同的整数高度
  const maxKm = Math.max(configuredMax, minKm + (n - 1));
  // 色相起点随集合指纹轻微偏移，集合不变则颜色稳定
  const hue0 = (hashRequestId(unique.join("|")) % 3600) / 10;

  for (let i = 0; i < n; i++) {
    const hue = (hue0 + (i * 360) / n) % 360;
    const band = ROUTE_COLOR_BANDS[i % ROUTE_COLOR_BANDS.length]!;
    const color = `hsl(${hue.toFixed(1)} ${band.sat}% ${band.light}%)`;

    const leoAltitudeKm =
      n === 1
        ? Math.round((minKm + maxKm) / 2)
        : Math.round(minKm + (i * (maxKm - minKm)) / (n - 1));

    out.set(unique[i]!, { color, leoAltitudeKm });
  }

  // 二次校验：若四舍五入导致高度撞车，向后顺延（再撞则向前）
  const used = new Set<number>();
  for (const ip of unique) {
    const style = out.get(ip)!;
    let h = style.leoAltitudeKm;
    let step = 1;
    while (used.has(h)) {
      h = style.leoAltitudeKm + step;
      if (used.has(h)) h = style.leoAltitudeKm - step;
      step += 1;
      if (step > maxKm - minKm + n + 2) {
        h = maxKm + used.size;
        break;
      }
    }
    used.add(h);
    if (h !== style.leoAltitudeKm) {
      out.set(ip, { ...style, leoAltitudeKm: h });
    }
  }

  return out;
}

/**
 * 执行 angularDistanceRad。
 * @param from - 输入：`object` — from 参数
 * @param to - 输入：`object` — to 参数
 * @returns 输出：`number` — 数值结果
 */
export function angularDistanceRad(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const φ1 = from.lat * DEG2RAD;
  const φ2 = to.lat * DEG2RAD;
  let dλ = (to.lng - from.lng) * DEG2RAD;
  if (dλ > Math.PI) dλ -= 2 * Math.PI;
  if (dλ < -Math.PI) dλ += 2 * Math.PI;
  const cosδ = clamp(
    Math.sin(φ1) * Math.sin(φ2) + Math.cos(φ1) * Math.cos(φ2) * Math.cos(dλ),
    -1,
    1,
  );
  return Math.acos(cosδ);
}

/**
 * 执行 leoOrbitalBowDeg。
 * @param thetaRad - 输入：`number` — thetaRad 参数
 * @param altitudeKm - 输入：`number` — altitudeKm 参数
 * @param earthRadiusKm - 输入：`number` — earthRadiusKm 参数
 * @returns 输出：`number` — 数值结果
 */
export function leoOrbitalBowDeg(
  thetaRad: number,
  altitudeKm: number,
  earthRadiusKm?: number,
): number {
  const half = thetaRad / 2;
  if (half < 1e-9) return 0;
  const h = Math.max(0, altitudeKm);
  const R = Math.max(1, earthRadiusKm ?? resolveFlightArcDisplay().earthRadiusKm);
  const deltaSagitta = h * (1 - Math.cos(half));
  const halfChord = R * Math.sin(half);
  return Math.atan2(deltaSagitta, Math.max(halfChord, 1e-6)) * RAD2DEG;
}

/**
 * 执行 routeVisualFromRequestId。
 * @param requestId - 输入：`string` — requestId 参数
 * @param display - 输入：`FlightArcDisplayOptions` — display 参数
 * @returns 输出：`RouteVisualStyle` — RouteVisualStyle 实例
 */
export function routeVisualFromRequestId(
  requestId: string,
  display: FlightArcDisplayOptions = {},
): RouteVisualStyle {
  return routeVisualFromIp(requestId, display);
}

/**
 * 执行 routeVisualFromIp。
 * @param ip - 输入：`string` — ip 参数
 * @param display - 输入：`FlightArcDisplayOptions` — display 参数
 * @returns 输出：`RouteVisualStyle` — RouteVisualStyle 实例
 */
export function routeVisualFromIp(
  ip: string,
  display: FlightArcDisplayOptions = {},
): RouteVisualStyle {
  const fromBatch = display.visualByIp?.get(ip);
  if (fromBatch) return fromBatch;

  const h = hashRequestId(ip);
  const hue = (h * GOLDEN_ANGLE_DEG) % 360;
  const band = h % 3;
  const sat = band === 0 ? 78 : band === 1 ? 88 : 70;
  const light = band === 0 ? 42 : band === 1 ? 55 : 68;
  const color = `hsl(${hue.toFixed(1)} ${sat}% ${light}%)`;

  const minKm = resolveFlightArcDisplay(display).leoAltitudeMinKm;
  const maxKm = Math.max(minKm, resolveFlightArcDisplay(display).leoAltitudeMaxKm);
  const span = maxKm - minKm;
  const leoAltitudeKm = span <= 0 ? minKm : minKm + (hashRequestId(`${ip}:leo`) % (Math.floor(span) + 1));

  return { color, leoAltitudeKm };
}

/**
 * 执行 routeColorFromIp。
 * @param ip - 输入：`string` — ip 参数
 * @param display - 输入：`FlightArcDisplayOptions` — display 参数
 * @returns 输出：`string` — 字符串结果
 */
export function routeColorFromIp(ip: string, display: FlightArcDisplayOptions = {}): string {
  return routeVisualFromIp(ip, display).color;
}

/**
 * 执行 routeColorFromRequestId。
 * @param requestId - 输入：`string` — requestId 参数
 * @returns 输出：`string` — 字符串结果
 */
export function routeColorFromRequestId(requestId: string): string {
  return routeColorFromIp(requestId);
}

/**
 * 执行 flightPathTargetIp。
 * @param path - 输入：`FetchFlightPath` — 八分体路径
 * @returns 输出：`undefined | string` — undefined | string 实例
 */
export function flightPathTargetIp(path: FetchFlightPath): string | undefined {
  if (path.pinnedIp) return path.pinnedIp;
  return path.waypoints.find((w) => w.role === "target")?.ip;
}

/**
 * 执行 filterFlightPathsByHotIps。
 * @param paths - 输入：`FetchFlightPath[]` — paths 参数
 * @param hotIps - 输入：`string[] | ReadonlySet` — hotIps 参数
 * @returns 输出：`FetchFlightPath[]` — FetchFlightPath[] 实例
 */
export function filterFlightPathsByHotIps(
  paths: readonly FetchFlightPath[],
  hotIps: ReadonlySet<string> | readonly string[],
): FetchFlightPath[] {
  const hot = hotIps instanceof Set ? hotIps : new Set(hotIps);
  if (hot.size === 0) return [];
  return paths.filter((p) => {
    const ip = flightPathTargetIp(p);
    return !!ip && hot.has(ip);
  });
}

export type BuildFlightPathsFromHotIpsOptions = {
  /** 当前热池存活 IP */
  hotIps: readonly string[];
  hostname: string;
  /** 航线关联的示例 URL（可视化用） */
  url: string;
  route: FetchRouteOptions;
  /** 查 IP 地理记录（需含 loc） */
  lookupPinRecord: (ip: string) => HostPinRecord | undefined;
  proxyUrl?: string;
  /** 已完成 fetch 的航线，按 IP 覆盖耗时/状态 */
  recentByIp?: ReadonlyMap<string, FetchFlightPath>;
};

/**
 * 执行 buildFlightPathsFromHotIps。
 * @param options - 输入：`BuildFlightPathsFromHotIpsOptions` — 配置选项
 * @returns 输出：`FetchFlightPath[]` — FetchFlightPath[] 实例
 */
export function buildFlightPathsFromHotIps(
  options: BuildFlightPathsFromHotIpsOptions,
): FetchFlightPath[] {
  if (!options.route.origin) return [];

  const out: FetchFlightPath[] = [];
  for (const ip of options.hotIps) {
    const pinRecord = options.lookupPinRecord(ip);
    if (!waypointFromHostPinRecord(pinRecord, ip, options.hostname)) continue;

    const recent = options.recentByIp?.get(ip);
    out.push(
      buildFetchFlightPath({
        requestId: recent?.requestId ?? `hot:${ip}`,
        url: recent?.url ?? options.url,
        targetHostname: options.hostname,
        dnsMode: "hostpin",
        pinnedIp: ip,
        pinRecord,
        route: options.route,
        proxyUrl: options.proxyUrl,
        durationMs: recent?.totalDurationMs ?? 0,
        bodyBytes: recent?.bodyBytes,
        httpStatus: recent?.httpStatus ?? 200,
      }),
    );
  }
  return out;
}

/**
 * 执行 unwrapDestinationLng。
 * @param lng1 - 输入：`number` — lng1 参数
 * @param lng2 - 输入：`number` — lng2 参数
 * @returns 输出：`number` — 数值结果
 */
function unwrapDestinationLng(lng1: number, lng2: number): number {
  let dLon = lng2 - lng1;
  if (dLon > 180) {
    dLon -= 360;
  } else if (dLon < -180) {
    dLon += 360;
  }
  return lng1 + dLon;
}

/**
 * 执行 mapDisplayArc。
 * @param from - 输入：`object` — from 参数
 * @param to - 输入：`object` — to 参数
 * @param options - 输入：`GreatCircleArcOptions` — 配置选项
 * @returns 输出：`[number, number][]` — [number, number][] 实例
 */
export function mapDisplayArc(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  options: GreatCircleArcOptions = {},
): [number, number][] {
  const R = options.earthRadiusKm ?? resolveFlightArcDisplay().earthRadiusKm;
  const altitudeKm = options.altitudeKm ?? 30;
  const exag = options.orbitDisplayExaggeration ?? resolveFlightArcDisplay().orbitDisplayExaggeration;

  const theta = angularDistanceRad(from, to);
  const bowPeak =
    options.bowDeg ?? leoOrbitalBowDeg(theta, altitudeKm, R) * exag;

  const minSteps = options.minSteps ?? 24;
  const maxSteps = options.maxSteps ?? 96;
  const steps =
    options.steps ??
    Math.max(minSteps, Math.min(maxSteps, Math.ceil((Math.max(theta * RAD2DEG, 1)) / 2.5)));

  // 球面大圆采样（真实经度），再展开成连续经度以便跨太平洋绘制
  const ground = greatCircleArc(from, to, { ...options, steps });
  const unwrapped: [number, number][] = [];
  let prevLng: number | null = null;
  for (const [lng, lat] of ground) {
    const ulng: number = prevLng === null ? lng : unwrapDestinationLng(prevLng, lng);
    unwrapped.push([ulng, lat]);
    prevLng = ulng;
  }

  // 终点对齐到与起点连续的经度分支（如北京→美西 → lng>180）
  if (unwrapped.length >= 2) {
    const startLng = unwrapped[0]![0];
    const wantEnd = unwrapDestinationLng(startLng, to.lng);
    const gotEnd = unwrapped[unwrapped.length - 1]![0];
    if (Math.abs(gotEnd - wantEnd) > 1) {
      const got0 = unwrapped[0]![0];
      const spanGot = gotEnd - got0 || 1;
      for (let i = 0; i < unwrapped.length; i++) {
        const t = (unwrapped[i]![0] - got0) / spanGot;
        unwrapped[i]![0] = startLng + (wantEnd - startLng) * t;
      }
    }
  }

  const lateral = options.lateralDeg ?? 0;
  const n = unwrapped.length;
  if (n < 2) return unwrapped;

  const start = unwrapped[0]!;
  const end = unwrapped[n - 1]!;
  const chordDx = end[0] - start[0];
  const chordDy = end[1] - start[1];
  const chordLen = Math.hypot(chordDx, chordDy) || 1;
  // 弦法线（单位）；符号选成让大圆中点相对弦向外拱的一侧
  let nx = -chordDy / chordLen;
  let ny = chordDx / chordLen;
  const midGc = unwrapped[Math.floor(n / 2)]!;
  const chordMidLng = (start[0] + end[0]) / 2;
  const chordMidLat = (start[1] + end[1]) / 2;
  const toGcX = midGc[0] - chordMidLng;
  const toGcY = midGc[1] - chordMidLat;
  if (nx * toGcX + ny * toGcY < 0) {
    nx = -nx;
    ny = -ny;
  }

  const points: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    // 弹道抛物线：4t(1−t)，中点=1，两端=0（区别于卫星过境的 sin 剖面）
    const elev = bowPeak * (4 * t * (1 - t));
    const side = lateral * (4 * t * (1 - t));
    const [lng, lat] = unwrapped[i]!;
    points.push([lng + nx * (elev + side), lat + ny * elev]);
  }
  return points;
}

/**
 * 执行 splitLineAtAntimeridian。
 * @param coordinates - 输入：`[number, number][]` — coordinates 参数
 * @returns 输出：`[number, number][][]` — [number, number][][] 实例
 */
export function splitLineAtAntimeridian(coordinates: [number, number][]): [number, number][][] {
  if (coordinates.length < 2) {
    return coordinates.length > 0 ? [coordinates] : [];
  }

  const segments: [number, number][][] = [];
  let segment: [number, number][] = [[coordinates[0]![0], coordinates[0]![1]]];

  for (let i = 1; i < coordinates.length; i++) {
    const prev = segment[segment.length - 1]!;
    const next = coordinates[i]!;
    const lng1 = prev[0];
    const lat1 = prev[1];
    const lng2 = next[0];
    const lat2 = next[1];

    if (Math.abs(lng2 - lng1) > 180) {
      let lng2u = lng2;
      if (lng2 - lng1 > 180) {
        lng2u -= 360;
      } else if (lng2 - lng1 < -180) {
        lng2u += 360;
      }
      const crossLng = lng2u > lng1 ? 180 : -180;
      const t = (crossLng - lng1) / (lng2u - lng1);
      const crossLat = lat1 + t * (lat2 - lat1);
      segment.push([crossLng, crossLat]);
      segments.push(segment);
      const wrapLng = crossLng === 180 ? -180 : 180;
      segment = [[wrapLng, crossLat], [lng2, lat2]];
    } else {
      segment.push([lng2, lat2]);
    }
  }

  if (segment.length > 0) {
    segments.push(segment);
  }
  return segments;
}

/**
 * 执行 buildRouteLineGeometry。
 * @param path - 输入：`FetchFlightPath` — 八分体路径
 * @param arcOptions - 输入：`GreatCircleArcOptions` — arcOptions 参数
 * @param display - 输入：`FlightArcDisplayOptions` — display 参数
 * @returns 输出：`object` — object 实例
 */
function buildRouteLineGeometry(
  path: FetchFlightPath,
  arcOptions: GreatCircleArcOptions,
  display: FlightArcDisplayOptions = {},
): { type: "LineString"; coordinates: [number, number][] } {
  const wps = validWaypoints(path);
  if (wps.length < 2) {
    return {
      type: "LineString",
      coordinates: wps.map((w) => [w.lng, w.lat] as [number, number]),
    };
  }

  const targetIp = flightPathTargetIp(path) ?? path.requestId;
  const visual = routeVisualFromIp(targetIp, display);
  const merged: GreatCircleArcOptions = {
    earthRadiusKm: resolveFlightArcDisplay(display).earthRadiusKm,
    orbitDisplayExaggeration:
      resolveFlightArcDisplay(display).orbitDisplayExaggeration,
    altitudeKm: arcOptions.altitudeKm ?? visual.leoAltitudeKm,
    ...arcOptions,
  };
  merged.altitudeKm = arcOptions.altitudeKm ?? visual.leoAltitudeKm;
  merged.earthRadiusKm = arcOptions.earthRadiusKm ?? resolveFlightArcDisplay(display).earthRadiusKm;
  merged.orbitDisplayExaggeration =
    arcOptions.orbitDisplayExaggeration ??
    display.orbitDisplayExaggeration ??
    resolveFlightArcDisplay().orbitDisplayExaggeration;

  const coords: [number, number][] = [];
  let prevLng = wps[0]!.lng;
  let prevLat = wps[0]!.lat;

  for (let i = 1; i < wps.length; i++) {
    const wp = wps[i]!;
    const arc = mapDisplayArc(
      { lat: prevLat, lng: prevLng },
      { lat: wp.lat, lng: wp.lng },
      merged,
    );
    if (coords.length === 0) {
      coords.push(...arc);
    } else {
      coords.push(...arc.slice(1));
    }
    const last = coords[coords.length - 1]!;
    prevLng = last[0];
    prevLat = last[1];
  }

  return { type: "LineString", coordinates: coords };
}

/**
 * 执行 unwrapWaypointsForDisplay。
 * @param waypoints - 输入：`FlightWaypoint[]` — waypoints 参数
 * @returns 输出：`FlightWaypoint & object[]` — FlightWaypoint & object[] 实例
 */
export function unwrapWaypointsForDisplay(waypoints: readonly FlightWaypoint[]): Array<FlightWaypoint & { displayLng: number }> {
  const out: Array<FlightWaypoint & { displayLng: number }> = [];
  let prevLng: number | null = null;
  for (const wp of waypoints) {
    if (!Number.isFinite(wp.lat) || !Number.isFinite(wp.lng) || (wp.lat === 0 && wp.lng === 0)) {
      continue;
    }
    const displayLng: number = prevLng === null ? wp.lng : unwrapDestinationLng(prevLng, wp.lng);
    out.push({ ...wp, displayLng });
    prevLng = displayLng;
  }
  return out;
}

/** GeoJSON FeatureCollection（航线 + 航点） */
export type FlightPathGeoJson = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: Record<string, unknown>;
    geometry:
      | { type: "LineString"; coordinates: [number, number][] }
      | { type: "MultiLineString"; coordinates: [number, number][][] }
      | { type: "Point"; coordinates: [number, number] };
  }>;
};

/**
 * 执行 flightPathsToGeoJsonCollection。
 * @param paths - 输入：`FetchFlightPath[]` — paths 参数
 * @param display - 输入：`FlightArcDisplayOptions` — display 参数
 * @param options - 输入：`object` — 配置选项
 * @returns 输出：`FlightPathGeoJson` — FlightPathGeoJson 实例
 */
export function flightPathsToGeoJsonCollection(
  paths: readonly FetchFlightPath[],
  display: FlightArcDisplayOptions = {},
  options: {
    hotIps?: ReadonlySet<string> | readonly string[];
  /** 是否输出航点 Point（大规模热池建议 false） */
    includeWaypoints?: boolean;
  /** 精简属性 + 更少弧线采样点，供地图实时绘制 */
    compact?: boolean;
  } = {},
): FlightPathGeoJson {
  const features: FlightPathGeoJson["features"] = [];
  const filtered =
    options.hotIps !== undefined ? filterFlightPathsByHotIps(paths, options.hotIps) : [...paths];
  const includeWaypoints = options.includeWaypoints ?? true;
  const compact = options.compact ?? false;
  const arcOpts = compact ? { minSteps: 8, maxSteps: 24 } : {};

  const ips = filtered
    .map((p) => flightPathTargetIp(p))
    .filter((ip): ip is string => !!ip);
  const visualByIp = display.visualByIp ?? assignDistinctRouteVisuals(ips, display);
  const displayWithVisuals: FlightArcDisplayOptions = { ...display, visualByIp };

  for (const path of filtered) {
    const targetIp = flightPathTargetIp(path);
    if (!targetIp) continue;

    const visual = routeVisualFromIp(targetIp, displayWithVisuals);
    const line = flightPathToGeoJsonLine(path, arcOpts, displayWithVisuals);
    const theta =
      path.waypoints.length >= 2
        ? angularDistanceRad(path.waypoints[0]!, path.waypoints[path.waypoints.length - 1]!)
        : 0;
    const bowDeg =
      leoOrbitalBowDeg(
        theta,
        visual.leoAltitudeKm,
        resolveFlightArcDisplay(display).earthRadiusKm,
      ) * (resolveFlightArcDisplay(display).orbitDisplayExaggeration);

    features.push({
      type: "Feature",
      properties: compact
        ? {
            kind: "route",
            requestId: path.requestId,
            pinnedIp: targetIp,
            routeColor: visual.color,
            leoAltitudeKm: visual.leoAltitudeKm,
            totalDurationMs: path.totalDurationMs,
            httpStatus: path.httpStatus,
            bodyBytes: path.bodyBytes,
          }
        : {
            kind: "route",
            requestId: path.requestId,
            pinnedIp: targetIp,
            routeColor: visual.color,
            leoAltitudeKm: visual.leoAltitudeKm,
            earthRadiusKm: resolveFlightArcDisplay(display).earthRadiusKm,
            arcBowDeg: Number(bowDeg.toFixed(3)),
            url: path.url,
            targetHostname: path.targetHostname,
            dnsMode: path.dnsMode,
            totalDurationMs: path.totalDurationMs,
            bodyBytes: path.bodyBytes,
            httpStatus: path.httpStatus,
            legs: path.legs,
            waypoints: path.waypoints,
          },
      geometry: line.geometry,
    });

    if (!includeWaypoints) continue;

    const displayWps = unwrapWaypointsForDisplay(path.waypoints);
    for (let i = 0; i < displayWps.length; i++) {
      const wp = displayWps[i]!;
      features.push({
        type: "Feature",
        properties: {
          kind: "waypoint",
          requestId: path.requestId,
          pinnedIp: targetIp,
          routeColor: visual.color,
          role: wp.role,
          label: wp.label,
          city: wp.city,
          region: wp.region,
          country: wp.country,
          ip: wp.ip,
          hostname: wp.hostname,
          waypointIndex: i,
        },
        geometry: {
          type: "Point",
          coordinates: [wp.displayLng, wp.lat],
        },
      });
    }
  }

  return { type: "FeatureCollection", features };
}
