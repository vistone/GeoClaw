import assert from "node:assert/strict";
import { test } from "node:test";

import { createWebFetch, DEFAULT_TLS_FINGERPRINT } from "../src/index.js";

test("WebFetch live transport trace against kh.google.com", async () => {
  const wf = createWebFetch();
  const url = "https://kh.google.com/rt/earth/PlanetoidMetadata";
  const { bytes, trace } = await wf.getBytesWithTrace(url, { trace: true });

  assert.equal(trace.transport, "node-wreq");
  assert.equal(trace.status, 200);
  assert.ok(trace.http2FingerprintEnabled);
  assert.ok(trace.profileHeadersEnabled);
  assert.deepEqual(trace.browser, DEFAULT_TLS_FINGERPRINT);
  assert.ok(bytes.length > 0);
  assert.ok(trace.tlsPeer?.hasCertificate);
  assert.ok((trace.tlsPeer?.chainLength ?? 0) >= 1);
  assert.equal(trace.dnsPinned, true);
  assert.ok(trace.pinnedIp);
  assert.equal(trace.requestHostname, "kh.google.com");
  assert.ok(trace.timings && trace.timings.wait >= 0);

  console.log(
    `[transport] node-wreq profile=${JSON.stringify(trace.browser)} pinnedIp=${trace.pinnedIp} http2=${trace.http2FingerprintEnabled} likelyH2=${trace.likelyHttp2Response} waitMs=${trace.timings?.wait} bytes=${bytes.length}`,
  );
});
