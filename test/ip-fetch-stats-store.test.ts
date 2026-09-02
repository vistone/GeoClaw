import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { IpFetchStatsStore } from "../src/fetch/IpFetchStatsStore.js";

test("IpFetchStatsStore 按域名分文件累计并落盘", () => {
  const dir = mkdtempSync(join(tmpdir(), "ip-stats-"));
  try {
    const store = new IpFetchStatsStore({
      dirPath: dir,
      flushIntervalMs: 0,
      seedForHostname: (hostname) =>
        hostname === "a.example.com"
          ? [
              { ip: "1.1.1.1", city: "A", country: "US", loc: "1,2" },
              { ip: "8.8.8.8", city: "B", country: "US" },
            ]
          : [{ ip: "9.9.9.9", city: "C", country: "US" }],
    });

    store.recordAttempt({
      hostname: "a.example.com",
      ip: "1.1.1.1",
      success: true,
      durationMs: 100,
      bytes: 50,
      city: "A",
      country: "US",
      loc: "1,2",
    });
    store.recordAttempt({
      hostname: "a.example.com",
      ip: "1.1.1.1",
      success: false,
      durationMs: 200,
    });
    store.recordAttempt({
      hostname: "b.example.com",
      ip: "9.9.9.9",
      success: true,
      durationMs: 50,
      bytes: 10,
    });
    store.addBytes("a.example.com", "1.1.1.1", 10);
    store.flush();

    const docA = parseYaml(readFileSync(join(dir, "a.example.com.yaml"), "utf8")) as {
      hostname: string;
      ips: Record<string, { requests: number; success: number; failed: number; totalBytes: number; avgDurationMs: number }>;
    };
    assert.equal(docA.hostname, "a.example.com");
    assert.equal(docA.ips["8.8.8.8"]!.requests, 0);
    const row = docA.ips["1.1.1.1"]!;
    assert.equal(row.requests, 2);
    assert.equal(row.success, 1);
    assert.equal(row.failed, 1);
    assert.equal(row.totalBytes, 60);
    assert.equal(row.avgDurationMs, 150);

    const docB = parseYaml(readFileSync(join(dir, "b.example.com.yaml"), "utf8")) as {
      ips: Record<string, { requests: number }>;
    };
    assert.equal(docB.ips["9.9.9.9"]!.requests, 1);
    assert.equal(docA.ips["9.9.9.9"], undefined);

    store.close();

    const reloaded = new IpFetchStatsStore({ dirPath: dir, flushIntervalMs: 0 });
    const again = reloaded.get("a.example.com", "1.1.1.1")!;
    assert.equal(again.requests, 2);
    assert.equal(again.totalBytes, 60);
    reloaded.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
