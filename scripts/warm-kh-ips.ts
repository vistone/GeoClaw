#!/usr/bin/env tsx
/**
 * 预热 kh.google.com 热连接池：后台异步预热，HTTP 200 即入热池。
 *
 * 用法：
 *   npm run warm:kh-ips
 *   npm run warm:kh-ips -- --wait
 *   npm run warm:kh-ips -- --limit 100
 */

import { GeoClawConfig } from "../src/core/GeoClawConfig.js";
import { createWebFetch } from "../src/index.js";

const waitAll = process.argv.includes("--wait");
const limitArg = process.argv.find((a, i) => a === "--limit" && process.argv[i + 1]);
const limit = limitArg ? Number(process.argv[process.argv.indexOf("--limit") + 1]) : null;

const wf = createWebFetch();
const pool = wf.getHotConnectionPool();

if (!pool) {
  console.error("warmPool.enabled 未开启，请在 config/geoclaw.yaml 设置 warmPool.enabled: true");
  process.exit(1);
}

if (limit !== null && limit > 0) {
  const stats = pool.getStats();
  console.log(`--limit 仅裁剪首轮规模（当前池已加载 ${stats.total} IP，请在 ipsFile 或 hostPin 段控制）`);
}

console.log("=== GeoClaw 热连接预热 ===");
console.log("配置:", GeoClawConfig.get().getConfigPath());
console.log("预热 URL:", GeoClawConfig.get().getPlanetoidMetadataUrl());
console.log("IP 数量:", pool.getStats().total);
console.log("");

pool.startInitialWarmup();
pool.startBackgroundReheat();

console.log("后台预热已启动：HTTP 200 的 IP 即时入热池，无需全部完成");
console.log("当前热池:", pool.getStats());
console.log("冷池 IP 数:", pool.getColdCount());
console.log("");

const statsInterval = setInterval(() => {
  const s = pool.getStats();
  console.log(
    `[stats] hot=${s.hot} pending=${s.pending} warming=${s.warming} cold=${s.cold} initial=${s.initialWarmupInProgress}`,
  );
}, 10_000);

const shutdown = () => {
  clearInterval(statsInterval);
  pool.stopBackgroundReheat();
  pool.close();
  process.exit(0);
};

if (waitAll) {
  const summary = await pool.waitInitialWarmup();
  clearInterval(statsInterval);
  console.log("首轮全部完成:", summary);
  console.log("当前热池:", pool.getStats());
  shutdown();
}

console.log("保持进程运行；Ctrl+C 退出");
console.log("提示：--wait 阻塞至全部 IP 首轮预热结束");
process.on("SIGINT", shutdown);
