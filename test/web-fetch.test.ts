import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BrowserFingerprintCodec,
  WebFetch,
  EARTH_WEB_CONTEXT_HEADERS,
} from "../src/index.js";

test("BrowserFingerprintCodec 生成 User-Agent 与 Earth context", () => {
  const codec = new BrowserFingerprintCodec();
  const headers = codec.build({
    context: EARTH_WEB_CONTEXT_HEADERS,
    overrides: { "Accept-Encoding": "identity" },
  });

  assert.match(headers["user-agent"] ?? headers["User-Agent"] ?? "", /Chrome|Firefox|Safari/i);
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
