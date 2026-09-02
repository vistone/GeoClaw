import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createWebFetch,
  DEFAULT_GEOCLAW_PROXY,
  HostPinPool,
  resolveProxyUrl,
} from "../src/index.js";

test("resolveProxyUrl auto 仅 IPv6 走代理", () => {
  assert.equal(
    resolveProxyUrl({
      pinnedIp: "2404:6800::5b",
      proxyMode: "auto",
      proxyUrl: DEFAULT_GEOCLAW_PROXY,
    }),
    DEFAULT_GEOCLAW_PROXY,
  );
  assert.equal(
    resolveProxyUrl({
      pinnedIp: "142.250.100.91",
      proxyMode: "auto",
      proxyUrl: DEFAULT_GEOCLAW_PROXY,
    }),
    undefined,
  );
});

test("WebFetch.resolveProxy 与 options 一致", () => {
  const wf = createWebFetch({ proxy: "socks5://127.0.0.1:20170", proxyMode: "auto" });
  assert.equal(wf.resolveProxy("2404:6800::5b"), "socks5://127.0.0.1:20170");
  assert.equal(wf.resolveProxy("8.8.8.8"), undefined);
});

test("WebFetch IPv6 HostPin live via SOCKS5", async () => {
  const pool = new HostPinPool({
    hostname: "kh.google.com",
    ips: ["2404:6800:4000:1006::5b"],
  });
  const wf = createWebFetch({ hostPinPool: pool, proxyMode: "auto" });
  const { bytes, trace } = await wf.getBytesWithTrace(
    "https://kh.google.com/rt/earth/PlanetoidMetadata",
    { trace: true },
  );
  assert.ok(bytes.length > 0);
  assert.equal(trace.pinnedIp, "2404:6800:4000:1006::5b");
  assert.equal(trace.proxy, DEFAULT_GEOCLAW_PROXY);
});
