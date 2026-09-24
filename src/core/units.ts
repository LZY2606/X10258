import type { Quantity } from './types';

/**
 * SPICE 比例后缀（原文本保留在 raw；这里只在派生层换算）。
 * 注意 SPICE 的经典陷阱：M = 毫(1e-3)，Meg = 兆(1e6)。
 * 无法转换时保留原值并附诊断理由，不删除。
 */
const SCALES: Record<string, number> = {
  t: 1e12,
  g: 1e9,
  meg: 1e6,
  k: 1e3,
  mil: 25.4e-6,
  m: 1e-3,
  u: 1e-6,
  'µ': 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
  a: 1e-18,
};

/** 比例后缀之后的单位字母（SPICE 允许 "10k ohm"），仅记录不参与数值 */
const UNIT_TAILS = new Set([
  'ohm', 'ohms', 'ohms.', 'v', 'a', 'h', 'hz', 'f', 's', 'w',
  'deg', 'pf', 'nf', 'ff', 'uf', 'mh', 'uh', 'nh',
]);

export interface ParsedNumber {
  value: number | null;
  reason?: string;
  suffix: string | null;
  unitTail: string | null;
}

export function parseSpiceNumber(raw0: string): ParsedNumber {
  const raw = raw0.trim();
  const m = /^([0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)/.exec(raw);
  if (!m) return { value: null, reason: `not-a-number: ${raw}`, suffix: null, unitTail: null };
  const mantissa = parseFloat(m[1]);
  let rest = raw.slice(m[1].length).trim().replace(/^[*xX]\s*1/, '').trim();
  let suffix: string | null = null;
  let unitTail: string | null = null;
  if (rest.length > 0) {
    const lower = rest.toLowerCase();
    // 最长匹配：Meg / mil 优先
    const three = lower.slice(0, 3);
    if (SCALES[three] !== undefined && /^[a-zµ]/.test(rest)) {
      suffix = rest.slice(0, 3);
      rest = rest.slice(3);
    } else {
      const ch = lower[0];
      if (SCALES[ch] !== undefined) {
        suffix = rest.slice(0, 1);
        rest = rest.slice(1);
      }
    }
    const tail = rest.trim().toLowerCase();
    if (tail.length > 0) {
      if (UNIT_TAILS.has(tail) || /^(ohm[s]?|[vahfsw]|hz|deg)$/.test(tail)) {
        unitTail = tail;
      } else if (/^[a-zµ]+$/.test(tail)) {
        return { value: null, reason: `unknown-unit-tail: ${tail}`, suffix, unitTail: null };
      } else {
        return { value: null, reason: `malformed-suffix: ${tail}`, suffix, unitTail: null };
      }
    }
  }
  const scale = suffix ? SCALES[suffix.toLowerCase()] ?? 1 : 1;
  return { value: mantissa * scale, suffix, unitTail };
}

export function quantity(
  raw: string,
  expectedUnit: string,
  sourceLineId: string,
  tokenIndex: number,
): Quantity {
  const p = parseSpiceNumber(raw);
  return {
    raw,
    value: p.value,
    unit: p.value === null ? null : expectedUnit,
    status: p.value === null ? 'unresolved' : 'ok',
    reason: p.reason,
    sourceLineId,
    tokenIndex,
  };
}

/** 带容差的数值等价（对称器件/参数修订场景） */
export function sameValue(x: number, y: number, relTol = 1e-9, absTol = 1e-15): boolean {
  if (x === y) return true;
  return Math.abs(x - y) <= Math.max(absTol, relTol * Math.max(Math.abs(x), Math.abs(y)));
}
