import { createHash } from "node:crypto";

/**
 * 稳定身份：对同一逻辑内容产生同一 id（内容寻址），
 * 这样导出→删库→导入后身份保持不变。
 */
export function stableId(scope: string, parts: (string | number)[]): string {
  const h = createHash("sha256");
  h.update(scope);
  h.update("::");
  h.update(parts.join("|"));
  return `${scope}_${h.digest("hex").slice(0, 16)}`;
}

export function seqId(scope: string, n: number): string {
  return `${scope}#${n}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function canonicalName(name: string): string {
  return name.toLowerCase();
}
