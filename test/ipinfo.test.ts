import assert from "node:assert/strict";
import { test } from "node:test";

import { ipInfoToHostPinRecord, ipInfoToOrigin } from "../src/fetch/FetchRouteResolver.js";

test("ipInfoToOrigin 解析 loc", () => {
  const origin = ipInfoToOrigin({
    ip: "1.2.3.4",
    city: "Shanghai",
    country: "CN",
    loc: "31.2304,121.4737",
  });
  assert.equal(origin.lat, 31.2304);
  assert.equal(origin.lng, 121.4737);
  assert.equal(origin.city, "Shanghai");
});

test("ipInfoToHostPinRecord 转为 HostPin 记录", () => {
  const rec = ipInfoToHostPinRecord({
    ip: "8.8.8.8",
    loc: "37.4056,-122.0775",
    city: "Mountain View",
    country: "US",
  });
  assert.ok(rec);
  assert.equal(rec!.ip, "8.8.8.8");
  assert.equal(rec!.loc, "37.4056,-122.0775");
});
