#!/usr/bin/env tsx
/**
 * 诊断 WebFetch 实际使用的传输协议栈。
 *
 * 用法：
 *   npm run inspect:fetch
 *   npm run inspect:fetch -- https://kh.google.com/rt/earth/PlanetoidMetadata
 *   GEOCLAW_LOG_LEVEL=debug npm run inspect:fetch
 */

import { createWebFetch, DEFAULT_TLS_FINGERPRINT } from "../src/index.js";

const url = process.argv[2] ?? "https://kh.google.com/rt/earth/PlanetoidMetadata";

const fetch = createWebFetch({ logTransportTrace: true });

console.log("=== GeoClaw WebFetch 传输诊断 ===");
console.log("URL:", url);
console.log("默认 TLS profile:", DEFAULT_TLS_FINGERPRINT);
console.log("");

const { bytes, trace } = await fetch.getBytesWithTrace(url, { trace: true });

console.log("--- 协议栈摘要 ---");
console.log("传输实现:", trace.transport);
console.log("browser profile:", trace.browser);
console.log("TLS ClientHello 指纹 (JA3/JA4): 由 profile 在 node-wreq 原生层模拟");
console.log("HTTP/2 指纹已配置:", trace.http2FingerprintEnabled);
console.log("profile 默认头已配置:", trace.profileHeadersEnabled);
console.log("GeoClaw 附加头:", trace.extraHeaders);
console.log("");
console.log("--- 响应 ---");
console.log("HTTP 状态:", trace.status, trace.statusText);
console.log("响应体字节:", bytes.length);
console.log("首字节等待 (ms):", trace.timings?.wait);
console.log("响应头像 HTTP/2 (启发式):", trace.likelyHttp2Response);
console.log("TLS 对端证书:", trace.tlsPeer);
console.log("");
console.log("响应头:", trace.responseHeaders);
console.log("");
console.log("完整 trace JSON:");
console.log(JSON.stringify(trace, null, 2));
