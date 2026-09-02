import assert from "node:assert/strict";
import { test } from "node:test";

import { FetchMetrics } from "../src/fetch/FetchMetrics.js";
import { IpGeoRegistry } from "../src/fetch/IpGeoRegistry.js";
import { parseKhGoogleYaml } from "../src/fetch/HostPinPool.js";

const SAMPLE_YAML = `
ipv4:
  - ip: 1.1.1.1
    city: Dallas
    region: Texas
    country: US
  - ip: 2.2.2.2
    city: Tulsa
    region: Oklahoma
    country: US
`;

test("parseKhGoogleYaml 解析地区字段", () => {
  const parsed = parseKhGoogleYaml(SAMPLE_YAML);
  assert.equal(parsed.ipv4[0]?.country, "US");
  assert.equal(parsed.ipv4[0]?.region, "Texas");
  assert.equal(parsed.ipv4[1]?.city, "Tulsa");
});

test("FetchMetrics 汇总请求与失败码", () => {
  const geo = new IpGeoRegistry(parseKhGoogleYaml(SAMPLE_YAML).all);
  const metrics = new FetchMetrics(
    {
      enabled: true,
      logEachAttempt: false,
      summaryIntervalMs: 0,
      maxRecentAttempts: 10,
      maxRecentRequests: 10,
      maxRecentFlightPaths: 10,
    },
    geo,
  );

  const id1 = metrics.createRequestId();
  metrics.onRequestStart(id1, "https://kh.google.com/a");
  metrics.onAttempt(id1, "https://kh.google.com/a", 1, "1.1.1.1", { kind: "http_error", httpStatus: 403 }, 120);
  metrics.onAttempt(id1, "https://kh.google.com/a", 2, "2.2.2.2", { kind: "success", httpStatus: 200 }, 80, 1024);
  metrics.onRequestSuccess(id1, "2.2.2.2", 200, 1024);

  const id2 = metrics.createRequestId();
  metrics.onRequestStart(id2, "https://kh.google.com/b");
  metrics.onAttempt(id2, "https://kh.google.com/b", 1, "1.1.1.1", { kind: "transport_error" }, 50);
  metrics.onRequestFailed(id2, "1.1.1.1");

  const snap = metrics.getSnapshot();
  assert.equal(snap.submitted, 2);
  assert.equal(snap.succeeded, 1);
  assert.equal(snap.failed, 1);
  assert.equal(snap.totalAttempts, 3);
  assert.equal(snap.byStatus["403"], 1);
  assert.equal(snap.byStatus["200"], 1);
  assert.equal(snap.byStatus["transport"], 1);
  assert.equal(snap.byCountry["US"]?.attempts, 3);
  assert.equal(snap.byRegion["Texas"]?.attempts, 2);
  assert.equal(snap.byIp["2.2.2.2"]?.success, 1);
  assert.equal(snap.recentRequests.length, 2);
  assert.equal(snap.recentAttempts.length, 3);
});
