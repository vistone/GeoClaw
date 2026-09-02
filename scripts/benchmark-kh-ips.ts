#!/usr/bin/env tsx
/**
 * 对 kh.google.com.yaml 中每个 IP 探测 PlanetoidMetadata 耗时。
 *
 * 用法：
 *   npm run benchmark:kh-ips
 *   npm run benchmark:kh-ips -- --concurrency 30 --family ipv4
 *   npm run benchmark:kh-ips -- --limit 50
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fetch } from "node-wreq";

import {
  DEFAULT_GEOCLAW_PROXY,
  DEFAULT_TLS_FINGERPRINT,
  EARTH_WEB_CONTEXT_HEADERS,
  parseKhGoogleYaml,
  resolveProxyUrl,
  type ProxyMode,
} from "../src/index.js";

const TARGET_URL = "https://kh.google.com/rt/earth/PlanetoidMetadata";
const HOSTNAME = "kh.google.com";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_YAML = join(MODULE_DIR, "../src/fetch/kh.google.com.yaml");

export type KhIpBenchRow = {
  ip: string;
  family: "ipv4" | "ipv6";
  ok: boolean;
  status?: number;
  waitMs: number | null;
  totalMs: number;
  bodyBytes?: number;
  error?: string;
};

type CliOptions = {
  yamlPath: string;
  concurrency: number;
  timeoutMs: number;
  family: "all" | "ipv4" | "ipv6";
  limit: number | null;
  outDir: string;
  proxy?: string;
  proxyMode: ProxyMode;
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    yamlPath: DEFAULT_YAML,
    concurrency: 20,
    timeoutMs: 20_000,
    family: "all",
    limit: null,
    outDir: join(process.cwd(), "benchmark"),
    proxy: DEFAULT_GEOCLAW_PROXY,
    proxyMode: "auto",
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--yaml" && argv[i + 1]) opts.yamlPath = argv[++i]!;
    else if (a === "--concurrency" && argv[i + 1]) opts.concurrency = Number(argv[++i]!);
    else if (a === "--timeout" && argv[i + 1]) opts.timeoutMs = Number(argv[++i]!);
    else if (a === "--family" && argv[i + 1]) opts.family = argv[++i]! as CliOptions["family"];
    else if (a === "--limit" && argv[i + 1]) opts.limit = Number(argv[++i]!);
    else if (a === "--out" && argv[i + 1]) opts.outDir = argv[++i]!;
    else if (a === "--proxy" && argv[i + 1]) opts.proxy = argv[++i]!;
    else if (a === "--no-proxy") opts.proxy = undefined;
    else if (a === "--proxy-mode" && argv[i + 1]) opts.proxyMode = argv[++i]! as ProxyMode;
  }

  return opts;
}

async function probeIp(
  record: { ip: string; family: "ipv4" | "ipv6" },
  timeoutMs: number,
  proxy?: string,
  proxyMode: ProxyMode = "auto",
): Promise<KhIpBenchRow> {
  const started = Date.now();
  const proxyUrl = resolveProxyUrl({ pinnedIp: record.ip, proxyMode, proxyUrl: proxy });
  try {
    const res = await fetch(TARGET_URL, {
      method: "GET",
      browser: DEFAULT_TLS_FINGERPRINT,
      headers: {
        ...EARTH_WEB_CONTEXT_HEADERS,
        "Accept-Encoding": "identity",
      },
      dns: {
        hosts: {
          [HOSTNAME]: [record.ip],
        },
      },
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
      timeout: timeoutMs,
    });

    const waitMs = res.wreq.timings?.wait ?? null;
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      return {
        ip: record.ip,
        family: record.family,
        ok: false,
        status: res.status,
        waitMs,
        totalMs: Date.now() - started,
        error: `${res.status} ${res.statusText}`,
      };
    }

    const body = await res.arrayBuffer();
    return {
      ip: record.ip,
      family: record.family,
      ok: true,
      status: res.status,
      waitMs,
      totalMs: Date.now() - started,
      bodyBytes: body.byteLength,
    };
  } catch (err) {
    return {
      ip: record.ip,
      family: record.family,
      ok: false,
      waitMs: null,
      totalMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function loop() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => loop()));
  return results;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx]!;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const yamlText = readFileSync(opts.yamlPath, "utf8");
  const parsed = parseKhGoogleYaml(yamlText);
  let records =
    opts.family === "ipv4" ? parsed.ipv4 : opts.family === "ipv6" ? parsed.ipv6 : parsed.all;

  if (opts.limit !== null && opts.limit > 0) {
    records = records.slice(0, opts.limit);
  }

  mkdirSync(opts.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonlPath = join(opts.outDir, `kh-planetoid-ips-${stamp}.jsonl`);
  const summaryPath = join(opts.outDir, `kh-planetoid-ips-${stamp}-summary.json`);

  writeFileSync(jsonlPath, "");

  console.log("=== kh.google.com PlanetoidMetadata IP 测速 ===");
  console.log("URL:", TARGET_URL);
  console.log("IP 数量:", records.length);
  console.log("并发:", opts.concurrency);
  console.log("超时(ms):", opts.timeoutMs);
  console.log("代理:", opts.proxy ?? "(无)");
  console.log("代理策略:", opts.proxyMode);
  console.log("结果:", jsonlPath);
  console.log("");

  const startedAll = Date.now();
  let done = 0;
  let okCount = 0;
  let failCount = 0;

  const rows = await runPool(records, opts.concurrency, async (record, index) => {
    const row = await probeIp(record, opts.timeoutMs, opts.proxy, opts.proxyMode);
    appendFileSync(jsonlPath, `${JSON.stringify(row)}\n`);
    done++;
    if (row.ok) okCount++;
    else failCount++;

    if (done % 25 === 0 || done === records.length) {
      const elapsed = ((Date.now() - startedAll) / 1000).toFixed(1);
      console.log(`[${done}/${records.length}] ok=${okCount} fail=${failCount} elapsed=${elapsed}s`);
    }

    if (index === 0) {
      console.log(`首条样本 ip=${row.ip} ok=${row.ok} waitMs=${row.waitMs} totalMs=${row.totalMs}`);
    }

    return row;
  });

  const okRows = rows.filter((r) => r.ok && r.waitMs !== null);
  const waits = okRows.map((r) => r.waitMs!).sort((a, b) => a - b);
  const totals = okRows.map((r) => r.totalMs).sort((a, b) => a - b);

  const fastest = [...okRows].sort((a, b) => a.waitMs! - b.waitMs!).slice(0, 30);
  const slowest = [...okRows].sort((a, b) => b.waitMs! - a.waitMs!).slice(0, 30);

  const summary = {
    targetUrl: TARGET_URL,
    total: rows.length,
    ok: okCount,
    fail: failCount,
    elapsedMs: Date.now() - startedAll,
    waitMs: waits.length
      ? {
          min: waits[0],
          p50: percentile(waits, 0.5),
          p90: percentile(waits, 0.9),
          p99: percentile(waits, 0.99),
          max: waits[waits.length - 1],
          avg: Math.round(waits.reduce((a, b) => a + b, 0) / waits.length),
        }
      : null,
    totalMs: totals.length
      ? {
          min: totals[0],
          p50: percentile(totals, 0.5),
          p90: percentile(totals, 0.9),
          max: totals[totals.length - 1],
        }
      : null,
    fastestByWaitMs: fastest.map((r) => ({
      ip: r.ip,
      family: r.family,
      waitMs: r.waitMs,
      totalMs: r.totalMs,
    })),
    slowestByWaitMs: slowest.map((r) => ({
      ip: r.ip,
      family: r.family,
      waitMs: r.waitMs,
      totalMs: r.totalMs,
    })),
    jsonlPath,
  };

  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log("");
  console.log("=== 汇总 ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("");
  console.log("明细 JSONL:", jsonlPath);
  console.log("汇总 JSON:", summaryPath);
}

await main();
