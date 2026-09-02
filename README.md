# GeoClaw

Google Earth **RockTree / GlobeTrotter** 的 Node.js TypeScript 工具库：Protobuf 编解码、Bulk 元数据解析，以及带 **TLS 浏览器指纹**（JA3/JA4/HTTP2）的 HTTP 抓取。

当前版本：**0.0.4**

## 特性

- **Protobuf 编解码**：基于 `@bufbuild/protobuf`，由 `buf generate` 生成类型
- **Bulk 解析**：对齐 earth-3d 的 `BulkData` 索引（nodes / octants / bulks）
- **节点 flags、OBB、LatLonBox、纹理元数据** 等纯内存解析模块
- **TLS 浏览器指纹**：`WebFetch` 默认使用 [node-wreq](https://www.npmjs.com/package/node-wreq) 模拟 Chrome/Firefox/Safari 的 TLS 握手与 HTTP/2 行为
- **Rocktree API**：拉取 `PlanetoidMetadata`、`BulkMetadata`、`BulkData`（`kh.google.com`）
- **分层架构**：`core` → `codec` → `bulk` → `fetch` → `client`，模块可独立测试

## 环境要求

- **Node.js >= 20**
- 网络（线上集成测试与 `fetch:*` 脚本需访问 `kh.google.com`）

## 安装

```bash
git clone https://github.com/vistone/GeoClaw.git
cd GeoClaw
npm install
npm run build
```

## 快速开始

### 拉取 PlanetoidMetadata

```typescript
import { fetchPlanetoidMetadata } from "geoclaw";

const meta = await fetchPlanetoidMetadata();
console.log(meta.radius, meta.rootNodeMetadata?.epoch);
```

### 拉取并解析根 Bulk

```typescript
import { fetchBulkData } from "geoclaw";

const bulk = await fetchBulkData({ path: "", bulkEpoch: 1014 });
console.log(bulk.nodes.length, bulk.octants.length, bulk.bulks.length);
```

### 命令行脚本

```bash
npm run fetch:planetoid
npm run fetch:bulk
```

## TLS 浏览器指纹（WebFetch）

Node 内置 `fetch` 使用 OpenSSL，**无法**伪造 JA3/JA4/HTTP2 指纹。GeoClaw 的 `WebFetch` 默认走 **node-wreq** 原生传输层。

```typescript
import {
  createWebFetch,
  BROWSER_TLS_PROFILES,
  EARTH_WEB_CONTEXT_HEADERS,
} from "geoclaw";

const fetch = createWebFetch({
  // TLS profile：100+ 内置，如 chrome_128、firefox_135
  tlsFingerprint: {
    profile: "chrome_131",
    platform: "linux",
    http2: true,
    headers: true,
  },
  contextHeaders: EARTH_WEB_CONTEXT_HEADERS,
  headerOverrides: {
    "Accept-Language": "zh-CN,zh",
  },
});

const bytes = await fetch.getBytes("https://example.com/data");
console.log(BROWSER_TLS_PROFILES.includes("chrome_131"));
```

Header 合并优先级：**node-wreq profile 默认头 → contextHeaders → headerOverrides → 单次 headers**。Protobuf 响应默认强制 `Accept-Encoding: identity`。

## Rocktree API

```typescript
import { createRocktreeApi } from "geoclaw";

const api = createRocktreeApi({
  tlsFingerprint: "chrome_128",
  headerOverrides: { "X-Custom": "demo" },
});

const planetoid = await api.fetchPlanetoidMetadata();
const bulk = await api.fetchBulkData({
  path: "",
  bulkEpoch: planetoid.rootNodeMetadata!.epoch,
});
```

`RocktreeClient` / `rocktreeClient` 仍作为 `@deprecated` 别名保留，请改用 `RocktreeApi`。

## 仅内存解析（无 HTTP）

```typescript
import { decodeBulkMetadata, parseBulkData } from "geoclaw";
import fs from "node:fs";

const bytes = fs.readFileSync("bulk.bin");
const meta = decodeBulkMetadata(bytes);
const data = parseBulkData(meta);
```

## 项目结构

```
src/
  gen/      # buf 生成的 rocktree_pb.ts
  core/     # Logger、BytesLike
  codec/    # gzip、Protobuf、URL、path、flags
  bulk/     # BulkData、OBB、LatLonBox 等
  fetch/    # WebFetch、TlsFingerprintCodec
  client/   # RocktreeApi
  index.ts  # 对外门面
```

详细规范见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

## 开发

```bash
npm run typecheck    # TypeScript 检查
npm test             # 单元测试 + kh.google.com 集成测试
npm run jsdoc:check  # JSDoc 校验
npm run jsdoc:md     # 导出 docs/API.md
```

API 文档：[docs/API.md](./docs/API.md)  
变更记录：[CHANGELOG.md](./CHANGELOG.md)

## 许可证

私有项目（`package.json` 中 `"private": true`）。使用 Google Earth 数据时请遵守 Google 相关服务条款。
