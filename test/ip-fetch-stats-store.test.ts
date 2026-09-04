import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("IpFetchStatsStore 缺文件时种子后立即落盘", () => {
  const dir = mkdtempSync(join(tmpdir(), "ip-stats-seed-"));
  try {
    const store = new IpFetchStatsStore({
      dirPath: dir,
      flushIntervalMs: 0,
      seedForHostname: () => [
        { ip: "203.0.113.1", city: "X", country: "US", loc: "1,2" },
        { ip: "203.0.113.2", city: "Y", country: "JP", loc: "3,4" },
      ],
    });
    const path = join(dir, "seed.example.com.yaml");
    assert.equal(existsSync(path), false);
    const snap = store.snapshot("seed.example.com");
    assert.equal(Object.keys(snap.ips).length, 2);
    assert.equal(existsSync(path), true);
    const doc = parseYaml(readFileSync(path, "utf8")) as {
      ips: Record<string, { requests: number; country?: string }>;
    };
    assert.equal(doc.ips["203.0.113.1"]!.requests, 0);
    assert.equal(doc.ips["203.0.113.1"]!.country, "US");
    assert.equal(doc.ips["203.0.113.2"]!.country, "JP");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("IpFetchStatsStore.materializeMissingFromSeeds 跳过已有文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "ip-stats-boot-"));
  try {
    writeFileSync(
      join(dir, "keep.example.com.yaml"),
      "hostname: keep.example.com\nupdatedAt: 2020-01-01T00:00:00.000Z\nips:\n  1.1.1.1:\n    requests: 9\n    success: 9\n    failed: 0\n    totalBytes: 1\n    totalDurationMs: 1\n",
      "utf8",
    );
    const store = new IpFetchStatsStore({
      dirPath: dir,
      flushIntervalMs: 0,
      seedForHostname: (hostname) =>
        hostname === "keep.example.com"
          ? [{ ip: "1.1.1.1", country: "US" }]
          : [{ ip: "9.9.9.9", country: "US" }],
    });
    const n = store.materializeMissingFromSeeds(["keep.example.com", "new.example.com"]);
    assert.equal(n, 1);
    assert.equal(existsSync(join(dir, "new.example.com.yaml")), true);
    const keep = parseYaml(readFileSync(join(dir, "keep.example.com.yaml"), "utf8")) as {
      ips: Record<string, { requests: number }>;
    };
    assert.equal(keep.ips["1.1.1.1"]!.requests, 9);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("IpFetchStatsStore.listOrderedActiveIps 含零请求种子 IP", () => {
  const dir = mkdtempSync(join(tmpdir(), "ip-stats-list-"));
  try {
    const store = new IpFetchStatsStore({
      dirPath: dir,
      flushIntervalMs: 0,
      seedForHostname: () => [
        { ip: "198.51.100.1", country: "US" },
        { ip: "198.51.100.2", country: "US" },
        { ip: "2001:db8::1", country: "JP" },
      ],
    });
    store.recordAttempt({
      hostname: "list.example.com",
      ip: "198.51.100.2",
      success: true,
      durationMs: 10,
    });
    const ips = store.listOrderedActiveIps("list.example.com");
    assert.equal(ips.length, 3);
    assert.equal(ips[0], "198.51.100.2");
    assert.ok(ips.includes("198.51.100.1"));
    assert.ok(ips.includes("2001:db8::1"));
    const win = store.sliceActiveIpWindow("list.example.com", 0, 10);
    assert.equal(win?.total, 3);
    assert.equal(win?.rows.length, 3);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
