# 变更日志

本文件记录 GeoClaw 每个版本的变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/) 的 **补丁位递增** 策略（见 `DEVELOPMENT.md` §9）。

## [未发布]

（尚无条目。）

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
