#!/usr/bin/env tsx
/**
 * GeoClaw JSDoc 生成与校验 CLI。
 *
 * 用法：
 *   npm run jsdoc:gen [-- --write] [-- --force] [file...]
 *   npm run jsdoc:check [file...]
 */

import path from "node:path";

import { exportJsDocMarkdown } from "./jsdoc/export-markdown.js";
import { scanPublicApi, writeStubs } from "./jsdoc/scan-api.js";
import { validateJsDocBlock } from "./jsdoc/render-block.js";

const args = process.argv.slice(2);
const command =
  args[0] === "check"
    ? "check"
    : args[0] === "gen"
      ? "gen"
      : args[0] === "md"
        ? "md"
        : null;

if (!command) {
  console.error(`用法:
  tsx scripts/jsdoc-cli.ts gen [--write] [--force] [src/...]
  tsx scripts/jsdoc-cli.ts check [src/...]
  tsx scripts/jsdoc-cli.ts md [--out docs/API.md]`);
  process.exit(1);
}

const rest = args.slice(1);

if (command === "md") {
  const outIdx = rest.indexOf("--out");
  const outFile =
    outIdx >= 0 && rest[outIdx + 1]
      ? path.resolve(rest[outIdx + 1]!)
      : undefined;
  const written = exportJsDocMarkdown(outFile);
  console.log(`已导出：${written}`);
  process.exit(0);
}

const write = rest.includes("--write");
const force = rest.includes("--force");
const files = rest.filter((a) => !a.startsWith("--")).map((f) => path.resolve(f));

if (command === "gen") {
  const members = scanPublicApi(files.length ? files : undefined);
  if (!write) {
    for (const m of members) {
      const label = m.className ? `${m.className}.${m.name}` : m.name;
      console.log(`\n// ${path.relative(process.cwd(), m.file)} :: ${label}`);
      console.log(m.stub);
    }
    console.log(`\n共 ${members.length} 个 public API`);
    process.exit(0);
  }

  const changed = writeStubs(members, force);
  console.log(`已写入 ${changed} 个文件（force=${force}）`);
  process.exit(0);
}

const members = scanPublicApi(files.length ? files : undefined);
let errors = 0;

for (const m of members) {
  const label = m.className ? `${m.className}.${m.name}` : m.name;
  const rel = path.relative(process.cwd(), m.file);

  if (!m.jsdoc) {
    console.error(`[缺失] ${rel} :: ${label}`);
    errors++;
    continue;
  }

  const issues = validateJsDocBlock(m.jsdoc, m.paramNames, { kind: m.kind });
  if (issues.length) {
    console.error(`[不合规] ${rel} :: ${label}`);
    for (const i of issues) {
      console.error(`  - ${i}`);
    }
    errors++;
  }
}

if (errors) {
  console.error(`\nJSDoc 校验失败：${errors} 处`);
  console.error("运行 npm run jsdoc:gen -- --write 生成缺失注释");
  console.error("运行 npm run jsdoc:gen -- --write --force 按标准格式重写");
  process.exit(1);
}

console.log(`JSDoc 校验通过：${members.length} 个 public API`);
process.exit(0);
