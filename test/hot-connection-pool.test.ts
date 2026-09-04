import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyWarmHttpStatus,
  HotConnectionPool,
  isEofOrTimeoutError,
  isTimeoutError,
  pickFairHotIp,
} from "../src/fetch/HotConnectionPool.js";

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

test("pickFairHotIp 优先参与少的，同次数选更久未用", () => {
  const now = 100_000;
  const picked = pickFairHotIp(
    [
      { ip: "busy", lastUsedAt: now - 50_000, assignCount: 100 },
      { ip: "idle", lastUsedAt: now - 1_000, assignCount: 2 },
      { ip: "idle-older", lastUsedAt: now - 40_000, assignCount: 2 },
    ],
    now,
    60_000,
  );
  assert.equal(picked, "idle-older");
});

test("pickFairHotIp warmSlack 同带内优先最近用过，落后仍会入选", () => {
  const now = 100_000;
  const warm = pickFairHotIp(
    [
      { ip: "lag", lastUsedAt: now - 80_000, assignCount: 0 },
      { ip: "hot", lastUsedAt: now - 100, assignCount: 1 },
      { ip: "hot2", lastUsedAt: now - 200, assignCount: 1 },
    ],
    now,
    60_000,
    { warmSlack: 2 },
  );
  // min=0，lag 必须先补
  assert.equal(warm, "lag");

  const reuse = pickFairHotIp(
    [
      { ip: "a", lastUsedAt: now - 50_000, assignCount: 5 },
      { ip: "b", lastUsedAt: now - 100, assignCount: 5 },
      { ip: "c", lastUsedAt: now - 10_000, assignCount: 6 },
    ],
    now,
    60_000,
    { warmSlack: 2 },
  );
  // 同为最低 assignCount=5 时优先最近用过的 b
  assert.equal(reuse, "b");
});

test("isEofOrTimeoutError 识别超时与 EOF", () => {
  assert.equal(isEofOrTimeoutError(new Error("operation timed out")), true);
  assert.equal(isEofOrTimeoutError(new Error("unexpected EOF")), true);
  assert.equal(isEofOrTimeoutError(new Error("HTTP 500")), false);
});

test("isTimeoutError 仅识别超时", () => {
  assert.equal(isTimeoutError(new Error("operation timed out")), true);
  assert.equal(isTimeoutError(new Error("ERR_TIMEOUT")), true);
  assert.equal(isTimeoutError(new Error("unexpected EOF")), false);
});

test("startInitialWarmup 立即返回不阻塞", async () => {
  const pool = new HotConnectionPool({
    hostname: "kh.google.com",
    ips: [],
    warmupUrl: "https://kh.google.com/rt/earth/PlanetoidMetadata",
    headers: {},
    browser: "chrome_128",
    proxyMode: "never",
    poolIdleTimeout: false,
    poolMaxIdlePerHost: 1,
    deniedStatuses: denied,
    coldPoolStatuses: denied,
    successStatus: 200,
    initialConcurrency: 2,
    reheatConcurrency: 1,
    reheatIntervalMs: 5000,
    reheatBackoffMs: 1000,
    deniedBackoffMs: 2000,
    autoStartWarmup: false,
    idleExpireMs: 60_000,
    keepAliveConcurrency: 1,
  });

  const t0 = Date.now();
  pool.startInitialWarmup();
  assert.ok(Date.now() - t0 < 50, "startInitialWarmup 应同步返回");
  const summary = await pool.waitInitialWarmup();
  assert.equal(summary.total, 0);
  assert.equal(pool.isInitialWarmupInProgress(), false);
});
