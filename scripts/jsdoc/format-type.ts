import ts from "typescript";

const PRIMITIVE: Record<number, string> = {
  [ts.TypeFlags.String]: "string",
  [ts.TypeFlags.Number]: "number",
  [ts.TypeFlags.Boolean]: "boolean",
  [ts.TypeFlags.Void]: "void",
  [ts.TypeFlags.Undefined]: "undefined",
  [ts.TypeFlags.Null]: "null",
  [ts.TypeFlags.BigInt]: "bigint",
  [ts.TypeFlags.Unknown]: "unknown",
  [ts.TypeFlags.Any]: "any",
};

/**
 * 将 TypeScript 类型格式化为扁平字符串（最多 2 层，避免深层嵌套）。
 * @param checker - 类型检查器
 * @param type - 待格式化类型
 * @param depth - 当前递归深度
 * @returns 类型名字符串
 */
export function formatType(checker: ts.TypeChecker, type: ts.Type, depth = 0): string {
  if (depth > 2) {
    return typeAliasOrObjectName(checker, type) ?? "object";
  }

  if (type.flags & ts.TypeFlags.TypeParameter) {
    const symbol = type.getSymbol();
    return symbol?.getName() ?? "T";
  }

  for (const flag of Object.keys(PRIMITIVE).map(Number)) {
    if (type.flags & flag) {
      return PRIMITIVE[flag]!;
    }
  }

  if (checker.isArrayType(type)) {
    const ref = type as ts.TypeReference;
    const args = checker.getTypeArguments(ref);
    const inner = args[0] ? formatType(checker, args[0], depth + 1) : "unknown";
    return `${inner}[]`;
  }

  if (type.isUnion()) {
    const parts = type.types
      .map((t) => formatType(checker, t, depth + 1))
      .filter((v, i, a) => a.indexOf(v) === i);
    if (parts.length <= 4) {
      return parts.join(" | ");
    }
    return `${parts.slice(0, 3).join(" | ")} | …`;
  }

  if (type.isIntersection()) {
    const parts = type.types.map((t) => formatType(checker, t, depth + 1));
    if (parts.length <= 2) {
      return parts.join(" & ");
    }
    return `${parts[0]} & …`;
  }

  const symbol = type.getSymbol();
  if (symbol?.getName() === "Promise") {
    const ref = type as ts.TypeReference;
    const args = checker.getTypeArguments(ref);
    if (args[0]) {
      return `Promise<${formatType(checker, args[0], depth + 1)}>`;
    }
    return "Promise<void>";
  }

  const named = typeAliasOrObjectName(checker, type);
  if (named) {
    return named;
  }

  if (checker.typeToString(type).includes("{")) {
    return "object";
  }

  return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
}

function typeAliasOrObjectName(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  const symbol = type.getSymbol() ?? type.aliasSymbol;
  if (symbol) {
    const name = symbol.getName();
    if (name && name !== "__type") {
      return name;
    }
  }
  const str = checker.typeToString(type);
  const match = str.match(/^([A-Z][A-Za-z0-9_]*)$/);
  return match?.[1];
}
