export type ParamDoc = {
  name: string;
  type: string;
  description?: string;
};

export type ReturnDoc = {
  type: string;
  description?: string;
};

export type JsDocBlockInput = {
  summary: string;
  params: ParamDoc[];
  returns: ReturnDoc;
  throws?: string;
};

const VAGUE_PHRASES = [
  "等",
  "相关",
  "可能",
  "一般",
  "某种",
  "若干",
  "等等",
  "类似",
  "适当",
  "相应",
  "有关",
  "见类型定义",
  "待补充",
];

/**
 * 渲染标准 GeoClaw JSDoc 块（扁平结构，无嵌套列表）。
 * @param input - 摘要、参数、返回值、可选 throws
 * @returns 完整 JSDoc 字符串
 */
export function renderJsDocBlock(input: JsDocBlockInput): string {
  const lines: string[] = ["/**", ` * ${input.summary.trim().replace(/\.$/, "")}。`];

  for (const p of input.params) {
    const desc = p.description?.trim() || "待补充";
    lines.push(` * @param ${p.name} - 输入：\`${p.type}\` — ${desc}`);
  }

  if (input.returns.type === "void") {
    lines.push(" * @returns 输出：无（`void`）");
  } else {
    const desc = input.returns.description?.trim() || "待补充";
    lines.push(` * @returns 输出：\`${input.returns.type}\` — ${desc}`);
  }

  if (input.throws) {
    lines.push(` * @throws {Error} ${input.throws.trim()}`);
  }

  lines.push(" */");
  return lines.join("\n");
}

/**
 * 从方法名生成默认中文摘要。
 * @param methodName - 方法名
 * @returns 一句中文说明
 */
export function defaultSummary(methodName: string): string {
  if (methodName === "constructor") {
    return "构造实例";
  }

  const labels: Record<string, string> = {
    unpackPathAndFlags: "解包 path_and_flags 为路径与标志位",
    isBulkPath: "判断绝对路径是否为子 Bulk 节点",
    canHaveData: "判断节点是否可含几何数据",
    joinOctantPath: "拼接父路径与相对八分体段",
    hasChildBulk: "判断相对路径是否指向子 Bulk",
    hasNodeData: "判断 flags 是否允许节点数据",
    decode: "解码 flags 位掩码",
    gunzipIfNeeded: "检测 gzip 并解压",
    gzipBytes: "gzip 压缩字节",
    toUint8Array: "转为 Uint8Array",
    encodeBulkMetadataPb: "编码 BulkMetadata URL pb 段",
    bulkMetadataUrlPath: "生成 BulkMetadata 相对 URL",
    fetchPlanetoidMetadata: "HTTP 拉取 PlanetoidMetadata",
    fetchBulkMetadata: "HTTP 拉取 BulkMetadata",
    fetchBulkData: "HTTP 拉取并解析 BulkData",
    parse: "解析 BulkMetadata 为 BulkData",
    isDataNode: "判断是否为有效数据节点",
    isTraversableNode: "判断是否为树遍历节点",
    fromOctantPath: "八分体路径转经纬度包围盒",
    midPoint: "计算包围盒中心点",
    getChild: "按八分体字符取子包围盒",
    isOverlapping: "判断两包围盒是否相交",
    unpack: "解包 OBB 15 字节",
    unpackTextureFormat: "从位掩码选取纹理格式",
    unpackImageryEpoch: "解析 imagery epoch",
    logLevelFromEnv: "从环境变量解析日志级别",
    debug: "输出 DEBUG 日志",
    info: "输出 INFO 日志",
    warn: "输出 WARN 日志",
    error: "输出 ERROR 日志",
    createRocktreeClient: "创建 RocktreeClient 实例",
    createRocktreeApi: "创建 RocktreeApi 实例",
    createWebFetch: "创建 WebFetch 实例",
  };

  if (labels[methodName]) {
    return labels[methodName];
  }

  const map: Record<string, string> = {
    decode: "解码",
    encode: "编码",
    parse: "解析",
    fetch: "拉取",
    unpack: "解包",
    join: "拼接",
    is: "判断",
    has: "判断",
    can: "判断可否",
    from: "转换",
    create: "创建",
    get: "获取",
  };
  for (const [prefix, verb] of Object.entries(map)) {
    if (methodName.startsWith(prefix) && methodName.length > prefix.length) {
      return `${verb} ${methodName.slice(prefix.length)}`;
    }
    if (methodName === prefix) {
      return verb;
    }
  }
  return `执行 ${methodName}`;
}

/**
 * 从返回值类型与方法名生成明确的中文描述。
 * @param methodName - 方法名
 * @param returnType - 格式化后的返回类型
 * @returns 返回值说明
 */
export function defaultReturnDescription(methodName: string, returnType: string): string {
  if (returnType === "void") {
    return undefined as never;
  }
  if (returnType === "boolean") {
    if (methodName.startsWith("is") || methodName.startsWith("has") || methodName.startsWith("can")) {
      return "条件成立返回 true，否则 false";
    }
    return "布尔结果";
  }
  if (returnType === "string") {
    return "字符串结果";
  }
  if (returnType === "number") {
    return "数值结果";
  }
  if (returnType === "Uint8Array") {
    return "字节数组";
  }
  if (returnType.startsWith("Promise<")) {
    const inner = returnType.slice(8, -1);
    return `异步返回 ${inner}`;
  }
  const named: Record<string, string> = {
    UnpackedPathAndFlags: "path、level、flags 三字段",
    DecodedNodeFlags: "各 flags 布尔字段与 names 列表",
    BulkData: "nodes、octants、bulks 索引",
    NodeHeader: "单节点解析头",
    OBB: "中心、半轴、旋转矩阵",
    LatLonBox: "北南东西边界",
    LatLon: "lat 与 lon",
    LogLevel: "日志级别枚举值",
    RocktreeClient: "客户端实例",
    RocktreeApi: "Rocktree API 实例",
    WebFetch: "WebFetch 实例",
    BrowserFingerprintCodec: "浏览器指纹 codec 实例",
    TlsFingerprintCodec: "TLS 浏览器指纹 codec 实例",
  };
  return named[returnType] ?? `${returnType} 实例`;
}

/**
 * 从参数名生成默认中文描述。
 * @param paramName - 参数名
 * @returns 简短描述
 */
export function defaultParamDescription(paramName: string): string {
  const map: Record<string, string> = {
    input: "原始输入",
    path: "八分体路径",
    flags: "NodeMetadata 标志位掩码",
    bulkEpoch: "BulkMetadata 版本号",
    epoch: "节点版本号",
    metadata: "protobuf 元数据消息",
    parentBulk: "所属 BulkMetadata",
    header: "已解析节点头",
    url: "完整 HTTP URL",
    base: "基础 URL",
    options: "配置选项",
    request: "请求参数",
    args: "请求参数",
    schema: "Protobuf schema",
    message: "Protobuf 消息体",
    packed: "打包字节",
    octantPath: "八分体路径",
    absolutePath: "绝对八分体路径",
    relativePath: "相对八分体路径",
    basePath: "父路径前缀",
    pathAndFlags: "path_and_flags 打包字段",
    message: "日志消息",
    data: "附加数据",
    err: "错误对象",
    level: "日志级别",
    scope: "日志作用域",
    minLevel: "最低日志级别",
  };
  return map[paramName] ?? `${paramName} 参数`;
}

/**
 * 检测 JSDoc 文本是否含含糊词汇。
 * @param text - JSDoc 全文
 * @returns 命中的含糊词列表
 */
export function findVagueWords(text: string): string[] {
  return VAGUE_PHRASES.filter((w) => text.includes(w));
}

/**
 * 校验 JSDoc 是否符合 GeoClaw 标准。
 * @param jsdocText - JSDoc 块全文（含块注释起止符）
 * @param paramNames - 应有参数名列表
 * @returns 违规说明列表；空数组表示通过
 */
export function validateJsDocBlock(
  jsdocText: string,
  paramNames: string[],
  options?: { kind?: "method" | "function" | "constructor" },
): string[] {
  const issues: string[] = [];
  const body = jsdocText.replace(/^\/\*\*|\*\/$/g, "").trim();
  const requireReturns = options?.kind !== "constructor";

  if (body.split("\n").length > 12) {
    issues.push("JSDoc 超过 12 行，请扁平化");
  }

  if (requireReturns) {
    if (!body.includes("@returns")) {
      issues.push("缺少 @returns");
    } else if (!/输出：/.test(body)) {
      issues.push("@returns 须以「输出：」开头并含反引号类型");
    }
  }

  for (const name of paramNames) {
    const re = new RegExp(`@param\\s+${name}\\s+-`);
    if (!re.test(body)) {
      issues.push(`缺少 @param ${name}`);
      continue;
    }
    const line = body.split("\n").find((l) => l.includes(`@param ${name}`)) ?? "";
    if (!/输入：`.+`/.test(line)) {
      issues.push(`@param ${name} 须为：输入：\`Type\` — 说明`);
    }
  }

  issues.push(...findVagueWords(body).map((w) => `含含糊词「${w}」`));

  if (/\n\s*\*\s*[-•]/.test(body)) {
    issues.push("禁止 JSDoc 内 Markdown 列表（- / •）");
  }

  if (/`Message<"/.test(body)) {
    issues.push("@param/@returns 须用 export 类型名（如 BulkMetadata），禁止 Message<...> 内部类型");
  }

  return issues;
}
