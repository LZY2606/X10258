/**
 * 单位后缀解析：只在派生层做规范化。
 * 无法转换的值保留在原位置并附诊断，绝不为了画图丢掉。
 */

export interface NormalizedNumber {
  raw: string;
  ok: boolean;
  value?: number;        // 规范化后的 SI 数值
  suffix?: string;       // 识别到的倍率后缀（原文）
  unitNote?: string;     // 后缀之后的单位注释（如 10uF 的 F）
  diagnostic?: string;   // 无法转换时的诊断
}

/** SPICE 倍率后缀（大小写不敏感；注意 M=毫，MEG=兆，MIL=25.4u） */
const SCALE: Array<[string, number]> = [
  ['MEG', 1e6],
  ['MIL', 25.4e-6],
  ['T', 1e12],
  ['G', 1e9],
  ['K', 1e3],
  ['M', 1e-3],
  ['U', 1e-6],
  ['N', 1e-9],
  ['P', 1e-12],
  ['F', 1e-15],
];

const NUM_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([A-Za-z]*)$/;

export function normalizeNumber(raw: string): NormalizedNumber {
  const m = NUM_RE.exec(raw.trim());
  if (!m) {
    return { raw, ok: false, diagnostic: `无法解析为数值: "${raw}"，原值保留在位置` };
  }
  const base = Number(m[1]);
  if (!Number.isFinite(base)) {
    return { raw, ok: false, diagnostic: `数值溢出: "${raw}"` };
  }
  const rest = m[2];
  if (!rest) return { raw, ok: true, value: base };
  const upper = rest.toUpperCase();
  for (const [suffix, scale] of SCALE) {
    if (upper === suffix || upper.startsWith(suffix)) {
      const unitNote = upper.length > suffix.length ? rest.slice(suffix.length) : undefined;
      return { raw, ok: true, value: base * scale, suffix: rest.slice(0, suffix.length), unitNote };
    }
  }
  // 纯字母尾巴（如 10ohm、5v）：SPICE 传统上忽略单位注释，数值有效但记录
  if (/^[A-Za-z]+$/.test(rest)) {
    return { raw, ok: true, value: base, unitNote: rest };
  }
  return { raw, ok: false, diagnostic: `无法转换的单位后缀: "${raw}"，原值保留在位置` };
}

/** 数值等价比较（相对+绝对容差），不可比较时返回 null（不确定，不强行裁定） */
export function numericEqual(a: number, b: number, relTol = 1e-9, absTol = 1e-30): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= Math.max(absTol, relTol * Math.max(Math.abs(a), Math.abs(b)));
}
