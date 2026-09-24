/** SPICE 单位后缀。解析保留原文；规范化只在派生层调用。 */
const SUFFIXES: Record<string, number> = {
  t: 1e12, g: 1e9, meg: 1e6, k: 1e3,
  m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
  mil: 25.4e-6
};

export interface UnitParse {
  mantissa: number;
  suffix: string;      // 规范化后的后缀键
  scale: number;
  value: number;       // 规范化到 SI
}

/** 尝试把 "2.2meg"、"10u"、"5mil"、"1e3" 规范化为 SI 数值；失败返回 null。 */
export function parseSpiceNumber(raw: string): UnitParse | null {
  const m = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/.exec(raw.trim());
  if (!m) return null;
  const mantissa = Number(m[1]);
  if (!Number.isFinite(mantissa)) return null;
  let suffix = (m[2] ?? '').toLowerCase();
  let scale = 1;
  if (suffix) {
    if (suffix.startsWith('meg')) { suffix = 'meg'; scale = SUFFIXES.meg; }
    else if (suffix.startsWith('mil')) { suffix = 'mil'; scale = SUFFIXES.mil; }
    else {
      const first = suffix[0];
      if (!(first in SUFFIXES)) return null;
      scale = SUFFIXES[first];
      suffix = first;
    }
  }
  return { mantissa, suffix, scale, value: mantissa * scale };
}
