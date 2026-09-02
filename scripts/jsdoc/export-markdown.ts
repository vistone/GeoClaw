import fs from "node:fs";
import path from "node:path";

import {
  scanClasses,
  scanPublicApi,
  type ApiMember,
  type ClassDoc,
} from "./scan-api.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_OUT = path.join(ROOT, "docs/API.md");

const LAYER_ORDER = ["core", "codec", "bulk", "fetch", "client"];
const LAYER_TITLE: Record<string, string> = {
  core: "L1 基础设施 core",
  codec: "L2 编解码 codec",
  bulk: "L3 领域解析 bulk",
  fetch: "L4 HTTP 抓取 fetch",
  client: "L5 Rocktree API client",
};

type ParsedJsDoc = {
  summary: string;
  params: { name: string; text: string }[];
  returns: string | null;
  throws: string | null;
  rawLines: string[];
};

/**
 * 将 JSDoc 块解析为结构化字段。
 * @param jsdoc - 含块注释起止符的原文
 * @returns 摘要、param、returns、throws
 */
export function parseJsDoc(jsdoc: string): ParsedJsDoc {
  const body = jsdoc
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd());

  const params: { name: string; text: string }[] = [];
  let returns: string | null = null;
  let throws: string | null = null;
  const summaryLines: string[] = [];

  for (const line of body) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const paramMatch = trimmed.match(/^@param\s+(\S+)\s+-?\s*(.*)$/);
    if (paramMatch) {
      params.push({ name: paramMatch[1]!, text: paramMatch[2]!.trim() });
      continue;
    }
    if (trimmed.startsWith("@returns")) {
      returns = trimmed.replace(/^@returns\s+-?\s*/, "").trim();
      continue;
    }
    if (trimmed.startsWith("@throws")) {
      throws = trimmed.replace(/^@throws\s*/, "").trim();
      continue;
    }
    if (trimmed.startsWith("@")) continue;
    summaryLines.push(trimmed);
  }

  return {
    summary: summaryLines.join(" ").trim(),
    params,
    returns,
    throws,
    rawLines: body.filter((l) => l.trim().length > 0),
  };
}

function memberTitle(m: ApiMember): string {
  if (m.kind === "constructor") {
    return `${m.className} 构造函数`;
  }
  if (m.className) {
    return `${m.className}.${m.name}`;
  }
  return m.name;
}

function memberSignature(m: ApiMember): string {
  const paramSig = m.params.map((p) => `${p.name}: ${p.type}`).join(", ");
  if (m.kind === "constructor") {
    return `constructor(${paramSig})`;
  }
  return `${m.name}(${paramSig}): ${m.returnType}`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderMember(m: ApiMember): string[] {
  const lines: string[] = [];
  lines.push(`#### ${memberTitle(m)}`);
  lines.push("");
  lines.push("```typescript");
  lines.push(memberSignature(m));
  lines.push("```");
  lines.push("");

  if (!m.jsdoc) {
    lines.push("*（缺少 JSDoc）*");
    lines.push("");
    return lines;
  }

  const parsed = parseJsDoc(m.jsdoc);
  if (parsed.summary) {
    lines.push(parsed.summary);
    lines.push("");
  }

  if (parsed.params.length) {
    lines.push("| 参数 | 说明 |");
    lines.push("|------|------|");
    for (const p of parsed.params) {
      lines.push(`| \`${p.name}\` | ${escapeCell(p.text)} |`);
    }
    lines.push("");
  }

  if (parsed.returns) {
    lines.push(`**返回：** ${parsed.returns}`);
    lines.push("");
  }

  if (parsed.throws) {
    lines.push(`**抛出：** ${parsed.throws}`);
    lines.push("");
  }

  lines.push("<details><summary>原始 JSDoc</summary>");
  lines.push("");
  lines.push("```typescript");
  lines.push(m.jsdoc);
  lines.push("```");
  lines.push("");
  lines.push("</details>");
  lines.push("");

  return lines;
}

function renderClass(cls: ClassDoc, members: ApiMember[]): string[] {
  const rel = path.relative(ROOT, cls.file).replace(/\\/g, "/");
  const lines: string[] = [];
  lines.push(`### ${cls.name}`);
  lines.push("");
  lines.push(`源文件：[\`${rel}\`](../${rel})`);
  lines.push("");

  if (cls.jsdoc) {
    const parsed = parseJsDoc(cls.jsdoc);
    if (parsed.summary) {
      lines.push(parsed.summary);
      lines.push("");
    }
  }

  const sorted = [...members].sort((a, b) => {
    const order = (k: ApiMember["kind"]) =>
      k === "constructor" ? 0 : k === "method" ? 1 : 2;
    const d = order(a.kind) - order(b.kind);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });

  if (sorted.length === 0) {
    lines.push("*（无 public 方法）*");
    lines.push("");
    return lines;
  }

  for (const m of sorted) {
    lines.push(...renderMember(m));
  }

  return lines;
}

function layerAnchor(layer: string): string {
  return (LAYER_TITLE[layer] ?? layer).replace(/\s+/g, "-").toLowerCase();
}

/**
 * 将当前源码 JSDoc 导出为 Markdown。
 * @param outFile - 输出路径，默认 docs/API.md
 * @returns 写入的绝对路径
 */
export function exportJsDocMarkdown(outFile: string = DEFAULT_OUT): string {
  const classes = scanClasses();
  const members = scanPublicApi();

  const membersByClass = new Map<string, ApiMember[]>();
  const moduleFunctions: ApiMember[] = [];

  for (const m of members) {
    if (m.className) {
      const key = `${m.file}::${m.className}`;
      const list = membersByClass.get(key) ?? [];
      list.push(m);
      membersByClass.set(key, list);
    } else {
      moduleFunctions.push(m);
    }
  }

  const classesByLayer = new Map<string, ClassDoc[]>();
  for (const cls of classes) {
    const list = classesByLayer.get(cls.layer) ?? [];
    list.push(cls);
    classesByLayer.set(cls.layer, list);
  }

  const lines: string[] = [];
  const now = new Date().toISOString().slice(0, 10);

  lines.push("# GeoClaw API 文档（JSDoc 导出）");
  lines.push("");
  lines.push(`> 自动生成于 **${now}**；请勿手改。更新 JSDoc 后运行 \`npm run jsdoc:md\`。`);
  lines.push(">");
  lines.push("> 规范：[DEVELOPMENT.md](../DEVELOPMENT.md) §3 · [JSDOC.md](./JSDOC.md)");
  lines.push("");
  lines.push("## 目录");
  lines.push("");

  for (const layer of LAYER_ORDER) {
    if (!classesByLayer.has(layer)) continue;
    const title = LAYER_TITLE[layer] ?? layer;
    lines.push(`- [${title}](#${layerAnchor(layer)})`);
  }
  if (moduleFunctions.length) {
    lines.push("- [模块级函数](#模块级函数)");
  }
  lines.push("");

  for (const layer of LAYER_ORDER) {
    const list = classesByLayer.get(layer);
    if (!list?.length) continue;

    const title = LAYER_TITLE[layer] ?? layer;
    lines.push(`## ${title}`);
    lines.push("");

    for (const cls of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const key = `${cls.file}::${cls.name}`;
      lines.push(...renderClass(cls, membersByClass.get(key) ?? []));
    }
  }

  if (moduleFunctions.length) {
    lines.push("## 模块级函数");
    lines.push("");
    for (const m of moduleFunctions.sort((a, b) => a.file.localeCompare(b.file))) {
      const rel = path.relative(ROOT, m.file).replace(/\\/g, "/");
      lines.push(`*源文件：\`${rel}\`*`);
      lines.push("");
      lines.push(...renderMember(m));
    }
  }

  lines.push("---");
  lines.push("");
  lines.push(`共 **${classes.length}** 个类、**${members.length}** 个 public API。`);
  lines.push("");

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, lines.join("\n"), "utf8");
  return outFile;
}
