import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

import { formatType } from "./format-type.js";
import {
  defaultParamDescription,
  defaultReturnDescription,
  defaultSummary,
  renderJsDocBlock,
  type JsDocBlockInput,
} from "./render-block.js";

export type ApiMember = {
  file: string;
  className?: string;
  name: string;
  kind: "method" | "function" | "constructor";
  paramNames: string[];
  params: { name: string; type: string }[];
  returnType: string;
  jsdoc: string | null;
  jsdocStart: number;
  jsdocEnd: number;
  memberStart: number;
  indent: string;
  stub: string;
  throws: boolean;
};

export type ClassDoc = {
  file: string;
  name: string;
  layer: string;
  jsdoc: string | null;
};

const ROOT = path.resolve(import.meta.dirname, "../..");
const SRC = path.join(ROOT, "src");

/**
 * 收集 src 下需文档化的 public API（排除 gen/、index.ts）。
 * @param files - 可选文件列表；省略则扫描全部
 * @returns ApiMember 列表
 */
export function scanPublicApi(files?: string[]): ApiMember[] {
  const targets =
    files ??
    walkTsFiles(SRC).filter(
      (f) => !f.includes(`${path.sep}gen${path.sep}`) && !f.endsWith(`${path.sep}index.ts`),
    );

  const program = ts.createProgram(targets, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    strict: true,
  });
  const checker = program.getTypeChecker();
  const out: ApiMember[] = [];

  for (const fileName of targets) {
    const sf = program.getSourceFile(fileName);
    if (!sf) continue;

    const visit = (node: ts.Node, className?: string) => {
      if (ts.isClassDeclaration(node) && node.name) {
        const cn = node.name.text;
        for (const member of node.members) {
          visitMember(member, fileName, cn, checker, sf, out);
        }
        return;
      }
      if (ts.isFunctionDeclaration(node) && hasExportModifier(node)) {
        visitFunctionLike(node, fileName, undefined, checker, sf, out, "function");
      }
      ts.forEachChild(node, (child) => visit(child, className));
    };

    visit(sf);
  }

  return out;
}

/**
 * 扫描 export 类的 JSDoc 摘要。
 * @param files - 可选文件列表
 * @returns ClassDoc 列表
 */
export function scanClasses(files?: string[]): ClassDoc[] {
  const targets =
    files ??
    walkTsFiles(SRC).filter(
      (f) => !f.includes(`${path.sep}gen${path.sep}`) && !f.endsWith(`${path.sep}index.ts`),
    );

  const out: ClassDoc[] = [];
  for (const fileName of targets) {
    const sf = ts.createProgram([fileName], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      strict: true,
    }).getSourceFile(fileName);
    if (!sf) continue;

    for (const stmt of sf.statements) {
      if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
      if (!hasExportModifier(stmt)) continue;
      out.push({
        file: fileName,
        name: stmt.name.text,
        layer: layerFromPath(fileName),
        jsdoc: getLeadingJsDoc(stmt, sf),
      });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** 从 src 路径解析层级目录名 */
export function layerFromPath(fileName: string): string {
  const rel = path.relative(SRC, fileName);
  const seg = rel.split(path.sep)[0];
  return seg ?? "src";
}

function visitMember(
  member: ts.ClassElement,
  fileName: string,
  className: string,
  checker: ts.TypeChecker,
  sf: ts.SourceFile,
  out: ApiMember[],
) {
  if (ts.isConstructorDeclaration(member)) {
    if (!hasPublicLikeModifier(member)) return;
    visitFunctionLike(member, fileName, className, checker, sf, out, "constructor");
    return;
  }
  if (!ts.isMethodDeclaration(member) || !member.name || !hasPublicLikeModifier(member)) {
    return;
  }
  if (ts.isPrivateIdentifier(member.name)) return;
  visitFunctionLike(member, fileName, className, checker, sf, out, "method");
}

function visitFunctionLike(
  node: ts.FunctionLikeDeclaration,
  fileName: string,
  className: string | undefined,
  checker: ts.TypeChecker,
  sf: ts.SourceFile,
  out: ApiMember[],
  kind: ApiMember["kind"],
) {
  const name =
    kind === "constructor"
      ? "constructor"
      : ts.isIdentifier(node.name!)
        ? node.name.text
        : kind === "function" && ts.isFunctionDeclaration(node) && node.name
          ? node.name.text
          : "anonymous";

  if (name.startsWith("_")) return;

  const sig = checker.getSignatureFromDeclaration(node);
  if (!sig) return;

  const params = node.parameters.map((p) => {
    const n = ts.isIdentifier(p.name) ? p.name.text : "arg";
    const t = checker.getTypeAtLocation(p);
    return { name: n, type: formatType(checker, t) };
  });

  const returnType = formatType(checker, sig.getReturnType());
  const jsdoc = getLeadingJsDoc(node, sf);
  const throws = bodyMayThrow(node);
  const memberStart = node.getStart(sf, false);
  const indent = className !== undefined ? "  " : "";

  const input: JsDocBlockInput = {
    summary: defaultSummary(name),
    params: params.map((p) => ({
      name: p.name,
      type: p.type,
      description: defaultParamDescription(p.name),
    })),
    returns: {
      type: returnType,
      description:
        kind === "constructor"
          ? `${className ?? "类"} 实例`
          : defaultReturnDescription(name, returnType),
    },
    throws: throws ? "条件不满足或 I/O 失败时" : undefined,
  };

  const jsdocRange = jsdoc ? getJsDocRange(node, sf) : null;

  out.push({
    file: fileName,
    className,
    name,
    kind,
    paramNames: params.map((p) => p.name),
    params,
    returnType,
    jsdoc,
    jsdocStart: jsdocRange?.start ?? memberStart,
    jsdocEnd: jsdocRange?.end ?? memberStart,
    memberStart,
    indent,
    stub: indentBlock(renderJsDocBlock(input), indent),
    throws,
  });
}

function bodyMayThrow(node: ts.FunctionLikeDeclaration): boolean {
  let found = false;
  const walk = (n: ts.Node) => {
    if (found) return;
    if (ts.isThrowStatement(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  if (node.body) walk(node.body);
  return found;
}

function getJsDocRange(node: ts.Node, sf: ts.SourceFile): { start: number; end: number } | null {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart());
  if (!ranges?.length) return null;
  const last = ranges[ranges.length - 1]!;
  const text = sf.text.slice(last.pos, last.end);
  if (!text.startsWith("/**")) return null;
  return { start: last.pos, end: last.end };
}

function indentBlock(block: string, indent: string): string {
  return block
    .split("\n")
    .map((line) => (line.length ? indent + line : line))
    .join("\n");
}

function getLeadingJsDoc(node: ts.Node, sf: ts.SourceFile): string | null {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart());
  if (!ranges?.length) return null;
  const last = ranges[ranges.length - 1]!;
  const text = sf.text.slice(last.pos, last.end);
  return text.startsWith("/**") ? text : null;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ||
    ts.isSourceFile(node.parent)
  );
}

function hasPublicLikeModifier(member: ts.ClassElement | ts.ParameterPropertyDeclaration): boolean {
  if (member.modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) return false;
  if (member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ProtectedKeyword)) return false;
  return true;
}

function walkTsFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkTsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      result.push(full);
    }
  }
  return result;
}

/**
 * 将 stub 写入源文件（仅缺失 JSDoc 时插入；--force 时替换）。
 * @param members - 待写入成员
 * @param force - 是否强制替换已有 JSDoc
 * @returns 修改的文件数
 */
export function writeStubs(members: ApiMember[], force: boolean): number {
  const byFile = new Map<string, ApiMember[]>();
  for (const m of members) {
    if (m.jsdoc && !force) continue;
    const list = byFile.get(m.file) ?? [];
    list.push(m);
    byFile.set(m.file, list);
  }

  let filesChanged = 0;
  for (const [file, list] of byFile) {
    let text = fs.readFileSync(file, "utf8");
    const sorted = [...list].sort((a, b) => b.memberStart - a.memberStart);

    for (const m of sorted) {
      if (m.jsdoc && force) {
        text = text.slice(0, m.jsdocStart) + m.stub + text.slice(m.jsdocEnd);
        continue;
      }
      if (!m.jsdoc) {
        text = text.slice(0, m.memberStart) + m.stub + text.slice(m.memberStart);
      }
    }

    fs.writeFileSync(file, normalizeAfterJsdocWrite(text), "utf8");
    filesChanged++;
  }

  return filesChanged;
}

/**
 * 写入 JSDoc 后整理缩进与空行。
 * @param text - 文件全文
 * @returns 整理后的全文
 */
function normalizeAfterJsdocWrite(text: string): string {
  let out = text.replace(/\*\/\n\n+(\s+(?:async\s+)?(?:public\s+|protected\s+)?[a-zA-Z_$])/g, "*/\n$1");
  out = out.replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n");
  out = out.replace(/^ {4,}(\/\*\*)/gm, "  $1");
  out = out.replace(/^ {4,}(\* @)/gm, "   $1");
  out = out.replace(/^ {4,}(\*\/)/gm, "   $1");
  return out;
}
