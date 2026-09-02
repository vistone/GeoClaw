import assert from "node:assert/strict";
import { test } from "node:test";

import { ColdConnectionPool } from "../src/fetch/ColdConnectionPool.js";

test("ColdConnectionPool 403 入池且 isCold", () => {
  const pool = new ColdConnectionPool({ coldPoolStatuses: [403, 429] });
  assert.equal(pool.shouldAdmit(403), true);
  assert.equal(pool.shouldAdmit(500), false);
  pool.admit("1.2.3.4", 403, 1000);
  assert.equal(pool.isCold("1.2.3.4"), true);
  assert.equal(pool.getColdCount(), 1);
  pool.release("1.2.3.4");
  assert.equal(pool.isCold("1.2.3.4"), false);
});

test("ColdConnectionPool getDueForReheat  respect backoff", () => {
  const pool = new ColdConnectionPool({ coldPoolStatuses: [403] });
  pool.admit("9.9.9.9", 403, 60_000);
  assert.deepEqual(pool.getDueForReheat(), []);
  assert.deepEqual(pool.getDueForReheat(Date.now() + 61_000), ["9.9.9.9"]);
});
