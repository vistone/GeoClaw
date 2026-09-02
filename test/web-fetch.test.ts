import "./helpers/load-test-config.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import { GeoClawConfig } from "../src/core/GeoClawConfig.js";
import {
  TlsFingerprintCodec,
  WebFetch,
  BROWSER_TLS_PROFILES,
} from "../src/index.js";

test("TlsFingerprintCodec 默认 chrome_128 linux TLS profile", () => {
  const expected = GeoClawConfig.get().getTlsFingerprint();
  const codec = new TlsFingerprintCodec();
  assert.deepEqual(codec.resolveBrowser({}), expected);
  assert.ok(BROWSER_TLS_PROFILES.includes("chrome_128"));
});

test("TlsFingerprintCodec.buildHeaders 合并 Earth context", () => {
  const codec = new TlsFingerprintCodec();
  const context = GeoClawConfig.get().getContextHeaders();
  const headers = codec.buildHeaders({
    context,
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
