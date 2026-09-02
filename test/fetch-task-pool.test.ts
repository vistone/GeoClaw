import assert from "node:assert/strict";
import { test } from "node:test";

import { HotFetchNotOkError } from "../src/fetch/FetchErrors.js";
import { FetchTaskPool } from "../src/fetch/FetchTaskPool.js";
import type { HotConnectionPool } from "../src/fetch/HotConnectionPool.js";

function createMockHotPool(
  outcomes: Array<"ok" | "fail">,
): HotConnectionPool {
  let call = 0;
  return {
    fetchOnce: async () => {
      const next = outcomes[call++] ?? "ok";
      if (next === "fail") {
        throw new HotFetchNotOkError(403, "1.2.3.4");
      }
      return {
        response: {
          status: 200,
          statusText: "OK",
          headers: { entries: () => [].values() },
          arrayBuffer: async () => new ArrayBuffer(13),
          wreq: { timings: { wait: 1 } },
        },
        ip: "1.2.3.4",
        timings: { wait: 1 },
      };
    },
  } as unknown as HotConnectionPool;
}

test("FetchTaskPool 非 200 立即回队直至成功", async () => {
  const pool = createMockHotPool(["fail", "fail", "ok"]);
  const taskPool = new FetchTaskPool(pool, { concurrency: 1, maxAttempts: null });

  const result = await taskPool.submit("https://kh.google.com/rt/earth/PlanetoidMetadata");
  assert.equal(result.response.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(taskPool.pendingCount(), 0);
});

test("FetchTaskPool 超过 maxAttempts 拒绝", async () => {
  const pool = createMockHotPool(["fail", "fail", "fail"]);
  const taskPool = new FetchTaskPool(pool, { concurrency: 1, maxAttempts: 2 });

  await assert.rejects(
    () => taskPool.submit("https://example.com/x"),
    (err: Error) => err.name === "FetchTaskMaxAttemptsError",
  );
});
