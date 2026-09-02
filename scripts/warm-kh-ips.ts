#!/usr/bin/env tsx
/**
 * 预热 kh.google.com 热连接池：仅 HTTP 200 入池；403/429 后台重试直至 200。
 *
 * 用法：
 *   npm run warm:kh-ips
 *   npm run warm:kh-ips -- --daemon
 *   npm run warm:kh-ips -- --limit 100
 */

import { GeoClawConfig } from "../src/core/GeoClawConfig.js";
import { createWebFetch } from "../src/index.js";

const daemon = process.argv.includes("--daemon");
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

const summary = await pool.runInitialWarmup();
console.log("首轮结果:", summary);
console.log("当前热池:", pool.getStats());

pool.startBackgroundReheat();
console.log("");
console.log("后台重加热已启动（403/429/失败 IP 直至 HTTP 200 入池）");

if (daemon) {
  console.log("守护模式：每 30s 打印统计，Ctrl+C 退出");
  setInterval(() => {
    console.log("[stats]", pool.getStats());
  }, 30_000);
} else {
  console.log("提示：加 --daemon 保持进程与后台重加热运行");
  pool.stopBackgroundReheat();
  pool.close();
}
