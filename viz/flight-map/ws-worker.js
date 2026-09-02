/**
 * WS Worker：独占 WebSocket 读写。
 * - ipStats → 专用 port 交给 IP Stats Worker（与主线程无交集）
 * - 其余消息 → 主线程（地图 / 脉冲）
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

    self.postMessage({ type: "wsMessage", data });
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

function scheduleReconnect() {
  if (intentionalClose || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 1200);
}
