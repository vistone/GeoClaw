# 真实测试数据（Fixture）

本目录存放从 **Google Earth Rocktree 线上** 捕获的真实字节与元数据。  
**禁止** 手写编造 protobuf 作为领域测试依据（见 `DEVELOPMENT.md` §7）。

## 目录结构

```
test/fixtures/
  README.md           # 本文件
  manifest.json       # 每条 fixture 的来源与用途
  planetoid/          # PlanetoidMetadata 原始响应
  bulk/               # BulkMetadata 原始响应（按 path + bulkEpoch）
  nodes/              # 可选：单节点 NodeMetadata 切片 JSON
```

## manifest.json 格式

每条记录必须可追溯：

```json
{
  "id": "root-bulk-1014",
  "kind": "BulkMetadata",
  "capturedAt": "2026-09-02",
  "source": {
    "url": "https://kh.google.com/rt/earth/BulkMetadata/pb=!1m2!1s!2u1014",
    "path": "",
    "bulkEpoch": 1014
  },
  "files": {
    "raw": "bulk/root-bulk-1014.bin",
    "gzip": true
  },
  "notes": "根 Bulk；期望 nodes=120 octants=124 bulks=88"
}
```

## 如何捕获

```bash
# 需能访问 kh.google.com
GEOCLAW_LOG_LEVEL=debug npm run fetch:planetoid
GEOCLAW_LOG_LEVEL=debug npm run fetch:bulk
```

将脚本输出的 JSON 摘要与原始 HTTP 响应字节写入本目录，并 **更新 manifest.json**。

捕获原始字节的推荐步骤：

1. 用 `RocktreeApi` / `WebFetch` 或 `fetch` 拉取响应 `ArrayBuffer`
2. 原样保存为 `.bin`（gzip 响应保存 gzip 字节，测试中用 `gunzipIfNeeded`）
3. 在 manifest 中记录 URL、epoch、捕获日期

## 编写 Fixture 测试

```typescript
// test/bulk-root.fixture.test.ts
// 数据来源：test/fixtures/manifest.json → root-bulk-1014
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeBulkMetadata, parseBulkData } from "../src/index.js";

test("parseBulkData on captured root bulk", () => {
  const bin = fs.readFileSync(
    path.join(import.meta.dirname, "fixtures/bulk/root-bulk-1014.bin"),
  );
  const bulk = parseBulkData(decodeBulkMetadata(bin));
  assert.equal(bulk.nodes.size, 120);
});
```

## 无数据时

**不要猜测期望值。** 请：

1. 运行上述 fetch 脚本，或  
2. 向项目维护者索要对应 path / epoch 的 `.bin` 样本  

待 fixture 落盘后再编写或合并测试。
