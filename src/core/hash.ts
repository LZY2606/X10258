// 无依赖稳定哈希：FNV-1a 64 + 短摘要。对象哈希按规范化 JSON（键排序），
// 保证导入/导出与进程重启后身份一致。

export function fnv1a64(input: string): string {
  let hi = 0x811c9dc5;
  let lo = 0x8422d96b >>> 0;
  const prime = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    lo ^= code & 0xff;
    hi = Math.imul(lo, prime);
    lo = (lo * prime) >>> 0;
    hi ^= code >>> 8;
    hi = (hi * prime) >>> 0;
  }
  return (hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0'));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}';
}

export function stableHash(value: unknown): string {
  return fnv1a64(stableStringify(value));
}

export function shortId(prefix: string, seed: string): string {
  return `${prefix}_${fnv1a64(seed).slice(0, 16)}`;
}
