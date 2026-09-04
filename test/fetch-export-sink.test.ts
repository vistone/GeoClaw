import assert from "node:assert/strict";
import { test } from "node:test";

import { FetchExportSink } from "../src/fetch/FetchExportSink.js";

test("FetchExportSink.putRaw 原样 PUT 且只用出站 headers", async () => {
  const bodies: Uint8Array[] = [];
  const headersSeen: Record<string, string>[] = [];
  const sink = new FetchExportSink({
    enabled: true,
    method: "PUT",
    url: "https://export.example/store",
    headers: {
      "Content-Type": "application/octet-stream",
      Authorization: "Bearer test-token",
      "X-Custom": "out-only",
    },
    timeoutMs: 5000,
    proxyMode: "never",
    failOpen: false,
    putFn: async (input) => {
      assert.equal(input.method, "PUT");
      assert.equal(input.url, "https://export.example/store");
      bodies.push(input.body);
      headersSeen.push(input.headers);
      return { ok: true, status: 200, statusText: "OK" };
    },
  });

  const payload = new Uint8Array([0x00, 0xff, 0x10, 0x20]);
  await sink.putRaw(payload);
  assert.equal(bodies.length, 1);
  assert.deepEqual([...bodies[0]!], [0x00, 0xff, 0x10, 0x20]);
  assert.equal(headersSeen[0]!["Content-Type"], "application/octet-stream");
  assert.equal(headersSeen[0]!.Authorization, "Bearer test-token");
  assert.equal(headersSeen[0]!["X-Custom"], "out-only");
  assert.equal(Object.keys(headersSeen[0]!).includes("Origin"), false);
});

test("FetchExportSink failOpen=true 时 PUT 失败不抛", async () => {
  const sink = new FetchExportSink({
    enabled: true,
    method: "PUT",
    url: "https://export.example/store",
    headers: { "Content-Type": "application/octet-stream" },
    timeoutMs: null,
    proxyMode: "never",
    failOpen: true,
    putFn: async () => {
      throw new Error("network down");
    },
  });
  await sink.putRaw(new Uint8Array([1]));
});

test("FetchExportSink failOpen=false 时 PUT 失败抛错", async () => {
  const sink = new FetchExportSink({
    enabled: true,
    method: "PUT",
    url: "https://export.example/store",
    headers: { "Content-Type": "application/octet-stream" },
    timeoutMs: null,
    proxyMode: "never",
    failOpen: false,
    putFn: async () => ({ ok: false, status: 503, statusText: "Unavailable" }),
  });
  await assert.rejects(() => sink.putRaw(new Uint8Array([1])), /503/);
});

test("FetchExportSink.enabled=false 时不调用 putFn", async () => {
  let called = 0;
  const sink = new FetchExportSink({
    enabled: false,
    method: "PUT",
    url: "https://export.example/store",
    headers: {},
    timeoutMs: null,
    proxyMode: "never",
    failOpen: true,
    putFn: async () => {
      called += 1;
      return { ok: true, status: 200, statusText: "OK" };
    },
  });
  await sink.putRaw(new Uint8Array([9]));
  assert.equal(called, 0);
  assert.equal(sink.isActive(), false);
});
