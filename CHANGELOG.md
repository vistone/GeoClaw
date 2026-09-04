# 变更日志

本文件记录 GeoClaw 每个版本的变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/) 的 **补丁位递增** 策略（见 `DEVELOPMENT.md` §9）。

## [未发布]

## [0.0.22] - 2026-09-04

### 新增

- 本地国旗资源 `viz/flight-map/vendor/flags/w20`（306 国）；飞行地图不再请求 flagcdn
- `fetchExport`：进站成功后原样 PUT 存档（独立 url/headers，与进站 fetch 分离）；`FetchExportSink`
- IP 统计：请求瞬时/平均 RPS + 心跳波峰图（与网卡采样同节拍，对照下行波峰）
- 测试脚本 `npm run stress:hot` + 配置段 `stressTest`（经 `flight:map` 的 `/api/stress` 驱动地图；主页无测试 UI）

### 变更

- `config/ip-stats/<域名>.yaml` 不存在时：启动扫描 `config/<域名>.yaml`（HostPin）建立零计数统计素材并立即落盘；首次访问同逻辑
- IP 请求统计表格窗口列出全部种子 IP（零请求也显示，有请求排前）；国旗条按全部 IP 汇总国家
- 热池运维与业务下载并发拆开：`warmPool.concurrency` / `warmPool.taskConcurrency`
- 热池暂时为空时 `WebFetch` 走任务池回队；`fetch.timeoutMs` 默认 15000
- 飞行地图主页去掉「测试工具」区块；压测默认 concurrency=64 高频补位；软公平 `warmSlack` 复用热连接 + 8% 全池探索（不闲置慢 IP）
- 压测脉冲改为 `pulseStreamMs`（默认 16ms）连续冲刷，不再同 tick 合批跳频；已点亮线路只续命换色
- 下载非 200：仅 403/429 入冷池；其余状态保留热连接并立即回队（`setImmediate`），不踢池、不同步重试占主线程
- WS：客户端 `bufferedAmount` 超 `wsMaxBufferedBytes` 时丢弃本帧脉冲；Worker 合并 pulse/status 只保留最新，约 16ms 刷一次主线程

## [0.0.21] - 2026-09-04

### 新增

- 飞行地图：按落点坐标预绘灰色骨架（同坐标一条线）；请求点亮为 IP 色，超时淡回灰
- 飞行地图：国别国旗条、网卡流量（`nicIface` / `nicSampleMs`）、侧栏 IP 滚动窗口与国别筛选
- `IpFetchStatsStore.listOrderedActiveIps` / `sliceActiveIpWindow` / `byCountry`；导出 `normalizeCountryCode` / `normalizeCountryFilter`
- `FetchMetrics.getRecentFlightPaths()`：脉冲 drain 不再全量 `getSnapshot`

### 变更

- `routeHoldMs` 默认 16000、`routeFadeMs` 默认 4000；`stressTotal` 配置可至 100000
- 压测脉冲按落点去重推送；去掉 IP 窗口硬封顶 200、网卡采样硬下限 200ms
- 文案与启动规则对齐「骨架预绘 + 请求点亮」，去掉过时的「不画满热池」

## [0.0.20] - 2026-09-03

### 新增

- 启动时加载项目根 `.env`（`loadDotEnv`）；`IPINFO_TOKEN` / `BING_MAPS_KEY` 可放本地虚拟环境文件，不进仓库
- `.env.example` 模板；`.gitignore` 忽略 `.env`

## [0.0.19] - 2026-09-03

### 变更

- 去掉主动限制：WS IP 统计增量不再 `MAX_DELTA` 封顶；摘要日志不再 TopN=5；WS 全量用 `includeRows=false` 而非 `topN=1` 凑合
- 热池并发收口为单一 `warmPool.concurrency`（细分项仅作可选覆盖）；默认 `backoffMs: 0`
- `HotConnectionPool.fetchOnce` / `runInitialWarmup` / `close` 补 `measureAsync`/`measureSync`
- 导出 `HotFetchTimeoutError`；`ipinfo.token` 恢复为 `null`（用 `IPINFO_TOKEN`）
- 规则书新增 §10.8 / `geoclaw-no-premature-limits.mdc`：未点名不加限制

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
