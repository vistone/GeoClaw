/**
 * IndexedDB：按域名缓存 IP 请求统计，避免经 WS 反复下发全量。
 */

const DB_NAME = "geoclaw-ip-stats";
const DB_VERSION = 1;
const STORE = "byHostname";

/**
 * @returns {Promise<IDBDatabase>}
 */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "hostname" });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
  });
}

/**
 * @param {string} hostname
 * @returns {Promise<{
 *   hostname: string;
 *   updatedAt?: string;
 *   meta?: object;
 *   rows: Record<string, object>;
 * } | null>}
 */
export async function loadIpStatsCache(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) return null;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const doc = await reqToPromise(store.get(host));
    db.close();
    return doc ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {string} hostname
 * @param {{
 *   updatedAt?: string;
 *   meta?: object;
 *   rows: Map<string, object> | Record<string, object>;
 * }} data
 */
export async function saveIpStatsCache(hostname, data) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) return;
  const rows =
    data.rows instanceof Map
      ? Object.fromEntries(data.rows)
      : { ...(data.rows ?? {}) };
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    await reqToPromise(
      store.put({
        hostname: host,
        updatedAt: data.updatedAt ?? new Date().toISOString(),
        meta: data.meta ?? {},
        rows,
      }),
    );
    db.close();
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * 合并增量行后写回。
 * @param {string} hostname
 * @param {object[]} upsert
 * @param {object} [meta]
 */
export async function upsertIpStatsCache(hostname, upsert, meta) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host || !upsert?.length) {
    if (meta) {
      const prev = (await loadIpStatsCache(host)) ?? { hostname: host, rows: {} };
      await saveIpStatsCache(host, {
        updatedAt: meta.updatedAt,
        meta: { ...prev.meta, ...meta },
        rows: prev.rows ?? {},
      });
    }
    return;
  }
  const prev = (await loadIpStatsCache(host)) ?? { hostname: host, rows: {} };
  const rows = { ...(prev.rows ?? {}) };
  for (const row of upsert) {
    if (row?.ip) rows[row.ip] = row;
  }
  await saveIpStatsCache(host, {
    updatedAt: meta?.updatedAt ?? prev.updatedAt,
    meta: { ...(prev.meta ?? {}), ...(meta ?? {}) },
    rows,
  });
}

/**
 * 删除某域名本地缓存（重置统计后用）。
 * @param {string} hostname
 */
export async function clearIpStatsCache(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    await reqToPromise(store.delete(host));
    db.close();
  } catch {
    /* ignore */
  }
}
