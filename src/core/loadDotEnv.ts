import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * 从项目根 `.env` 加载本地密钥到 `process.env`（不覆盖已有环境变量）。
 * 文件不存在则静默跳过；勿把 `.env` 提交进仓库。
 * @param packageRoot - 输入：`string` — 项目根绝对路径
 * @param relPath - 输入：`string` — 相对根的 env 文件名，默认 `.env`
 * @returns 输出：`boolean` — 是否成功读到文件
 */
export function loadDotEnv(packageRoot: string, relPath = ".env"): boolean {
  const abs = isAbsolute(relPath) ? relPath : join(packageRoot, relPath);
  if (!existsSync(abs)) {
    return false;
  }
  const text = readFileSync(abs, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return true;
}
