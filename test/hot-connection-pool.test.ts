import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyWarmHttpStatus } from "../src/fetch/HotConnectionPool.js";

const denied = [403, 429] as const;

test("classifyWarmHttpStatus 200 入热池", () => {
  assert.equal(classifyWarmHttpStatus(200, 200, denied), "hot");
});

test("classifyWarmHttpStatus 403/429 拒绝服务", () => {
  assert.equal(classifyWarmHttpStatus(403, 200, denied), "denied");
  assert.equal(classifyWarmHttpStatus(429, 200, denied), "denied");
});

test("classifyWarmHttpStatus 其他状态重试", () => {
  assert.equal(classifyWarmHttpStatus(500, 200, denied), "retry");
  assert.equal(classifyWarmHttpStatus(502, 200, denied), "retry");
});
