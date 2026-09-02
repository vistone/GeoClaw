import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TlsFingerprintCodec,
  WebFetch,
  DEFAULT_TLS_FINGERPRINT,
  EARTH_WEB_CONTEXT_HEADERS,
  BROWSER_TLS_PROFILES,
} from "../src/index.js";

test("TlsFingerprintCodec 默认 chrome_128 linux TLS profile", () => {
  const codec = new TlsFingerprintCodec();
  assert.deepEqual(codec.resolveBrowser({}), DEFAULT_TLS_FINGERPRINT);
  assert.ok(BROWSER_TLS_PROFILES.includes("chrome_128"));
});

test("TlsFingerprintCodec.buildHeaders 合并 Earth context", () => {
  const codec = new TlsFingerprintCodec();
  const headers = codec.buildHeaders({
    context: EARTH_WEB_CONTEXT_HEADERS,
    overrides: { "Accept-Encoding": "identity" },
  });

  assert.equal(headers.Origin, "https://earth.google.com");
  assert.equal(headers.Referer, "https://earth.google.com/");
  assert.equal(headers["Accept-Encoding"], "identity");
});

test("WebFetch.buildHeaders 支持 headerOverrides", () => {
  const wf = new WebFetch({
    headerOverrides: { "X-Custom": "geoclaw-test" },
  });
  const headers = wf.buildHeaders({ headers: { "X-Request": "1" } });

  assert.equal(headers["X-Custom"], "geoclaw-test");
  assert.equal(headers["X-Request"], "1");
  assert.equal(headers["Accept-Encoding"], "identity");
});

test("WebFetch.resolveBrowser 支持单次 profile 覆盖", () => {
  const wf = new WebFetch({ tlsFingerprint: "chrome_131" });
  assert.equal(wf.resolveBrowser({ tlsFingerprint: "chrome_132" }), "chrome_132");
  assert.equal(wf.resolveBrowser({}), "chrome_131");
});
