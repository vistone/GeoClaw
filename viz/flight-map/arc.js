/**
 * 前端弹道弧 + 按 IP 着色（与服务端 FetchFlightPath 对齐）。
 * IP/原点/弧参数由 /api/map-assets 一次缓存；WS 只发绘制触发命令。
 */

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;
const GOLDEN_ANGLE_DEG = 137.508;

/** @param {string} s */
export function hashId(s) {
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * @param {string} ip
 * @param {{ leoAltitudeMinKm?: number; leoAltitudeMaxKm?: number }} [display]
 */
export function visualFromIp(ip, display = {}) {
  const h = hashId(ip);
  const hue = (h * GOLDEN_ANGLE_DEG) % 360;
  const band = h % 3;
  const sat = band === 0 ? 78 : band === 1 ? 88 : 70;
  const light = band === 0 ? 42 : band === 1 ? 55 : 68;
  const color = `hsl(${hue.toFixed(1)} ${sat}% ${light}%)`;
  const minKm = display.leoAltitudeMinKm ?? 12;
  const maxKm = Math.max(minKm, display.leoAltitudeMaxKm ?? 48);
  const span = maxKm - minKm;
  const leoAltitudeKm =
    span <= 0 ? minKm : minKm + (hashId(`${ip}:leo`) % (Math.floor(span) + 1));
  return { color, leoAltitudeKm };
}

/**
 * @param {{ lat: number; lng: number }} from
 * @param {{ lat: number; lng: number }} to
 * @param {{
 *   earthRadiusKm?: number;
 *   altitudeKm?: number;
 *   orbitDisplayExaggeration?: number;
 *   steps?: number;
 *   minSteps?: number;
 *   maxSteps?: number;
 * }} [options]
 * @returns {Array<[number, number]>} [lng, lat]
 */
export function mapDisplayArc(from, to, options = {}) {
  const R = options.earthRadiusKm ?? 6371;
  const altitudeKm = options.altitudeKm ?? 30;
  const exag = options.orbitDisplayExaggeration ?? 2.5;
  const theta = angularDistanceRad(from, to);
  const bowPeak = leoOrbitalBowDeg(theta, altitudeKm, R) * exag;
  const minSteps = options.minSteps ?? 16;
  const maxSteps = options.maxSteps ?? 48;
  const steps =
    options.steps ??
    Math.max(minSteps, Math.min(maxSteps, Math.ceil(Math.max(theta * RAD2DEG, 1) / 2.5)));

  const ground = greatCircleArc(from, to, { steps });
  /** @type {Array<[number, number]>} */
  const unwrapped = [];
  let prevLng = /** @type {number | null} */ (null);
  for (const [lng, lat] of ground) {
    const ulng = prevLng === null ? lng : unwrapLng(prevLng, lng);
    unwrapped.push([ulng, lat]);
    prevLng = ulng;
  }

  if (unwrapped.length >= 2) {
    const startLng = unwrapped[0][0];
    const wantEnd = unwrapLng(startLng, to.lng);
    const gotEnd = unwrapped[unwrapped.length - 1][0];
    if (Math.abs(gotEnd - wantEnd) > 1) {
      const got0 = unwrapped[0][0];
      const spanGot = gotEnd - got0 || 1;
      for (let i = 0; i < unwrapped.length; i++) {
        const t = (unwrapped[i][0] - got0) / spanGot;
        unwrapped[i][0] = startLng + (wantEnd - startLng) * t;
      }
    }
  }

  const n = unwrapped.length;
  if (n < 2) return unwrapped;
  const start = unwrapped[0];
  const end = unwrapped[n - 1];
  const chordDx = end[0] - start[0];
  const chordDy = end[1] - start[1];
  const chordLen = Math.hypot(chordDx, chordDy) || 1;
  let nx = -chordDy / chordLen;
  let ny = chordDx / chordLen;
  const midGc = unwrapped[Math.floor(n / 2)];
  const chordMidLng = (start[0] + end[0]) / 2;
  const chordMidLat = (start[1] + end[1]) / 2;
  if (nx * (midGc[0] - chordMidLng) + ny * (midGc[1] - chordMidLat) < 0) {
    nx = -nx;
    ny = -ny;
  }

  /** @type {Array<[number, number]>} */
  const points = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const elev = bowPeak * (4 * t * (1 - t));
    const [lng, lat] = unwrapped[i];
    points.push([lng + nx * elev, lat + ny * elev]);
  }
  return points;
}

function unwrapLng(lng1, lng2) {
  let dLon = lng2 - lng1;
  if (dLon > 180) dLon -= 360;
  else if (dLon < -180) dLon += 360;
  return lng1 + dLon;
}

function angularDistanceRad(a, b) {
  const φ1 = a.lat * DEG2RAD;
  const φ2 = b.lat * DEG2RAD;
  let dλ = (b.lng - a.lng) * DEG2RAD;
  if (dλ > Math.PI) dλ -= 2 * Math.PI;
  if (dλ < -Math.PI) dλ += 2 * Math.PI;
  const cosδ = clamp(
    Math.sin(φ1) * Math.sin(φ2) + Math.cos(φ1) * Math.cos(φ2) * Math.cos(dλ),
    -1,
    1,
  );
  return Math.acos(cosδ);
}

function leoOrbitalBowDeg(thetaRad, altitudeKm, earthRadiusKm = 6371) {
  const half = thetaRad / 2;
  if (half < 1e-9) return 0;
  const h = Math.max(0, altitudeKm);
  const R = Math.max(1, earthRadiusKm);
  const deltaSagitta = h * (1 - Math.cos(half));
  const halfChord = R * Math.sin(half);
  return Math.atan2(deltaSagitta, Math.max(halfChord, 1e-6)) * RAD2DEG;
}

function greatCircleArc(from, to, options = {}) {
  const start = latLngToUnit(from.lat, from.lng);
  const end = latLngToUnit(to.lat, to.lng);
  const dot = clamp(start[0] * end[0] + start[1] * end[1] + start[2] * end[2], -1, 1);
  const omega = Math.acos(dot);
  if (omega < 1e-10) return [unitToLngLat(start)];
  const steps = options.steps ?? 32;
  const sinOmega = Math.sin(omega);
  /** @type {Array<[number, number]>} */
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = Math.sin((1 - t) * omega) / sinOmega;
    const b = Math.sin(t * omega) / sinOmega;
    points.push(
      unitToLngLat([
        a * start[0] + b * end[0],
        a * start[1] + b * end[1],
        a * start[2] + b * end[2],
      ]),
    );
  }
  return points;
}

function latLngToUnit(lat, lng) {
  const φ = lat * DEG2RAD;
  const λ = lng * DEG2RAD;
  const cosφ = Math.cos(φ);
  return [cosφ * Math.cos(λ), cosφ * Math.sin(λ), Math.sin(φ)];
}

function unitToLngLat(v) {
  const [x, y, z] = v;
  return [Math.atan2(y, x) * RAD2DEG, Math.atan2(z, Math.hypot(x, y)) * RAD2DEG];
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}
