# GeoClaw API 文档（JSDoc 导出）

> 自动生成于 **2026-09-02**；请勿手改。更新 JSDoc 后运行 `npm run jsdoc:md`。
>
> 规范：[DEVELOPMENT.md](../DEVELOPMENT.md) §3 · [JSDOC.md](./JSDOC.md)

## 目录

- [L1 基础设施 core](#l1-基础设施-core)
- [L2 编解码 codec](#l2-编解码-codec)
- [L3 领域解析 bulk](#l3-领域解析-bulk)
- [L4 HTTP 抓取 fetch](#l4-http-抓取-fetch)
- [L5 Rocktree API client](#l5-rocktree-api-client)
- [模块级函数](#模块级函数)

## L1 基础设施 core

### Logger

源文件：[`src/core/Logger.ts`](../src/core/Logger.ts)

作用域日志器：每个类持有一个实例，scope 通常为类名。

#### Logger 构造函数

```typescript
constructor(scope: string, minLevel: undefined | DEBUG | INFO | …)
```

构造实例。

| 参数 | 说明 |
|------|------|
| `scope` | 输入：`string` — 日志作用域 |
| `minLevel` | 输入：`undefined \| DEBUG \| INFO \| …` — 最低日志级别 |

**返回：** 输出：`Logger` — Logger 实例

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 构造实例。
   * @param scope - 输入：`string` — 日志作用域
   * @param minLevel - 输入：`undefined | DEBUG | INFO | …` — 最低日志级别
   * @returns 输出：`Logger` — Logger 实例
   */
```

</details>

#### Logger.debug

```typescript
debug(message: string, data: unknown): void
```

输出 DEBUG 日志。

| 参数 | 说明 |
|------|------|
| `message` | 输入：`string` — 日志消息 |
| `data` | 输入：`unknown` — 附加数据 |

**返回：** 输出：无（`void`）

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 输出 DEBUG 日志。
   * @param message - 输入：`string` — 日志消息
   * @param data - 输入：`unknown` — 附加数据
   * @returns 输出：无（`void`）
   */
```

</details>

#### Logger.error

```typescript
error(message: string, err: unknown): void
```

输出 ERROR 日志。

| 参数 | 说明 |
|------|------|
| `message` | 输入：`string` — 日志消息 |
| `err` | 输入：`unknown` — 错误对象 |

**返回：** 输出：无（`void`）

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 输出 ERROR 日志。
   * @param message - 输入：`string` — 日志消息
   * @param err - 输入：`unknown` — 错误对象
   * @returns 输出：无（`void`）
   */
```

</details>

#### Logger.info

```typescript
info(message: string, data: unknown): void
```

输出 INFO 日志。

| 参数 | 说明 |
|------|------|
| `message` | 输入：`string` — 日志消息 |
| `data` | 输入：`unknown` — 附加数据 |

**返回：** 输出：无（`void`）

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 输出 INFO 日志。
   * @param message - 输入：`string` — 日志消息
   * @param data - 输入：`unknown` — 附加数据
   * @returns 输出：无（`void`）
   */
```

</details>

#### Logger.measureAsync

```typescript
measureAsync(operation: string, fn: () => Promise<T>, context: undefined | Record<string, unknown>): Promise<T>
```

DEBUG 模式下测量异步函数耗时（非 DEBUG 零开销直通）。

| 参数 | 说明 |
|------|------|
| `operation` | 输入：`string` — 操作名（通常为方法名） |
| `fn` | 输入：`() => Promise<T>` — 待测量异步函数 |
| `context` | 输入：`Record<string, unknown>` — 可选附加上下文 |

**返回：** 输出：`Promise<T>` — fn 的 Promise 结果

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * DEBUG 模式下测量异步函数耗时（非 DEBUG 零开销直通）。
   * @param operation - 输入：`string` — 操作名（通常为方法名）
   * @param fn - 输入：`() => Promise<T>` — 待测量异步函数
   * @param context - 输入：`Record<string, unknown>` — 可选附加上下文
   * @returns 输出：`Promise<T>` — fn 的 Promise 结果
   */
```

</details>

#### Logger.measureSync

```typescript
measureSync(operation: string, fn: () => T, context: undefined | Record<string, unknown>): T
```

DEBUG 模式下测量同步函数耗时（非 DEBUG 零开销直通）。

| 参数 | 说明 |
|------|------|
| `operation` | 输入：`string` — 操作名（通常为方法名） |
| `fn` | 输入：`() => T` — 待测量函数 |
| `context` | 输入：`Record<string, unknown>` — 可选附加上下文 |

**返回：** 输出：`T` — fn 的返回值

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * DEBUG 模式下测量同步函数耗时（非 DEBUG 零开销直通）。
   * @param operation - 输入：`string` — 操作名（通常为方法名）
   * @param fn - 输入：`() => T` — 待测量函数
   * @param context - 输入：`Record<string, unknown>` — 可选附加上下文
   * @returns 输出：`T` — fn 的返回值
   */
```

</details>

#### Logger.warn

```typescript
warn(message: string, data: unknown): void
```

输出 WARN 日志。

| 参数 | 说明 |
|------|------|
| `message` | 输入：`string` — 日志消息 |
| `data` | 输入：`unknown` — 附加数据 |

**返回：** 输出：无（`void`）

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 输出 WARN 日志。
   * @param message - 输入：`string` — 日志消息
   * @param data - 输入：`unknown` — 附加数据
   * @returns 输出：无（`void`）
   */
```

</details>

## L2 编解码 codec

### FlagCodec

源文件：[`src/codec/FlagCodec.ts`](../src/codec/FlagCodec.ts)

NodeMetadata.flags 位掩码解码对象。

#### FlagCodec.decode

```typescript
decode(flags: number): DecodedNodeFlags
```

解码 flags 位掩码。

| 参数 | 说明 |
|------|------|
| `flags` | 输入：`number` — NodeMetadata 标志位掩码 |

**返回：** 输出：`DecodedNodeFlags` — 各 flags 布尔字段与 names 列表

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 解码 flags 位掩码。
   * @param flags - 输入：`number` — NodeMetadata 标志位掩码
   * @returns 输出：`DecodedNodeFlags` — 各 flags 布尔字段与 names 列表
   */
```

</details>

### GzipCodec

源文件：[`src/codec/GzipCodec.ts`](../src/codec/GzipCodec.ts)

Gzip 字节编解码对象。

#### GzipCodec.gunzipIfNeeded

```typescript
gunzipIfNeeded(input: ArrayBuffer | Uint8Array | Buffer): Uint8Array
```

检测 gzip 并解压。

| 参数 | 说明 |
|------|------|
| `input` | 输入：`ArrayBuffer \| Uint8Array \| Buffer` — 原始输入 |

**返回：** 输出：`Uint8Array` — 字节数组

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 检测 gzip 并解压。
   * @param input - 输入：`ArrayBuffer | Uint8Array | Buffer` — 原始输入
   * @returns 输出：`Uint8Array` — 字节数组
   */
```

</details>

#### GzipCodec.gzipBytes

```typescript
gzipBytes(input: ArrayBuffer | Uint8Array | Buffer): Uint8Array
```

gzip 压缩字节。

| 参数 | 说明 |
|------|------|
| `input` | 输入：`ArrayBuffer \| Uint8Array \| Buffer` — 原始输入 |

**返回：** 输出：`Uint8Array` — 字节数组

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * gzip 压缩字节。
   * @param input - 输入：`ArrayBuffer | Uint8Array | Buffer` — 原始输入
   * @returns 输出：`Uint8Array` — 字节数组
   */
```

</details>

#### GzipCodec.toUint8Array

```typescript
toUint8Array(input: ArrayBuffer | Uint8Array | Buffer): Uint8Array
```

转为 Uint8Array。

| 参数 | 说明 |
|------|------|
| `input` | 输入：`ArrayBuffer \| Uint8Array \| Buffer` — 原始输入 |

**返回：** 输出：`Uint8Array` — 字节数组

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 转为 Uint8Array。
   * @param input - 输入：`ArrayBuffer | Uint8Array | Buffer` — 原始输入
   * @returns 输出：`Uint8Array` — 字节数组
   */
```

</details>

### PathCodec

源文件：[`src/codec/PathCodec.ts`](../src/codec/PathCodec.ts)

八分体 path_and_flags 编解码对象。

#### PathCodec.canHaveData

```typescript
canHaveData(flags: number): boolean
```

判断节点是否可含几何数据。

| 参数 | 说明 |
|------|------|
| `flags` | 输入：`number` — NodeMetadata 标志位掩码 |

**返回：** 输出：`boolean` — 条件成立返回 true，否则 false

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 判断节点是否可含几何数据。
   * @param flags - 输入：`number` — NodeMetadata 标志位掩码
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */
```

</details>

#### PathCodec.hasChildBulk

```typescript
hasChildBulk(relativePath: string, flags: number): boolean
```

判断相对路径是否指向子 Bulk。

| 参数 | 说明 |
|------|------|
| `relativePath` | 输入：`string` — 相对八分体路径 |
| `flags` | 输入：`number` — NodeMetadata 标志位掩码 |

**返回：** 输出：`boolean` — 条件成立返回 true，否则 false

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 判断相对路径是否指向子 Bulk。
   * @param relativePath - 输入：`string` — 相对八分体路径
   * @param flags - 输入：`number` — NodeMetadata 标志位掩码
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */
```

</details>

#### PathCodec.hasNodeData

```typescript
hasNodeData(flags: number): boolean
```

判断 flags 是否允许节点数据。

| 参数 | 说明 |
|------|------|
| `flags` | 输入：`number` — NodeMetadata 标志位掩码 |

**返回：** 输出：`boolean` — 条件成立返回 true，否则 false

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 判断 flags 是否允许节点数据。
   * @param flags - 输入：`number` — NodeMetadata 标志位掩码
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */
```

</details>

#### PathCodec.isBulkPath

```typescript
isBulkPath(absolutePath: string, flags: number): boolean
```

判断绝对路径是否为子 Bulk 节点。

| 参数 | 说明 |
|------|------|
| `absolutePath` | 输入：`string` — 绝对八分体路径 |
| `flags` | 输入：`number` — NodeMetadata 标志位掩码 |

**返回：** 输出：`boolean` — 条件成立返回 true，否则 false

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 判断绝对路径是否为子 Bulk 节点。
   * @param absolutePath - 输入：`string` — 绝对八分体路径
   * @param flags - 输入：`number` — NodeMetadata 标志位掩码
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */
```

</details>

#### PathCodec.joinOctantPath

```typescript
joinOctantPath(basePath: string, relativePath: string): string
```

拼接父路径与相对八分体段。

| 参数 | 说明 |
|------|------|
| `basePath` | 输入：`string` — 父路径前缀 |
| `relativePath` | 输入：`string` — 相对八分体路径 |

**返回：** 输出：`string` — 字符串结果

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 拼接父路径与相对八分体段。
   * @param basePath - 输入：`string` — 父路径前缀
   * @param relativePath - 输入：`string` — 相对八分体路径
   * @returns 输出：`string` — 字符串结果
   */
```

</details>

#### PathCodec.unpackPathAndFlags

```typescript
unpackPathAndFlags(pathAndFlags: number): UnpackedPathAndFlags
```

解包 path_and_flags 为路径与标志位。

| 参数 | 说明 |
|------|------|
| `pathAndFlags` | 输入：`number` — path_and_flags 打包字段 |

**返回：** 输出：`UnpackedPathAndFlags` — path、level、flags 三字段

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 解包 path_and_flags 为路径与标志位。
   * @param pathAndFlags - 输入：`number` — path_and_flags 打包字段
   * @returns 输出：`UnpackedPathAndFlags` — path、level、flags 三字段
   */
```

</details>

### PbUrlCodec

源文件：[`src/codec/PbUrlCodec.ts`](../src/codec/PbUrlCodec.ts)

Rocktree HTTP pb= 参数编码对象。

#### PbUrlCodec.bulkMetadataUrlPath

```typescript
bulkMetadataUrlPath(path: string, bulkEpoch: number): string
```

生成 BulkMetadata 相对 URL。

| 参数 | 说明 |
|------|------|
| `path` | 输入：`string` — 八分体路径 |
| `bulkEpoch` | 输入：`number` — BulkMetadata 版本号 |

**返回：** 输出：`string` — 字符串结果

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 生成 BulkMetadata 相对 URL。
   * @param path - 输入：`string` — 八分体路径
   * @param bulkEpoch - 输入：`number` — BulkMetadata 版本号
   * @returns 输出：`string` — 字符串结果
   */
```

</details>

#### PbUrlCodec.encodeBulkMetadataPb

```typescript
encodeBulkMetadataPb(path: string, bulkEpoch: number): string
```

编码 BulkMetadata URL pb 段。

| 参数 | 说明 |
|------|------|
| `path` | 输入：`string` — 八分体路径 |
| `bulkEpoch` | 输入：`number` — BulkMetadata 版本号 |

**返回：** 输出：`string` — 字符串结果

**抛出：** {Error} 条件不满足或 I/O 失败时

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 编码 BulkMetadata URL pb 段。
   * @param path - 输入：`string` — 八分体路径
   * @param bulkEpoch - 输入：`number` — BulkMetadata 版本号
   * @returns 输出：`string` — 字符串结果
   * @throws {Error} 条件不满足或 I/O 失败时
   */
```

</details>

### ProtobufCodec

源文件：[`src/codec/ProtobufCodec.ts`](../src/codec/ProtobufCodec.ts)

Protobuf 消息编解码对象（基于 @bufbuild/protobuf）。

#### ProtobufCodec.decode

```typescript
decode(schema: Desc, input: ArrayBuffer | Uint8Array | Buffer, options: undefined | CodecOptions): MessageShape
```

解码 flags 位掩码。

| 参数 | 说明 |
|------|------|
| `schema` | 输入：`Desc` — Protobuf schema |
| `input` | 输入：`ArrayBuffer \| Uint8Array \| Buffer` — 原始输入 |
| `options` | 输入：`undefined \| CodecOptions` — 配置选项 |

**返回：** 输出：`MessageShape` — MessageShape 实例

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 解码 flags 位掩码。
   * @param schema - 输入：`Desc` — Protobuf schema
   * @param input - 输入：`ArrayBuffer | Uint8Array | Buffer` — 原始输入
   * @param options - 输入：`undefined | CodecOptions` — 配置选项
   * @returns 输出：`MessageShape` — MessageShape 实例
   */
```

</details>

#### ProtobufCodec.encode

```typescript
encode(schema: Desc, message: MessageInitShape | MessageShape, options: undefined | CodecOptions): Uint8Array
```

编码。

| 参数 | 说明 |
|------|------|
| `schema` | 输入：`Desc` — Protobuf schema |
| `message` | 输入：`MessageInitShape \| MessageShape` — 日志消息 |
| `options` | 输入：`undefined \| CodecOptions` — 配置选项 |

**返回：** 输出：`Uint8Array` — 字节数组

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 编码。
   * @param schema - 输入：`Desc` — Protobuf schema
   * @param message - 输入：`MessageInitShape | MessageShape` — 日志消息
   * @param options - 输入：`undefined | CodecOptions` — 配置选项
   * @returns 输出：`Uint8Array` — 字节数组
   */
```

</details>

#### ProtobufCodec.forSchema

```typescript
forSchema(schema: Desc): __object
```

执行 forSchema。

| 参数 | 说明 |
|------|------|
| `schema` | 输入：`Desc` — Protobuf schema |

**返回：** 输出：`__object` — __object 实例

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 执行 forSchema。
   * @param schema - 输入：`Desc` — Protobuf schema
   * @returns 输出：`__object` — __object 实例
   */
```

</details>

## L3 领域解析 bulk

### BulkData

源文件：[`src/bulk/BulkDataParser.ts`](../src/bulk/BulkDataParser.ts)

BulkMetadata 解析结果，含 nodes、octants、bulks 三类索引。 集合语义见 DEVELOPMENT.md §6；具体数量由真实 Bulk 决定，不在注释中写死。

#### BulkData 构造函数

```typescript
constructor(metadata: Message<"geo_globetrotter_proto_rocktree.BulkMetadata"> & object)
```

从 BulkMetadata 构建 nodes、octants、bulks 索引。

| 参数 | 说明 |
|------|------|
| `metadata` | 输入：`BulkMetadata` — 原始 Bulk protobuf 消息 |

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 从 BulkMetadata 构建 nodes、octants、bulks 索引。
   * @param metadata - 输入：`BulkMetadata` — 原始 Bulk protobuf 消息
   */
```

</details>

### BulkDataParser

源文件：[`src/bulk/BulkDataParser.ts`](../src/bulk/BulkDataParser.ts)

BulkMetadata 解析门面对象，负责调用 BulkData 构建索引。

#### BulkDataParser.parse

```typescript
parse(metadata: Message<"geo_globetrotter_proto_rocktree.BulkMetadata"> & object): BulkData
```

解析 BulkMetadata 为 BulkData。

| 参数 | 说明 |
|------|------|
| `metadata` | 输入：`BulkMetadata` — 原始 Bulk protobuf 消息 |

**返回：** 输出：`BulkData` — nodes、octants、bulks 三类 Map 索引

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 解析 BulkMetadata 为 BulkData。
   * @param metadata - 输入：`BulkMetadata` — 原始 Bulk protobuf 消息
   * @returns 输出：`BulkData` — nodes、octants、bulks 三类 Map 索引
   */
```

</details>

### LatLonBox

源文件：[`src/bulk/LatLonBox.ts`](../src/bulk/LatLonBox.ts)

经纬度包围盒值对象（对齐 earth-3d LatLonBox）。

#### LatLonBox 构造函数

```typescript
constructor(n: number, s: number, w: number, e: number)
```

构造实例。

| 参数 | 说明 |
|------|------|
| `n` | 输入：`number` — n 参数 |
| `s` | 输入：`number` — s 参数 |
| `w` | 输入：`number` — w 参数 |
| `e` | 输入：`number` — e 参数 |

**返回：** 输出：`LatLonBox` — LatLonBox 实例

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 构造实例。
   * @param n - 输入：`number` — n 参数
   * @param s - 输入：`number` — s 参数
   * @param w - 输入：`number` — w 参数
   * @param e - 输入：`number` — e 参数
   * @returns 输出：`LatLonBox` — LatLonBox 实例
   */
```

</details>

#### LatLonBox.getChild

```typescript
getChild(octant: string): LatLonBox
```

按八分体字符取子包围盒。

| 参数 | 说明 |
|------|------|
| `octant` | 输入：`string` — octant 参数 |

**返回：** 输出：`LatLonBox` — 北南东西边界

**抛出：** {Error} 条件不满足或 I/O 失败时

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 按八分体字符取子包围盒。
   * @param octant - 输入：`string` — octant 参数
   * @returns 输出：`LatLonBox` — 北南东西边界
   * @throws {Error} 条件不满足或 I/O 失败时
   */
```

</details>

#### LatLonBox.isOverlapping

```typescript
isOverlapping(a: LatLonBox, b: LatLonBox): boolean
```

判断两包围盒是否相交。

| 参数 | 说明 |
|------|------|
| `a` | 输入：`LatLonBox` — a 参数 |
| `b` | 输入：`LatLonBox` — b 参数 |

**返回：** 输出：`boolean` — 条件成立返回 true，否则 false

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 判断两包围盒是否相交。
   * @param a - 输入：`LatLonBox` — a 参数
   * @param b - 输入：`LatLonBox` — b 参数
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */
```

</details>

#### LatLonBox.midPoint

```typescript
midPoint(): LatLon
```

计算包围盒中心点。

**返回：** 输出：`LatLon` — lat 与 lon

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 计算包围盒中心点。
   * @returns 输出：`LatLon` — lat 与 lon
   */
```

</details>

### LatLonBoxCodec

源文件：[`src/bulk/LatLonBoxCodec.ts`](../src/bulk/LatLonBoxCodec.ts)

八分体路径 ↔ LatLonBox 转换对象。

#### LatLonBoxCodec.fromOctantPath

```typescript
fromOctantPath(octantPath: string): LatLonBox
```

八分体路径转经纬度包围盒。

| 参数 | 说明 |
|------|------|
| `octantPath` | 输入：`string` — 八分体路径 |

**返回：** 输出：`LatLonBox` — 北南东西边界

**抛出：** {Error} 条件不满足或 I/O 失败时

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 八分体路径转经纬度包围盒。
   * @param octantPath - 输入：`string` — 八分体路径
   * @returns 输出：`LatLonBox` — 北南东西边界
   * @throws {Error} 条件不满足或 I/O 失败时
   */
```

</details>

### NodeHeaderParser

源文件：[`src/bulk/NodeHeaderParser.ts`](../src/bulk/NodeHeaderParser.ts)

NodeMetadata → NodeHeader 解析对象。

#### NodeHeaderParser.isDataNode

```typescript
isDataNode(header: NodeHeader): boolean
```

判断是否为有效数据节点。

| 参数 | 说明 |
|------|------|
| `header` | 输入：`NodeHeader` — 已解析节点头 |

**返回：** 输出：`boolean` — 条件成立返回 true，否则 false

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 判断是否为有效数据节点。
   * @param header - 输入：`NodeHeader` — 已解析节点头
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */
```

</details>

#### NodeHeaderParser.isTraversableNode

```typescript
isTraversableNode(header: NodeHeader): boolean
```

判断是否为树遍历节点。

| 参数 | 说明 |
|------|------|
| `header` | 输入：`NodeHeader` — 已解析节点头 |

**返回：** 输出：`boolean` — 条件成立返回 true，否则 false

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 判断是否为树遍历节点。
   * @param header - 输入：`NodeHeader` — 已解析节点头
   * @returns 输出：`boolean` — 条件成立返回 true，否则 false
   */
```

</details>

#### NodeHeaderParser.parse

```typescript
parse(parentBulk: Message<"geo_globetrotter_proto_rocktree.BulkMetadata"> & object, metadata: Message<"geo_globetrotter_proto_rocktree.NodeMetadata"> & object): NodeHeader
```

解析单条 NodeMetadata 为 NodeHeader。

| 参数 | 说明 |
|------|------|
| `parentBulk` | 输入：`BulkMetadata` — 所属 Bulk |
| `metadata` | 输入：`NodeMetadata` — 单条节点元数据 |

**返回：** 输出：`NodeHeader` — 单节点解析头

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 解析单条 NodeMetadata 为 NodeHeader。
   * @param parentBulk - 输入：`BulkMetadata` — 所属 Bulk
   * @param metadata - 输入：`NodeMetadata` — 单条节点元数据
   * @returns 输出：`NodeHeader` — 单节点解析头
   */
```

</details>

### ObbParser

源文件：[`src/bulk/ObbParser.ts`](../src/bulk/ObbParser.ts)

有向包围盒（OBB）解包对象。

#### ObbParser.unpack

```typescript
unpack(packed: Uint8Array, headNodeCenter: number[], metersPerTexel: number): OBB
```

解包 OBB 15 字节。

| 参数 | 说明 |
|------|------|
| `packed` | 输入：`Uint8Array` — 打包字节 |
| `headNodeCenter` | 输入：`number[]` — headNodeCenter 参数 |
| `metersPerTexel` | 输入：`number` — metersPerTexel 参数 |

**返回：** 输出：`OBB` — 中心、半轴、旋转矩阵

**抛出：** {Error} 条件不满足或 I/O 失败时

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 解包 OBB 15 字节。
   * @param packed - 输入：`Uint8Array` — 打包字节
   * @param headNodeCenter - 输入：`number[]` — headNodeCenter 参数
   * @param metersPerTexel - 输入：`number` — metersPerTexel 参数
   * @returns 输出：`OBB` — 中心、半轴、旋转矩阵
   * @throws {Error} 条件不满足或 I/O 失败时
   */
```

</details>

### TextureMetadataParser

源文件：[`src/bulk/TextureMetadataParser.ts`](../src/bulk/TextureMetadataParser.ts)

节点纹理/影像元数据解析对象。

#### TextureMetadataParser.unpackImageryEpoch

```typescript
unpackImageryEpoch(flags: number, imageryEpoch: undefined | number, defaultImageryEpoch: undefined | number): number
```

解析 imagery epoch。

| 参数 | 说明 |
|------|------|
| `flags` | 输入：`number` — NodeMetadata 标志位掩码 |
| `imageryEpoch` | 输入：`undefined \| number` — imageryEpoch 参数 |
| `defaultImageryEpoch` | 输入：`undefined \| number` — defaultImageryEpoch 参数 |

**返回：** 输出：`number` — 数值结果

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 解析 imagery epoch。
   * @param flags - 输入：`number` — NodeMetadata 标志位掩码
   * @param imageryEpoch - 输入：`undefined | number` — imageryEpoch 参数
   * @param defaultImageryEpoch - 输入：`undefined | number` — defaultImageryEpoch 参数
   * @returns 输出：`number` — 数值结果
   */
```

</details>

#### TextureMetadataParser.unpackTextureFormat

```typescript
unpackTextureFormat(availableTextureFormats: undefined | number, defaultAvailableTextureFormats: undefined | number): undefined | number
```

从位掩码选取纹理格式。

| 参数 | 说明 |
|------|------|
| `availableTextureFormats` | 输入：`undefined \| number` — availableTextureFormats 参数 |
| `defaultAvailableTextureFormats` | 输入：`undefined \| number` — defaultAvailableTextureFormats 参数 |

**返回：** 输出：`undefined | number` — undefined | number 实例

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 从位掩码选取纹理格式。
   * @param availableTextureFormats - 输入：`undefined | number` — availableTextureFormats 参数
   * @param defaultAvailableTextureFormats - 输入：`undefined | number` — defaultAvailableTextureFormats 参数
   * @returns 输出：`undefined | number` — undefined | number 实例
   */
```

</details>

## L4 HTTP 抓取 fetch

### TlsFingerprintCodec

源文件：[`src/fetch/TlsFingerprintCodec.ts`](../src/fetch/TlsFingerprintCodec.ts)

TLS 浏览器指纹 codec：解析 node-wreq profile 并合并请求头。

#### TlsFingerprintCodec 构造函数

```typescript
constructor(defaultConfig: "chrome_100" | "chrome_101" | "chrome_104" | …)
```

| 参数 | 说明 |
|------|------|
| `defaultConfig` | 输入：`TlsFingerprintConfig` — 默认 TLS 浏览器 profile |

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * @param defaultConfig - 输入：`TlsFingerprintConfig` — 默认 TLS 浏览器 profile
   */
```

</details>

#### TlsFingerprintCodec.buildHeaders

```typescript
buildHeaders(config: TlsRequestConfig): Record<string, string>
```

合并 context / overrides / perRequest 请求头（TLS profile 默认头由 node-wreq 注入）。

| 参数 | 说明 |
|------|------|
| `config` | 输入：`TlsRequestConfig` — context、overrides、perRequest |

**返回：** 输出：`Record<string, string>` — 附加请求头

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 合并 context / overrides / perRequest 请求头（TLS profile 默认头由 node-wreq 注入）。
   * @param config - 输入：`TlsRequestConfig` — context、overrides、perRequest
   * @returns 输出：`Record<string, string>` — 附加请求头
   */
```

</details>

#### TlsFingerprintCodec.getDefaultConfig

```typescript
getDefaultConfig(): "chrome_100" | "chrome_101" | "chrome_104" | …
```

返回当前默认 TLS 指纹配置副本。

**返回：** 输出：`TlsFingerprintConfig` — 默认 browser emulation

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 返回当前默认 TLS 指纹配置副本。
   * @returns 输出：`TlsFingerprintConfig` — 默认 browser emulation
   */
```

</details>

#### TlsFingerprintCodec.listProfiles

```typescript
listProfiles(): "chrome_100" | "chrome_101" | "chrome_104" | …[]
```

列出 node-wreq 内置 TLS 浏览器 profile。

**返回：** 输出：`readonly BrowserProfile[]` — profile 名称列表

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 列出 node-wreq 内置 TLS 浏览器 profile。
   * @returns 输出：`readonly BrowserProfile[]` — profile 名称列表
   */
```

</details>

#### TlsFingerprintCodec.resolveBrowser

```typescript
resolveBrowser(config: TlsRequestConfig): "chrome_100" | "chrome_101" | "chrome_104" | …
```

解析本次请求使用的 TLS 浏览器 profile。

| 参数 | 说明 |
|------|------|
| `config` | 输入：`TlsRequestConfig` — 可选 tlsFingerprint 覆盖 |

**返回：** 输出：`BrowserEmulation` — 传给 node-wreq 的 browser 选项

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 解析本次请求使用的 TLS 浏览器 profile。
   * @param config - 输入：`TlsRequestConfig` — 可选 tlsFingerprint 覆盖
   * @returns 输出：`BrowserEmulation` — 传给 node-wreq 的 browser 选项
   */
```

</details>

### WebFetch

源文件：[`src/fetch/WebFetch.ts`](../src/fetch/WebFetch.ts)

带 TLS 浏览器指纹的 HTTP GET 抓取对象（非 Rocktree 专用）。

#### WebFetch 构造函数

```typescript
constructor(options: WebFetchOptions)
```

| 参数 | 说明 |
|------|------|
| `options` | 输入：`WebFetchOptions` — TLS 指纹、context、header 覆盖 |

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * @param options - 输入：`WebFetchOptions` — TLS 指纹、context、header 覆盖
   */
```

</details>

#### WebFetch.buildHeaders

```typescript
buildHeaders(getOptions: WebFetchGetOptions): Record<string, string>
```

构建本次 GET 附加请求头（context + 覆盖；profile 默认头由 node-wreq 注入）。

| 参数 | 说明 |
|------|------|
| `getOptions` | 输入：`WebFetchGetOptions` — 单次覆盖 |

**返回：** 输出：`Record<string, string>` — 请求头

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 构建本次 GET 附加请求头（context + 覆盖；profile 默认头由 node-wreq 注入）。
   * @param getOptions - 输入：`WebFetchGetOptions` — 单次覆盖
   * @returns 输出：`Record<string, string>` — 请求头
   */
```

</details>

#### WebFetch.getBytes

```typescript
getBytes(url: string, getOptions: WebFetchGetOptions): Promise<Uint8Array>
```

GET 请求并返回响应字节（TLS 浏览器指纹由 node-wreq 原生层实现）。

| 参数 | 说明 |
|------|------|
| `url` | 输入：`string` — 完整 URL |
| `getOptions` | 输入：`WebFetchGetOptions` — 单次 headers / tlsFingerprint 覆盖 |

**返回：** 输出：`Promise<Uint8Array>` — 响应体

**抛出：** {Error} fetch 不可用或 HTTP 非 2xx

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * GET 请求并返回响应字节（TLS 浏览器指纹由 node-wreq 原生层实现）。
   * @param url - 输入：`string` — 完整 URL
   * @param getOptions - 输入：`WebFetchGetOptions` — 单次 headers / tlsFingerprint 覆盖
   * @returns 输出：`Promise<Uint8Array>` — 响应体
   * @throws {Error} fetch 不可用或 HTTP 非 2xx
   */
```

</details>

#### WebFetch.getBytesWithTrace

```typescript
getBytesWithTrace(url: string, getOptions: WebFetchGetOptions): Promise<WebFetchResult>
```

GET 请求并返回响应字节与传输层 trace（用于确认 TLS/HTTP 协议栈）。

| 参数 | 说明 |
|------|------|
| `url` | 输入：`string` — 完整 URL |
| `getOptions` | 输入：`WebFetchGetOptions` — 单次覆盖；`trace: true` 收集 TLS 证书 |

**返回：** 输出：`Promise<WebFetchResult>` — 字节与 FetchTransportTrace

**抛出：** {Error} fetch 不可用或 HTTP 非 2xx

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * GET 请求并返回响应字节与传输层 trace（用于确认 TLS/HTTP 协议栈）。
   * @param url - 输入：`string` — 完整 URL
   * @param getOptions - 输入：`WebFetchGetOptions` — 单次覆盖；`trace: true` 收集 TLS 证书
   * @returns 输出：`Promise<WebFetchResult>` — 字节与 FetchTransportTrace
   * @throws {Error} fetch 不可用或 HTTP 非 2xx
   */
```

</details>

#### WebFetch.resolveBrowser

```typescript
resolveBrowser(getOptions: WebFetchGetOptions): "chrome_100" | "chrome_101" | "chrome_104" | …
```

解析本次 GET 使用的 TLS 浏览器 profile。

| 参数 | 说明 |
|------|------|
| `getOptions` | 输入：`WebFetchGetOptions` — 单次覆盖 |

**返回：** 输出：`TlsFingerprintConfig` — node-wreq browser 选项

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 解析本次 GET 使用的 TLS 浏览器 profile。
   * @param getOptions - 输入：`WebFetchGetOptions` — 单次覆盖
   * @returns 输出：`TlsFingerprintConfig` — node-wreq browser 选项
   */
```

</details>

## L5 Rocktree API client

### RocktreeApi

源文件：[`src/client/RocktreeApi.ts`](../src/client/RocktreeApi.ts)

Rocktree HTTP API：通过 WebFetch 拉取 kh.google.com 并解码 protobuf。

#### RocktreeApi 构造函数

```typescript
constructor(options: WebFetchOptions & object)
```

| 参数 | 说明 |
|------|------|
| `options` | 输入：`RocktreeApiOptions` — baseUrl、WebFetch、指纹与 header 配置 |

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * @param options - 输入：`RocktreeApiOptions` — baseUrl、WebFetch、指纹与 header 配置
   */
```

</details>

#### RocktreeApi.fetchBulkData

```typescript
fetchBulkData(args: FetchBulkMetadataArgs): Promise<BulkData>
```

拉取并解析 BulkData。

| 参数 | 说明 |
|------|------|
| `args` | 输入：`FetchBulkMetadataArgs` — 请求参数 |

**返回：** 输出：`Promise<BulkData>` — nodes、octants、bulks 索引

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 拉取并解析 BulkData。
   * @param args - 输入：`FetchBulkMetadataArgs` — 请求参数
   * @returns 输出：`Promise<BulkData>` — nodes、octants、bulks 索引
   */
```

</details>

#### RocktreeApi.fetchBulkMetadata

```typescript
fetchBulkMetadata(args: FetchBulkMetadataArgs): Promise<Message<"geo_globetrotter_proto_rocktree.BulkMetadata"> & object>
```

拉取 BulkMetadata。

| 参数 | 说明 |
|------|------|
| `args` | 输入：`FetchBulkMetadataArgs` — path、bulkEpoch 或 nodeKey |

**返回：** 输出：`Promise<BulkMetadata>` — 原始 Bulk 消息

**抛出：** {Error} 缺少 bulkEpoch 或 HTTP 失败时

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 拉取 BulkMetadata。
   * @param args - 输入：`FetchBulkMetadataArgs` — path、bulkEpoch 或 nodeKey
   * @returns 输出：`Promise<BulkMetadata>` — 原始 Bulk 消息
   * @throws {Error} 缺少 bulkEpoch 或 HTTP 失败时
   */
```

</details>

#### RocktreeApi.fetchPlanetoidMetadata

```typescript
fetchPlanetoidMetadata(request: undefined | Message<"geo_globetrotter_proto_rocktree.PlanetoidMetadataRequest"> & object): Promise<Message<"geo_globetrotter_proto_rocktree.PlanetoidMetadata"> & object>
```

拉取 PlanetoidMetadata。

| 参数 | 说明 |
|------|------|
| `request` | 输入：`PlanetoidMetadataRequest` — 预留请求体（当前未用） |

**返回：** 输出：`Promise<PlanetoidMetadata>` — 星球元数据

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 拉取 PlanetoidMetadata。
   * @param request - 输入：`PlanetoidMetadataRequest` — 预留请求体（当前未用）
   * @returns 输出：`Promise<PlanetoidMetadata>` — 星球元数据
   */
```

</details>

#### RocktreeApi.getWebFetch

```typescript
getWebFetch(): WebFetch
```

返回底层 WebFetch（可配置 header / 指纹）。

**返回：** 输出：`WebFetch` — HTTP 抓取对象

<details><summary>原始 JSDoc</summary>

```typescript
/**
   * 返回底层 WebFetch（可配置 header / 指纹）。
   * @returns 输出：`WebFetch` — HTTP 抓取对象
   */
```

</details>

## 模块级函数

*源文件：`src/client/RocktreeApi.ts`*

#### createRocktreeApi

```typescript
createRocktreeApi(options: WebFetchOptions & object): RocktreeApi
```

创建 RocktreeApi 实例。

| 参数 | 说明 |
|------|------|
| `options` | 输入：`RocktreeApiOptions` — baseUrl、WebFetch 与 header 配置 |

**返回：** 输出：`RocktreeApi` — Rocktree API 实例

<details><summary>原始 JSDoc</summary>

```typescript
/**
 * 创建 RocktreeApi 实例。
 * @param options - 输入：`RocktreeApiOptions` — baseUrl、WebFetch 与 header 配置
 * @returns 输出：`RocktreeApi` — Rocktree API 实例
 */
```

</details>

*源文件：`src/core/Logger.ts`*

#### logLevelFromEnv

```typescript
logLevelFromEnv(): DEBUG | INFO | WARN | …
```

从环境变量解析日志级别。

**返回：** 输出：`DEBUG | INFO | WARN | …` — DEBUG | INFO | WARN | … 实例

<details><summary>原始 JSDoc</summary>

```typescript
/**
 * 从环境变量解析日志级别。
 * @returns 输出：`DEBUG | INFO | WARN | …` — DEBUG | INFO | WARN | … 实例
 */
```

</details>

*源文件：`src/fetch/TlsFingerprintCodec.ts`*

#### mergeBrowserEmulation

```typescript
mergeBrowserEmulation(base: "chrome_100" | "chrome_101" | "chrome_104" | …, override: undefined | "chrome_100" | "chrome_101" | …): "chrome_100" | "chrome_101" | "chrome_104" | …
```

合并默认与单次 TLS profile 覆盖。

| 参数 | 说明 |
|------|------|
| `base` | 输入：`TlsFingerprintConfig` — 默认 profile |
| `override` | 输入：`TlsFingerprintConfig \| undefined` — 单次覆盖 |

**返回：** 输出：`BrowserEmulation` — 合并后的 browser 选项

<details><summary>原始 JSDoc</summary>

```typescript
/**
 * 合并默认与单次 TLS profile 覆盖。
 * @param base - 输入：`TlsFingerprintConfig` — 默认 profile
 * @param override - 输入：`TlsFingerprintConfig | undefined` — 单次覆盖
 * @returns 输出：`BrowserEmulation` — 合并后的 browser 选项
 */
```

</details>

*源文件：`src/fetch/TlsFingerprintCodec.ts`*

#### cloneBrowserEmulation

```typescript
cloneBrowserEmulation(config: "chrome_100" | "chrome_101" | "chrome_104" | …): "chrome_100" | "chrome_101" | "chrome_104" | …
```

复制 TLS profile 配置（避免 mutate 默认值）。

| 参数 | 说明 |
|------|------|
| `config` | 输入：`TlsFingerprintConfig` — 源 profile |

**返回：** 输出：`BrowserEmulation` — 副本

<details><summary>原始 JSDoc</summary>

```typescript
/**
 * 复制 TLS profile 配置（避免 mutate 默认值）。
 * @param config - 输入：`TlsFingerprintConfig` — 源 profile
 * @returns 输出：`BrowserEmulation` — 副本
 */
```

</details>

*源文件：`src/fetch/TlsFingerprintCodec.ts`*

#### mergeHeaderRecords

```typescript
mergeHeaderRecords(layers: undefined | Record<string, string>[]): Record<string, string>
```

按顺序合并多层请求头（后者覆盖前者）。

| 参数 | 说明 |
|------|------|
| `layers` | 输入：`Record<string, string> \| undefined` — context、overrides、perRequest |

**返回：** 输出：`Record<string, string>` — 合并后的请求头

<details><summary>原始 JSDoc</summary>

```typescript
/**
 * 按顺序合并多层请求头（后者覆盖前者）。
 * @param layers - 输入：`Record<string, string> | undefined` — context、overrides、perRequest
 * @returns 输出：`Record<string, string>` — 合并后的请求头
 */
```

</details>

*源文件：`src/fetch/WebFetch.ts`*

#### createWebFetch

```typescript
createWebFetch(options: WebFetchOptions): WebFetch
```

创建 WebFetch 实例。

| 参数 | 说明 |
|------|------|
| `options` | 输入：`WebFetchOptions` — TLS 指纹与 header 配置 |

**返回：** 输出：`WebFetch` — WebFetch 实例

<details><summary>原始 JSDoc</summary>

```typescript
/**
 * 创建 WebFetch 实例。
 * @param options - 输入：`WebFetchOptions` — TLS 指纹与 header 配置
 * @returns 输出：`WebFetch` — WebFetch 实例
 */
```

</details>

*源文件：`src/fetch/WebFetch.ts`*

#### mergeTlsFingerprint

```typescript
mergeTlsFingerprint(base: undefined | "chrome_100" | "chrome_101" | …, override: undefined | "chrome_100" | "chrome_101" | …): undefined | "chrome_100" | "chrome_101" | …
```

合并默认与单次 TLS profile 覆盖。

| 参数 | 说明 |
|------|------|
| `base` | 输入：`TlsFingerprintConfig \| undefined` — 实例默认 profile |
| `override` | 输入：`TlsFingerprintConfig \| undefined` — 单次覆盖 |

**返回：** 输出：`TlsFingerprintConfig | undefined` — 合并结果

<details><summary>原始 JSDoc</summary>

```typescript
/**
 * 合并默认与单次 TLS profile 覆盖。
 * @param base - 输入：`TlsFingerprintConfig | undefined` — 实例默认 profile
 * @param override - 输入：`TlsFingerprintConfig | undefined` — 单次覆盖
 * @returns 输出：`TlsFingerprintConfig | undefined` — 合并结果
 */
```

</details>

*源文件：`src/fetch/WebFetch.ts`*

#### buildTransportTrace

```typescript
buildTransportTrace(args: object): FetchTransportTrace
```

从 node-wreq 响应组装 FetchTransportTrace。

| 参数 | 说明 |
|------|------|
| `args` | 输入：`object` — url、browser、status、responseHeaders、timings、tlsPeer |

**返回：** 输出：`FetchTransportTrace` — 传输层追踪对象

<details><summary>原始 JSDoc</summary>

```typescript
/**
 * 从 node-wreq 响应组装 FetchTransportTrace。
 * @param args - 输入：`object` — url、browser、status、responseHeaders、timings、tlsPeer
 * @returns 输出：`FetchTransportTrace` — 传输层追踪对象
 */
```

</details>

*源文件：`src/fetch/WebFetch.ts`*

#### isHttp2FingerprintEnabled

```typescript
isHttp2FingerprintEnabled(browser: "chrome_100" | "chrome_101" | "chrome_104" | …): boolean
```

判断 browser profile 是否启用 HTTP/2 指纹。

| 参数 | 说明 |
|------|------|
| `browser` | 输入：`TlsFingerprintConfig` — node-wreq browser 选项 |

**返回：** 输出：`boolean` — true 表示配置 ALPN/h2 指纹

<details><summary>原始 JSDoc</summary>

```typescript
/**
 * 判断 browser profile 是否启用 HTTP/2 指纹。
 * @param browser - 输入：`TlsFingerprintConfig` — node-wreq browser 选项
 * @returns 输出：`boolean` — true 表示配置 ALPN/h2 指纹
 */
```

</details>

*源文件：`src/fetch/WebFetch.ts`*

#### isProfileHeadersEnabled

```typescript
isProfileHeadersEnabled(browser: "chrome_100" | "chrome_101" | "chrome_104" | …): boolean
```

判断 browser profile 是否注入默认浏览器头。

| 参数 | 说明 |
|------|------|
| `browser` | 输入：`TlsFingerprintConfig` — node-wreq browser 选项 |

**返回：** 输出：`boolean` — true 表示使用 profile 默认头顺序

<details><summary>原始 JSDoc</summary>

```typescript
/**
 * 判断 browser profile 是否注入默认浏览器头。
 * @param browser - 输入：`TlsFingerprintConfig` — node-wreq browser 选项
 * @returns 输出：`boolean` — true 表示使用 profile 默认头顺序
 */
```

</details>

*源文件：`src/fetch/WebFetch.ts`*

#### headersToRecord

```typescript
headersToRecord(headers: object): Record<string, string>
```

将 Headers 转为普通对象。

| 参数 | 说明 |
|------|------|
| `headers` | 输入：`Headers` — node-wreq 响应头 |

**返回：** 输出：`Record<string, string>` — 键值对

<details><summary>原始 JSDoc</summary>

```typescript
/**
 * 将 Headers 转为普通对象。
 * @param headers - 输入：`Headers` — node-wreq 响应头
 * @returns 输出：`Record<string, string>` — 键值对
 */
```

</details>

---

共 **16** 个类、**61** 个 public API。
