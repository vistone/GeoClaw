import "./helpers/load-test-config.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import { GeoClawConfig } from "../src/core/GeoClawConfig.js";
import {
  createWebFetch,
  HostPinPool,
  resolveProxyUrl,
} from "../src/index.js";

test("resolveProxyUrl auto 仅 IPv6 走代理", () => {
  const proxyUrl = GeoClawConfig.get().getProxyUrl();
  assert.ok(proxyUrl);
  assert.equal(
    resolveProxyUrl({
      pinnedIp: "2404:6800::5b",
      proxyMode: "auto",
      proxyUrl,
    }),
    proxyUrl,
  );
  assert.equal(
    resolveProxyUrl({
      pinnedIp: "142.250.100.91",
      proxyMode: "auto",
      proxyUrl,
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
  const wf = createWebFetch({
    hostPinPool: pool,
    hostPinRegistry: false,
    hotConnectionPool: false,
    proxyMode: "auto",
  });
  const { bytes, trace } = await wf.getBytesWithTrace(
    "https://kh.google.com/rt/earth/PlanetoidMetadata",
    { trace: true },
  );
  assert.ok(bytes.length > 0);
  assert.equal(trace.pinnedIp, "2404:6800:4000:1006::5b");
  assert.equal(trace.proxy, GeoClawConfig.get().getProxyUrl());
});
