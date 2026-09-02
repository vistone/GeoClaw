#!/usr/bin/env tsx
/**
 * 查看按域名分文件的每 IP 请求统计 YAML。
 *
 * 用法：
 *   npm run fetch:stats
 *   npm run fetch:stats -- kh.google.com
 *   npm run fetch:stats -- --json
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { GeoClawConfig } from "../src/core/GeoClawConfig.js";
import type { IpFetchStatsFile } from "../src/fetch/IpFetchStatsStore.js";
import { normalizeHostname } from "../src/fetch/IpFetchStatsStore.js";

const asJson = process.argv.includes("--json");
const hostArg = process.argv.slice(2).find((a) => !a.startsWith("-"));

const cfg = GeoClawConfig.get();
const opts = cfg.getFetchMetricsOptions();
const statsDir = opts.ipStatsDir ? GeoClawConfig.resolvePath(opts.ipStatsDir) : null;

if (!statsDir || !existsSync(statsDir)) {
  console.error("IP 统计目录不存在:", statsDir ?? "(未配置 fetchMetrics.ipStatsDir)");
  console.error("先运行 flight:map / 业务 fetch，等待自动刷盘后再查看。");
  process.exit(1);
}

const files = readdirSync(statsDir).filter((n) => /\.ya?ml$/i.test(n));
if (files.length === 0) {
  console.error("目录为空:", statsDir);
  process.exit(1);
}

const wanted = hostArg ? normalizeHostname(hostArg) : null;
const targets = wanted
  ? files.filter((n) => normalizeHostname(n.replace(/\.ya?ml$/i, "")) === wanted)
  : files;

if (targets.length === 0) {
  console.error("未找到域名统计:", wanted, "可用:", files.join(", "));
  process.exit(1);
}

function printDoc(filePath: string, doc: IpFetchStatsFile) {
  const entries = Object.entries(doc.ips ?? {});
  const active = entries.filter(([, r]) => (r.requests ?? 0) > 0);
  active.sort((a, b) => (b[1].requests ?? 0) - (a[1].requests ?? 0));

  const totalBytes = active.reduce((s, [, r]) => s + (r.totalBytes ?? 0), 0);
  const totalReq = active.reduce((s, [, r]) => s + (r.requests ?? 0), 0);
  const totalOk = active.reduce((s, [, r]) => s + (r.success ?? 0), 0);
  const totalFail = active.reduce((s, [, r]) => s + (r.failed ?? 0), 0);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          file: filePath,
          hostname: doc.hostname,
          updatedAt: doc.updatedAt,
          totalIps: entries.length,
          activeIps: active.length,
          totalRequests: totalReq,
          totalSuccess: totalOk,
          totalFailed: totalFail,
          totalBytes,
          top: active.slice(0, 100).map(([ip, r]) => ({ ip, ...r })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("=== IP 请求统计 ===");
  console.log("域名:", doc.hostname ?? "?");
  console.log("文件:", filePath);
  console.log("更新:", doc.updatedAt);
  console.log("IP 条目:", entries.length, "· 有请求:", active.length);
  console.log("合计: req=", totalReq, "ok=", totalOk, "fail=", totalFail, "bytes=", totalBytes);
  console.log("Top 30（按请求次数）:");
  for (const [ip, r] of active.slice(0, 30)) {
    console.log(
      `  ${ip}  req=${r.requests} ok=${r.success} fail=${r.failed} bytes=${r.totalBytes} avgMs=${r.avgDurationMs ?? 0} ${r.city ?? ""} ${r.country ?? ""}`,
    );
  }
}

for (const name of targets.sort()) {
  const filePath = join(statsDir, name);
  const doc = parseYaml(readFileSync(filePath, "utf8")) as IpFetchStatsFile;
  printDoc(filePath, doc);
  if (!asJson && targets.length > 1) console.log("");
}
