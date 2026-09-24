/** SPICE 单位后缀解析。原始文本永不改写；解析结果另存。 */
export const UNIT_SUFFIXES: Record<string, number> = {
  t: 1e12, g: 1e9, meg: 1e6, k: 1e3, mil: 25.4e-6,
  m: 1e-3, u: 1e-6, 'µ': 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
};

export interface ParsedNumber {
  raw: string;
  value: number | null;
  suffix: string | null;
  trailing: string | null;
  diagnostic?: string;
}

const NUM_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([A-Za-zµ]*)$/;

export function parseSpiceNumber(raw: string): ParsedNumber {
  const m = NUM_RE.exec(raw.trim());
  if (!m) return { raw, value: null, suffix: null, trailing: null, diagnostic: `not-a-number: ${raw}` };
  const [, mantissa, letters] = m;
  const base = Number(mantissa);
  if (letters.length === 0) return { raw, value: base, suffix: null, trailing: null };
  const lower = letters.toLowerCase();
  // SPICE 规则：取能匹配的最长已知后缀，其余尾随字符忽略但保留记录。
  for (const len of [3, 2, 1]) {
    const head = lower.slice(0, len);
    if (head in UNIT_SUFFIXES) {
      const trailing = letters.slice(len) || null;
      return { raw, value: base * UNIT_SUFFIXES[head], suffix: head, trailing };
    }
  }
  // 未知后缀：按 SPICE 惯例忽略单位字母但给出诊断，值留在原位置。
  return { raw, value: base, suffix: null, trailing: letters, diagnostic: `unknown-suffix-ignored: ${letters}` };
}
