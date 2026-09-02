# GeoClaw JSDoc 快速参考

> 完整规范见 [`DEVELOPMENT.md`](../DEVELOPMENT.md) §3。

## 标准模板（扁平，禁止嵌套）

### 有返回值

```typescript
/**
 * 解包 path_and_flags 为路径与标志位。
 * @param pathAndFlags - 输入：`number` — NodeMetadata.path_and_flags（uint32）
 * @returns 输出：`UnpackedPathAndFlags` — path、level、flags 三字段
 */
```

### 无返回值

```typescript
/**
 * 写入 INFO 级别日志。
 * @param message - 输入：`string` — 中文描述
 * @param data - 输入：`unknown` — 可选结构化数据
 * @returns 输出：无（`void`）
 */
```

### 可能抛错

```typescript
/**
 * 解包 15 字节 OBB。
 * @param packed - 输入：`Uint8Array` — 长度必须为 15
 * @param headNodeCenter - 输入：`readonly number[]` — 父 Bulk 中心坐标
 * @param metersPerTexel - 输入：`number` — 每 texel 米数
 * @returns 输出：`OBB` — 中心、半轴、旋转矩阵
 * @throws {Error} packed.length !== 15 时
 */
```

```

## 注释分几类（别混用）

| 名称 | 写法 | 用在哪 |
|------|------|--------|
| **JSDoc 方法注释** | `/**` + `@param` / `@returns` | public 方法（本项目 **强制**，见上） |
| **JSDoc 类摘要** | `/** 一句说明 */` | class / interface，**无列表、无写死数值** |
| **普通注释** | `//` 或 `/* */` | 非 API 说明；**不能替代**方法 JSDoc |

**你看到的 `- nodes：120` 那种**：Markdown 列表嵌在 JSDoc 里 — **不符合**本项目规范（§3.3 禁止列表；数值应放测试或 DEVELOPMENT.md §6）。

**`Message<"geo_...">` 那种**：`npm run jsdoc:gen` 自动推断的类型字符串 — **不合格**，应改成已 export 的名字如 `BulkMetadata`。

## 硬性规则

| 规则 | 说明 |
|------|------|
| 输入前缀 | 每个 `@param` 必须以 `输入：\`Type\` —` 开头 |
| 输出前缀 | `@returns` 必须以 `输出：\`Type\` —` 或 `输出：无（\`void\`）` |
| 类型名 | 用已 export 的类型名；禁止在 JSDoc 内展开多层 `{ a: { b: … } }` |
| 扁平 | 整个块 ≤12 行；禁止 `-` 列表、禁止多段缩进说明 |
| 禁止含糊 | 不得出现：等、相关、可能、一般、某种、若干、类似 |
| 复杂结构 | 写 `输出：\`NodeHeader\` — 字段见 export type NodeHeader` |

## 快速生成方式

### 1. VS Code / Cursor 片段

| 前缀 | 用途 |
|------|------|
| `gcdoc` | 标准方法 |
| `gcdoce` | 含 `@throws` |
| `gcdocv` | void 方法 |
| `gctype` | 类型字段单行 |

文件：`.vscode/geoclaw-jsdoc.code-snippets`

### 2. CLI（从 TS 类型自动推断）

```bash
# 打印所有 public API 的 JSDoc 草稿
npm run jsdoc:gen

# 仅写入缺失 JSDoc 的方法
npm run jsdoc:gen -- --write

# 按标准格式重写全部 public JSDoc（保留后需人工改「待补充」）
npm run jsdoc:gen -- --write --force

# 提交前校验
npm run jsdoc:check

# 导出 JSDoc 为 Markdown（docs/API.md）
npm run jsdoc:md

# 指定输出路径
npm run jsdoc:md -- --out docs/API.md
```

### 3. 工作流

1. 写新方法 → 输入 `gcdoc` 或运行 `jsdoc:gen -- --write`
2. 把「待补充」改成 **具体、可验证** 的中文（单位、取值范围、字段含义）
3. `npm run jsdoc:check` 通过后再提交
4. 需要可读文档时运行 `npm run jsdoc:md` 更新 [`API.md`](./API.md)

## 类型字段注释

对象类型字段用 **单行**，不嵌套：

```typescript
export type NodeHeader = {
  /** 绝对八分体路径；类型：`string` */
  path: string;
  /** 仅 isBulk 为 true 时有值；类型：`number` */
  bulkEpoch?: number;
};
```
