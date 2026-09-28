/**
 * SPICE 单位后缀解析。
 * 原则：导入层保留原始表示（raw），规范化只发生在派生层；
 * 无法转换的值留在原位置并附诊断，绝不为了画图丢弃。
 */
export interface UnitValue {
  raw: string;                 // 原始文本，不改写
  normalized?: number;         // 派生层规范化结果（SI）
  diagnostic?: string;         // 无法转换时的诊断
}

const SUFFIXES: Record<string, number> = {
  t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3,
  u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, mil: 25.4e-6,
};

const NUM_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/;

export function parseUnitValue(raw: string): UnitValue {
  const trimmed = raw.trim();
  const m = NUM_RE.exec(trimmed);
  if (!m) {
    return { raw, diagnostic: `无法解析为数值: "${raw}"，保留原始表示` };
  }
  const base = parseFloat(m[1]!);
  const suffix = (m[2] ?? '').toLowerCase();
  if (suffix === '') return { raw, normalized: base };
  // SPICE 规则：后缀取最长匹配（meg 优先于 m），其余字母被忽略但记录
  const key = Object.keys(SUFFIXES)
    .filter((k) => suffix.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (!key) {
    return { raw, diagnostic: `未知单位后缀 "${m[2]}"，保留原始表示` };
  }
  const trailing = suffix.slice(key.length);
  const value: UnitValue = { raw, normalized: base * SUFFIXES[key]! };
  if (trailing) value.diagnostic = `后缀 "${m[2]}" 中 "${trailing}" 部分按 SPICE 规则忽略`;
  return value;
}

/** 判断是否为表达式（{...}）——表达式不在导入层求值 */
export function isExpression(raw: string): boolean {
  const t = raw.trim();
  return t.startsWith('{') && t.endsWith('}');
}

/** 提取表达式依赖的标识符（参数作用域依赖边，不可压平） */
export function expressionDeps(raw: string): string[] {
  const t = raw.trim();
  if (!isExpression(t)) return [];
  const inner = t.slice(1, -1);
  const ids = inner.match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? [];
  const builtins = new Set(['exp', 'log', 'sqrt', 'sin', 'cos', 'tan', 'abs', 'min', 'max', 'pow']);
  return [...new Set(ids.filter((i) => !builtins.has(i.toLowerCase())))];
}
