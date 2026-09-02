import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildFetchFlightPath,
  buildFlightPathsFromHotIps,
  flightPathToGeoJsonLine,
  flightPathsToGeoJsonCollection,
  filterFlightPathsByHotIps,
  greatCircleArc,
  leoOrbitalBowDeg,
  mapDisplayArc,
  parseLocString,
  routeColorFromIp,
  assignDistinctRouteVisuals,
  routeVisualFromIp,
  angularDistanceRad,
} from "../src/fetch/FetchFlightPath.js";
import { HostPinRegistry } from "../src/fetch/HostPinRegistry.js";

test("parseLocString 解析 lat,lng", () => {
  assert.deepEqual(parseLocString("36.1540,-95.9928"), { lat: 36.154, lng: -95.9928 });
});

test("buildFetchFlightPath 生成航点与航段", () => {
  const path = buildFetchFlightPath({
    requestId: "r1",
    url: "https://kh.google.com/rt/earth/PlanetoidMetadata",
    targetHostname: "kh.google.com",
    dnsMode: "hostpin",
    pinnedIp: "108.177.104.136",
    pinRecord: {
      ip: "108.177.104.136",
      family: "ipv4",
      city: "Tulsa",
      region: "Oklahoma",
      country: "US",
      loc: "36.1540,-95.9928",
    },
    route: {
      originMode: "manual" as const,
      origin: { lat: 39.9042, lng: 116.4074, city: "Beijing", country: "CN", label: "client" },
      includeProxyHop: false,
      proxyGeo: null,
      ipinfoForSystemDns: false,
    },
    durationMs: 250,
    httpStatus: 200,
    bodyBytes: 100,
  });

  assert.equal(path.waypoints.length, 2);
  assert.equal(path.waypoints[0]?.role, "origin");
  assert.equal(path.waypoints[1]?.role, "target");
  assert.equal(path.legs.length, 1);
  assert.equal(path.legs[0]?.durationMs, 250);

  const geo = flightPathToGeoJsonLine(path);
  assert.equal(geo.geometry.type, "LineString");
  assert.ok(geo.geometry.coordinates.length > 2, "弧线应含多个插值点");
});

test("mapDisplayArc 北京→美国 连续穿越太平洋（经度展开）", () => {
  const arc = mapDisplayArc(
    { lat: 39.9042, lng: 116.4074 },
    { lat: 36.154, lng: -95.9928 },
    { altitudeKm: 400, earthRadiusKm: 6371, orbitDisplayExaggeration: 12 },
  );

  for (let i = 1; i < arc.length; i++) {
    assert.ok(Math.abs(arc[i]![0]! - arc[i - 1]![0]!) < 30, "相邻点经度应连续");
  }
  const endLng = arc[arc.length - 1]![0]!;
  assert.ok(endLng > 180, "美国终点应展开到 >180，以便穿越太平洋");
  assert.ok(Math.abs(endLng - 264) < 2);

  const mid = arc[Math.floor(arc.length / 2)]!;
  const start = arc[0]!;
  // 中点应因弹道拱高而抬离端点弦
  assert.ok(mid[1]! > (start[1]! + arc[arc.length - 1]![1]!) / 2);

  const path = buildFetchFlightPath({
    requestId: "cross",
    url: "https://kh.google.com/a",
    targetHostname: "kh.google.com",
    dnsMode: "hostpin",
    pinnedIp: "1.1.1.1",
    pinRecord: { ip: "1.1.1.1", family: "ipv4", loc: "36.1540,-95.9928", city: "Tulsa" },
    route: {
      originMode: "manual",
      origin: { lat: 39.9, lng: 116.4, city: "Beijing", country: "CN", label: "c" },
      includeProxyHop: false,
      proxyGeo: null,
      ipinfoForSystemDns: false,
    },
    durationMs: 100,
  });
  const geo = flightPathToGeoJsonLine(path);
  assert.equal(geo.geometry.type, "LineString");
  assert.ok(geo.geometry.coordinates.every((c, i, arr) => i === 0 || Math.abs(c[0]! - arr[i - 1]![0]!) < 30));
});

test("greatCircleArc 北京→美国 大圆路径向北弯曲", () => {
  const arc = greatCircleArc(
    { lat: 39.9042, lng: 116.4074 },
    { lat: 36.154, lng: -95.9928 },
    { steps: 64 },
  );
  assert.equal(arc.length, 65);
  const mid = arc[Math.floor(arc.length / 2)]!;
  const straightMidLat = (39.9042 + 36.154) / 2;
  assert.ok(mid[1]! > straightMidLat + 5, "大圆路径应向北拱起");
});

test("flightPathsToGeoJsonCollection 含航线与航点", () => {
  const path = buildFetchFlightPath({
    requestId: "r2",
    url: "https://kh.google.com/a",
    targetHostname: "kh.google.com",
    dnsMode: "hostpin",
    pinnedIp: "1.1.1.1",
    pinRecord: {
      ip: "1.1.1.1",
      family: "ipv4",
      loc: "36.1540,-95.9928",
      city: "Tulsa",
    },
    route: {
      originMode: "manual",
      origin: { lat: 39.9, lng: 116.4, city: "Beijing", country: "CN", label: "client" },
      includeProxyHop: false,
      proxyGeo: null,
      ipinfoForSystemDns: false,
    },
    durationMs: 100,
  });
  const fc = flightPathsToGeoJsonCollection([path]);
  assert.equal(fc.type, "FeatureCollection");
  assert.ok(fc.features.length >= 2);
  const route = fc.features.find((f) => f.properties.kind === "route");
  assert.ok(route?.properties.routeColor);
});

test("routeColorFromIp 同一 IP 同色、不同 IP 不同色", () => {
  const a = routeColorFromIp("108.177.104.136");
  const b = routeColorFromIp("142.250.189.14");
  const a2 = routeColorFromIp("108.177.104.136");
  assert.equal(a, a2);
  assert.notEqual(a, b);
  assert.match(a, /^hsl\(/);
});

test("filterFlightPathsByHotIps 只保留热池存活 IP", () => {
  const mk = (id: string, ip: string) =>
    buildFetchFlightPath({
      requestId: id,
      url: "https://kh.google.com/a",
      targetHostname: "kh.google.com",
      dnsMode: "hostpin",
      pinnedIp: ip,
      pinRecord: { ip, family: "ipv4", loc: "36.1540,-95.9928", city: "Tulsa" },
      route: {
        originMode: "manual",
        origin: { lat: 39.9, lng: 116.4, city: "Beijing", country: "CN", label: "c" },
        includeProxyHop: false,
        proxyGeo: null,
        ipinfoForSystemDns: false,
      },
      durationMs: 100,
    });

  const paths = [mk("r1", "1.1.1.1"), mk("r2", "2.2.2.2"), mk("r3", "3.3.3.3")];
  const hot = filterFlightPathsByHotIps(paths, ["1.1.1.1", "3.3.3.3"]);
  assert.equal(hot.length, 2);
  assert.deepEqual(
    hot.map((p) => p.pinnedIp),
    ["1.1.1.1", "3.3.3.3"],
  );
  assert.equal(filterFlightPathsByHotIps(paths, []).length, 0);
});

test("leoOrbitalBowDeg 高度越大拱高越大", () => {
  const theta = angularDistanceRad(
    { lat: 39.9, lng: 116.4 },
    { lat: 36.15, lng: -95.99 },
  );
  const low = leoOrbitalBowDeg(theta, 350, 6371);
  const high = leoOrbitalBowDeg(theta, 800, 6371);
  assert.ok(high > low);
  assert.ok(low > 0);
});

test("不同 IP 的 LEO 高度与颜色不同", () => {
  const display = { leoAltitudeMinKm: 12, leoAltitudeMaxKm: 48 };
  const va = routeVisualFromIp("1.1.1.1", display);
  const vb = routeVisualFromIp("8.8.8.8", display);
  assert.notEqual(va.color, vb.color);
  assert.ok(va.leoAltitudeKm >= 12 && va.leoAltitudeKm <= 48);

  const mk = (id: string, ip: string) =>
    buildFetchFlightPath({
      requestId: id,
      url: "https://kh.google.com/a",
      targetHostname: "kh.google.com",
      dnsMode: "hostpin",
      pinnedIp: ip,
      pinRecord: { ip, family: "ipv4", loc: "36.1540,-95.9928", city: "Tulsa" },
      route: {
        originMode: "manual",
        origin: { lat: 39.9, lng: 116.4, city: "Beijing", country: "CN", label: "c" },
        includeProxyHop: false,
        proxyGeo: null,
        ipinfoForSystemDns: false,
      },
      durationMs: 100,
    });

  const ca = flightPathToGeoJsonLine(mk("flight-1", "1.1.1.1"), {}, display).geometry.coordinates;
  const cb = flightPathToGeoJsonLine(mk("flight-2", "8.8.8.8"), {}, display).geometry.coordinates;
  const midA = ca[Math.floor(ca.length / 2)]!;
  const midB = cb[Math.floor(cb.length / 2)]!;
  assert.ok(Math.abs(midA[1]! - midB[1]!) > 0.01 || va.leoAltitudeKm !== vb.leoAltitudeKm);
});

test("assignDistinctRouteVisuals：颜色拉开且高度互不重复", () => {
  const ips = [
    "1.1.1.1",
    "8.8.8.8",
    "9.9.9.9",
    "1.0.0.1",
    "208.67.222.222",
    "64.6.64.6",
    "94.140.14.14",
    "185.228.168.9",
  ];
  const display = { leoAltitudeMinKm: 12, leoAltitudeMaxKm: 48 };
  const map = assignDistinctRouteVisuals(ips, display);
  assert.equal(map.size, ips.length);

  const heights = [...map.values()].map((v) => v.leoAltitudeKm);
  assert.equal(new Set(heights).size, heights.length, "LEO 高度不得重复");

  const colors = [...map.values()].map((v) => v.color);
  assert.equal(new Set(colors).size, colors.length, "颜色不得重复");

  // 色相按 N 等分，任意两色最小色相差应接近 360/n（允许环绕）
  const hues = colors.map((c) => {
    const m = /^hsl\(([\d.]+)/.exec(c);
    assert.ok(m);
    return Number(m![1]);
  });
  let minHueSep = 360;
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      const d = Math.abs(hues[i]! - hues[j]!);
      minHueSep = Math.min(minHueSep, Math.min(d, 360 - d));
    }
  }
  assert.ok(minHueSep >= 360 / ips.length - 0.5);

  const withVisuals = { ...display, visualByIp: map };
  const fc = flightPathsToGeoJsonCollection(
    ips.map((ip, i) =>
      buildFetchFlightPath({
        requestId: `r-${i}`,
        url: "https://kh.google.com/a",
        targetHostname: "kh.google.com",
        dnsMode: "hostpin",
        pinnedIp: ip,
        pinRecord: { ip, family: "ipv4", loc: "36.1540,-95.9928", city: "Tulsa" },
        route: {
          originMode: "manual",
          origin: { lat: 39.9, lng: 116.4, city: "Beijing", country: "CN", label: "c" },
          includeProxyHop: false,
          proxyGeo: null,
          ipinfoForSystemDns: false,
        },
        durationMs: 100,
      }),
    ),
    withVisuals,
  );
  const routeHeights = fc.features
    .filter((f) => f.properties.kind === "route")
    .map((f) => f.properties.leoAltitudeKm as number);
  assert.equal(new Set(routeHeights).size, routeHeights.length);
});

test("buildFlightPathsFromHotIps：按热池 IP 生成航线，无坐标则跳过", () => {
  const route = {
    originMode: "manual" as const,
    origin: { lat: 39.9, lng: 116.4, city: "Beijing", country: "CN", label: "client" },
    includeProxyHop: false,
    proxyGeo: null,
    ipinfoForSystemDns: false,
  };
  const records = new Map([
    ["1.1.1.1", { ip: "1.1.1.1", family: "ipv4" as const, loc: "37.3860,-122.0838", city: "Mountain View" }],
    ["8.8.8.8", { ip: "8.8.8.8", family: "ipv4" as const, loc: "37.4056,-122.0775", city: "Mountain View" }],
  ]);
  const paths = buildFlightPathsFromHotIps({
    hotIps: ["1.1.1.1", "8.8.8.8", "9.9.9.9"],
    hostname: "kh.google.com",
    url: "https://kh.google.com/rt/earth/PlanetoidMetadata",
    route,
    lookupPinRecord: (ip) => records.get(ip),
  });
  assert.equal(paths.length, 2);
  assert.deepEqual(
    paths.map((p) => p.pinnedIp).sort(),
    ["1.1.1.1", "8.8.8.8"],
  );
  for (const p of paths) {
    assert.equal(p.waypoints[0]?.role, "origin");
    assert.equal(p.waypoints.at(-1)?.role, "target");
    assert.equal(p.waypoints.at(-1)?.ip, p.pinnedIp);
  }

  // 无 origin 时不生成
  assert.equal(
    buildFlightPathsFromHotIps({
      hotIps: ["1.1.1.1"],
      hostname: "kh.google.com",
      url: "https://kh.google.com/a",
      route: { ...route, origin: null },
      lookupPinRecord: (ip) => records.get(ip),
    }).length,
    0,
  );
});

test("HostPinRegistry 发现 config/kh.google.com.yaml", () => {
  const reg = new HostPinRegistry({
    configDir: "config",
    family: "all",
    fallbackHostname: "kh.google.com",
    fallbackYamlPath: null,
  });
  assert.equal(reg.hasYamlForHostname("kh.google.com"), true);
  assert.equal(reg.hasYamlForHostname("example.com"), false);
});

test("HostPinRegistry 无 YAML 时 resolve 为 undefined", () => {
  const reg = new HostPinRegistry({
    configDir: "config",
    family: "all",
    fallbackHostname: null,
    fallbackYamlPath: null,
  });
  assert.equal(reg.resolveForUrl("https://example.com/"), undefined);
});
