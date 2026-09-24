// 稳定身份：FNV-1a 64 位（BigInt）截断为 16 位 hex。
// 身份由"规范化内容"决定，而非插入顺序，因此导出->删库->再导入后保持不变。

export function fnv1a(input: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return h.toString(16).padStart(16, '0');
}

/** 带命名空间的稳定 id，前缀帮助人工辨认对象类型 */
export function stableId(prefix: string, ...parts: (string | number)[]): string {
  const canonical = parts.map((p) => String(p)).join('');
  return `${prefix}_${fnv1a(canonical)}`;
}

/** 数组的顺序敏感指纹（用于多值/端口顺序等） */
export function seqHash(parts: string[]): string {
  return fnv1a(parts.join(''));
}

/** 集合指纹（顺序无关，用于对称/可交换情形） */
export function setHash(parts: string[]): string {
  return fnv1a([...parts].sort().join(''));
}
