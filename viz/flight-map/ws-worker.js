/**
 * WS Worker：独占 WebSocket 读写。
 * - ipStats → 专用 port 交给 IP Stats Worker（与主线程无交集）
 * - 高频可合并消息（pulse / poolStatus / nicTraffic）只保留最新，淘汰积压
 * - 其余消息 → 主线程
 */

/** @type {WebSocket | null} */
let ws = null;
/** @type {string} */
let wsUrl = "";
/** @type {MessagePort | null} */
let ipStatsPort = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null;
let intentionalClose = false;

/** 可合并类型：主线程忙时只保留最新一帧 */
const COALESCE_TYPES = new Set(["pulse", "poolStatus", "nicTraffic"]);

/** @type {Map<string, object>} */
const pendingByType = new Map();
/** @type {object[]} */
const pendingExact = [];
let flushScheduled = false;

self.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "bindIpStatsPort") {
    ipStatsPort = ev.ports[0] ?? null;
    return;
  }

  if (msg.type === "connect") {
    intentionalClose = false;
    wsUrl = String(msg.url || "");
    connect();
    return;
  }

  if (msg.type === "send") {
    if (ws && ws.readyState === WebSocket.OPEN && msg.payload != null) {
      ws.send(typeof msg.payload === "string" ? msg.payload : JSON.stringify(msg.payload));
    }
    return;
  }

  if (msg.type === "close") {
    intentionalClose = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    ws?.close();
    ws = null;
  }
};

function connect() {
  if (!wsUrl) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    self.postMessage({
      type: "wsError",
      error: err instanceof Error ? err.message : String(err),
    });
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    self.postMessage({ type: "wsOpen" });
  });

  ws.addEventListener("message", (ev) => {
    let data;
    try {
      data = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;

    // 隔离：IP 统计绝不进主线程原始大包
    if (data.type === "ipStats") {
      ipStatsPort?.postMessage(data);
      return;
    }

    enqueueToMain(data);
  });

  ws.addEventListener("close", () => {
    ws = null;
    self.postMessage({ type: "wsClose" });
    if (!intentionalClose) scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    self.postMessage({ type: "wsError", error: "websocket error" });
  });
}

/**
 * 入队主线程：可合并类型覆盖旧帧；脉冲按落点合并 items。
 * @param {object} data
 */
function enqueueToMain(data) {
  const t = String(data.type ?? "");
  if (COALESCE_TYPES.has(t)) {
    if (t === "pulse") {
      pendingByType.set(t, mergePulse(pendingByType.get(t), data));
    } else {
      pendingByType.set(t, data);
    }
  } else {
    pendingExact.push(data);
  }
  scheduleFlushToMain();
}

/**
 * 合并两帧 pulse：同 IP 只保留最新一条。
 * @param {object | undefined} prev
 * @param {object} next
 */
function mergePulse(prev, next) {
  /** @type {Map<string, object>} */
  const byIp = new Map();
  for (const item of prev?.items ?? []) {
    const ip = String(item?.ip ?? "");
    if (ip) byIp.set(ip, item);
  }
  for (const item of next?.items ?? []) {
    const ip = String(item?.ip ?? "");
    if (ip) byIp.set(ip, item);
  }
  return {
    ...next,
    items: [...byIp.values()],
  };
}

function scheduleFlushToMain() {
  if (flushScheduled) return;
  flushScheduled = true;
  // 约一帧一次交给主线程；期间到达的可合并消息只保留最新
  setTimeout(() => {
    flushScheduled = false;
    const exact = pendingExact.splice(0, pendingExact.length);
    const coalesced = [...pendingByType.values()];
    pendingByType.clear();
    for (const data of exact) {
      self.postMessage({ type: "wsMessage", data });
    }
    for (const data of coalesced) {
      self.postMessage({ type: "wsMessage", data });
    }
    if (pendingExact.length > 0 || pendingByType.size > 0) {
      scheduleFlushToMain();
    }
  }, 16);
}

function scheduleReconnect() {
  if (intentionalClose || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 200);
}
