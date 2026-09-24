// 单位后缀与数值规范化：导入层只保留原始表示，规范化仅发生在派生层。
export interface ParsedValue {
  raw: string;
  ok: boolean;
  magnitude?: number;
  suffix?: string;
  normalized?: number; // SI 值（仅派生层使用）
  diagnostic?: string;
}

const SUFFIX_SCALE: Record<string, number> = {
  T: 1e12,
  G: 1e9,
  MEG: 1e6,
  K: 1e3,
  MIL: 25.4e-6,
  M: 1e-3,
  U: 1e-6,
  N: 1e-9,
  P: 1e-12,
  F: 1e-15,
};

const VALUE_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/;

export function parseValue(raw: string): ParsedValue {
  const trimmed = raw.trim();
  const m = VALUE_RE.exec(trimmed);
  if (!m) {
    return { raw, ok: false, diagnostic: `无法转换为数值：保留原始表示 "${raw}"` };
  }
  const magnitude = Number(m[1]);
  const suffixRaw = m[2] ?? '';
  if (suffixRaw === '') {
    return { raw, ok: true, magnitude, suffix: '', normalized: magnitude };
  }
  const suffix = suffixRaw.toUpperCase();
  if (suffix in SUFFIX_SCALE) {
    return {
      raw,
      ok: true,
      magnitude,
      suffix: suffixRaw,
      normalized: magnitude * SUFFIX_SCALE[suffix],
    };
  }
  // SPICE 规则：合法后缀后允许跟随无关字母（如 1KHz）；无法识别时保留并诊断
  for (const key of Object.keys(SUFFIX_SCALE)) {
    if (suffix.startsWith(key)) {
      return {
        raw,
        ok: true,
        magnitude,
        suffix: suffixRaw,
        normalized: magnitude * SUFFIX_SCALE[key],
        diagnostic: `后缀 "${suffixRaw}" 按 "${key}" 解释，其余字母忽略`,
      };
    }
  }
  return { raw, ok: false, magnitude, suffix: suffixRaw, diagnostic: `未知单位后缀 "${suffixRaw}"，值留在原位置` };
}

/** 从参数表达式中提取标识符依赖（不展开、不求值）。 */
export function exprDependencies(expr: string): string[] {
  const deps = new Set<string>();
  const re = /[A-Za-z_][A-Za-z0-9_.]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) {
    const id = m[0];
    if (!/^(exp|log|sqrt|abs|sin|cos|tan|min|max|pow)$/i.test(id)) deps.add(id);
  }
  return [...deps].sort();
}

/** 表达式结构规范化：仅做空白/大小写无关化，用于结构比较，不替换标识符。 */
export function canonicalExpr(expr: string): string {
  return expr.replace(/\s+/g, '').replace(/^\{/, '').replace(/\}$/, '').toUpperCase();
}
