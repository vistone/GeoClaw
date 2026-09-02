# 变更日志

本文件记录 GeoClaw 每个版本的变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/) 的 **补丁位递增** 策略（见 `DEVELOPMENT.md` §9）。

## [未发布]

（尚无条目。）

## [0.0.18] - 2026-09-02

### 新增

- `pickFairHotIp`：按 `assignCount` 均摊选路，同次数优先久未用的热连接
- `HotFetchTimeoutError`：下载超时保留热连接；任务回队且不消耗 `attempts`
- 预热 EOF/超时进入待预热队列，避免误踢热池
- `IpFetchStatsStore`：按域名持久化全量 IP 请求统计；地图「重置统计」清 YAML + `assignCount` + IndexedDB
- 飞行地图：WS Worker / IP Stats Worker；全量经 HTTP→IndexedDB，WS 只推摘要与增量
- `warmPool.idleExpireMs`、`flightMap.stressTotal`（默认约 `max(hotCount*2, concurrency*2)`）

### 变更

- 下载超时默认 `timeoutMs: 2000`；超时不踢热池、空闲保活不踢
- 热池 `runPool` / 压测与预热路径用 `setImmediate` 让出事件循环
- 无 HTTP 状态码时记录真实 `error`，不再仅因缺状态码踢池
- `ipinfo.token` 默认 `null`，勿提交密钥；用环境变量 `IPINFO_TOKEN`

## [0.0.17] - 2026-09-02

### 新增

- MapLibre 飞行路线可视化：`npm run flight:map` → http://127.0.0.1:8765
- `flightPathsToGeoJsonCollection`：航线 + 航点 GeoJSON
- `flightMap` 配置段（端口、样式 URL、轮询间隔）

## [0.0.16] - 2026-09-02

### 新增

- `IpInfoClient` / `FetchRouteResolver`：经 ipinfo.io 自动解析出口 IP 作为 origin
- system DNS 路径下经 ipinfo 解析目标 IP/域名坐标
- `ipinfo` 配置段；`fetchRoute.originMode: ipinfo`（默认）

### 变更

- 移除硬编码 `fetchRoute.origin` 坐标；origin 由出口 IP + ipinfo 动态获取
- 环境变量 `IPINFO_TOKEN` 可覆盖 YAML 中的 token

## [0.0.15] - 2026-09-02

### 新增

- `HostPinRegistry`：fetch 域名自动查找 `config/{hostname}.yaml`，无文件则系统 DNS
- `FetchFlightPath`：飞行路线（origin → proxy → target 航点 + 航段耗时），可转 GeoJSON LineString 供地图绘制
- `fetchRoute.origin` / `proxy.geo` 配置客户端与代理坐标
- `WebFetchResult.flightPath` 与 `FetchMetrics.recentFlightPaths`

## [0.0.14] - 2026-09-02

### 新增

- `FetchMetrics`：统一管理 fetch 请求量、成功率、失败码、IP、地区、耗时
- `IpGeoRegistry`：从 kh.google.com.yaml 解析 IP 所属 city/region/country
- `fetchMetrics` 配置段与 `npm run fetch:stats` 快照脚本
- `WebFetch.getFetchMetrics()` 获取指标实例

### 变更

- `HostPinRecord` / `parseKhGoogleYaml` 解析完整 geo 字段
- `FetchTaskPool` 每次尝试与最终请求结果写入指标

## [0.0.13] - 2026-09-02

### 新增

- `HotConnectionPool.startInitialWarmup()`：后台异步首轮预热，HTTP 200 即时入热池
- `HotConnectionPool.waitInitialWarmup()` / `isInitialWarmupInProgress()`：可选等待与进度查询
- `warmPool.autoStartWarmup`：创建池后自动后台预热（默认 true）

### 变更

- 预热不再阻塞主流程；`runInitialWarmup()` 改为 start + wait 组合（兼容旧脚本 `--wait`）
- `warm:kh-ips` 默认保持进程运行并实时打印 hot 计数

## [0.0.12] - 2026-09-02

### 新增

- `ColdConnectionPool`：下载中 403/429 入冷池，禁止参与下载直至预热 HTTP 200
- `warmPool.coldPoolStatuses` 配置项

### 变更

- `HotConnectionPool.fetchOnce` 遇 403/429 立即 `evictToColdPool`，仅后台预热成功可回热池
- 后台重加热优先处理冷池到期 IP

## [0.0.11] - 2026-09-02

### 新增

- `FetchTaskPool`：非 200 单次尝试后立即回队，worker 不阻塞、不在同一调用内换 IP 重试
- `HotConnectionPool.fetchOnce`：单 IP 单试；非 200 快速丢弃响应体并移出热池
- `warmPool.taskConcurrency` / `maxTaskAttempts` 配置项

### 变更

- 热路径 fetch 经 `FetchTaskPool.submit()` 异步重试，403/429/传输失败仅回队不等待
- 冷路径非 2xx 同样不读满 body，立即抛错

## [0.0.10] - 2026-09-02

### 新增

- `HotConnectionPool`：每 IP 一个 `node-wreq createClient`，HTTP 200 入热池，403/429 拒绝并后台重加热
- `npm run warm:kh-ips`：首轮预热 + 可选 `--daemon` 后台重试
- `config/geoclaw.yaml` 的 `warmPool` 段（并发、退避、拒绝状态码等）
- `WebFetch` 优先经热池发请求（复用 HTTP/2 连接）

### 变更

- `resolveProxyUrl` 移至 `fetch/FetchTypes.ts`
- `warmPool.fallbackToHostPin: false` 时无热连接则拒绝冷 HostPin 回退

## [0.0.9] - 2026-09-02

### 新增

- `config/geoclaw.yaml`：集中配置 log、rocktree、fetch、tls、proxy、hostPin、benchmark
- `GeoClawConfig` 单例加载 YAML；`GEOCLAW_CONFIG` 可指定路径
- `createHostPinPoolFromConfig`、`getWebFetch`、`getRocktreeApi`

### 变更

- **禁止代码硬编码可调参数**；`WebFetch` / `RocktreeApi` / `TlsFingerprintCodec` / `HostPinPool` 默认均读 YAML
- `kh.google.com.yaml` 移至 `config/`；`build` 复制整个 `config/` 到 `dist/`
- 移除 `DEFAULT_*`、`EARTH_WEB_CONTEXT_HEADERS`、`khGoogleHostPinPool` 等代码内常量
- 日志级别改由 `log.level` 配置（替代 `GEOCLAW_LOG_LEVEL` 作为主路径）

### 移除

- 导出：`DEFAULT_GEOCLAW_PROXY`、`DEFAULT_TLS_FINGERPRINT`、`DEFAULT_ROCKTREE_BASE`、`EARTH_WEB_CONTEXT_HEADERS`、`khGoogleHostPinPool`

## [0.0.8] - 2026-09-02

### 新增

- SOCKS5 代理：`DEFAULT_GEOCLAW_PROXY`（默认 `socks5://127.0.0.1:20170`）
- `proxyMode: auto` — IPv6 HostPin 走代理，IPv4 直连
- `resolveProxyUrl`、`WebFetch.resolveProxy`；trace 增加 `proxy` 字段

### 变更

- `benchmark:kh-ips` 默认启用 SOCKS5（`--no-proxy` 可关闭）

### 修复

- IPv6 HostPin 在无本地 IPv6 出口时可通过 SOCKS5 访问

## [0.0.7] - 2026-09-02

### 新增

- `npm run benchmark:kh-ips`：对 YAML 中每个 IP 探测 PlanetoidMetadata 并输出 JSONL 测速明细

### 变更

- （无）

## [0.0.6] - 2026-09-02

### 新增

- `HostPinPool`：从 `src/fetch/kh.google.com.yaml` 加载全球 IPv4/IPv6，轮询 `dns.hosts` 直连（跳过 DNS）
- `WebFetch` 默认对 `kh.google.com` 启用 HostPin；trace 增加 `pinnedIp`、`dnsPinned`
- `test/host-pin-pool.test.ts`：轮询与 YAML 解析测试

### 变更

- `npm run build` 复制 `kh.google.com.yaml` 至 `dist/fetch/`

### 修复

- （无）

### 移除

- （无）

## [0.0.5] - 2026-09-02

### 新增

- `WebFetch.getBytesWithTrace` 与 `FetchTransportTrace`：可观测 TLS profile、HTTP/2 配置、TLS 证书与耗时
- `npm run inspect:fetch` 传输层诊断脚本
- `test/web-fetch-transport-live.test.ts` 线上传输断言

### 变更

- （无）

### 修复

- （无）

### 移除

- （无）

## [0.0.4] - 2026-09-02

### 新增

- `README.md`：项目介绍、安装、TLS 指纹与 Rocktree API 用法

### 变更

- （无）

### 修复

- （无）

### 移除

- （无）

## [0.0.3] - 2026-09-02

### 新增

- `TlsFingerprintCodec`：基于 `node-wreq` 的 TLS/JA3/JA4/HTTP2 浏览器 profile（100+ 内置 profile）
- `WebFetch` 默认使用 node-wreq 原生传输层，而非 Node 内置 `fetch`

### 变更

- 移除 `header-generator` 与 `BrowserFingerprintCodec`（仅 HTTP 头，非 TLS 指纹）
- Node 引擎要求提升至 `>=20`（node-wreq 依赖）

### 修复

- （无）

### 移除

- `BrowserFingerprintCodec.ts`、`header-generator` 依赖

## [0.0.2] - 2026-09-02

### 新增

- `fetch/` 层：`WebFetch`（通用 GET 字节拉取）与 `BrowserFingerprintCodec`（header-generator 浏览器指纹）
- `RocktreeApi`：Rocktree 业务编排，HTTP 委托 `WebFetch`
- 可配置 `fingerprint`、`contextHeaders`、`headerOverrides` 与单次请求 `headers`
- `test/web-fetch.test.ts`：指纹与 header 覆盖单元测试

### 变更

- 移除 `RocktreeClient`；`RocktreeClient` / `rocktreeClient` / `createRocktreeClient` 保留为 `@deprecated` 别名

### 修复

- （无）

### 移除

- `src/client/RocktreeClient.ts`（职责拆分为 `fetch/WebFetch` + `client/RocktreeApi`）

## [0.0.1] - 2026-09-02

### 新增

- RockTree / GlobeTrotter Protobuf 编解码（`buf generate` + `@bufbuild/protobuf`）
- 单文件单类对象架构：`codec/`、`bulk/`、`client/`、`core/Logger`
- `RocktreeClient`：拉取 PlanetoidMetadata、BulkMetadata、BulkData
- Bulk 解析对齐 earth-3d：`BulkData`（nodes=120、octants=124、bulks=88）
- 节点 flags 解码、`bulkEpoch` / `epoch` / `imageryEpoch` 命名约定
- OBB、LatLonBox、纹理元数据解析
- 开发规范 `DEVELOPMENT.md` 与 Cursor 规则
- 单元测试与 kh.google.com 线上集成测试

### 变更

- （初始版本，无）

### 修复

- （初始版本，无）

### 移除

- （初始版本，无）
