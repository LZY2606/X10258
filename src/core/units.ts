import type { NormalizedValue } from './types';

// SPICE 单位后缀表（大小写不敏感；meg 需先于 m 匹配）
const SUFFIXES: [string, number][] = [
  ['meg', 1e6], ['mil', 25.4e-6],
  ['t', 1e12], ['g', 1e9], ['k', 1e3],
  ['m', 1e-3], ['u', 1e-6], ['n', 1e-9], ['p', 1e-12], ['f', 1e-15],
];

const NUM_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([A-Za-z]*)$/;

// 规范化数值：原始表示保留在 raw；无法转换返回 unconvertible。
export function normalizeNumber(raw: string): NormalizedValue {
  const trimmed = raw.trim().replace(/^\{/, '').replace(/\}$/, '');
  const m = NUM_RE.exec(trimmed);
  if (!m) return { raw, unconvertible: true };
  const base = parseFloat(m[1]);
  const tail = m[2].toLowerCase();
  if (tail === '') return { raw, value: base };
  for (const [suffix, mult] of SUFFIXES) {
    if (tail === suffix) return { raw, value: base * mult, suffix };
    if (tail.startsWith(suffix)) {
      // SPICE 语义：后缀之后的字母被忽略（如 10khz -> 10k）
      return { raw, value: base * mult, suffix, ignoredTail: tail.slice(suffix.length) };
    }
  }
  return { raw, unconvertible: true };
}

export function unitFor(kind: string, param: string): string {
  const k = kind.toUpperCase();
  if (k === 'R') return 'ohm';
  if (k === 'C') return 'F';
  if (k === 'L') return 'H';
  if (k === 'V') return 'V';
  if (k === 'I') return 'A';
  if (param === 'w' || param === 'l' || param === 'wp' || param === 'wn') return 'm';
  return '';
}
