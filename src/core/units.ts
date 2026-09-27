import type { UnitRef } from './types';

/**
 * SPICE 比例后缀（大小写不敏感），标准约定：
 *   T=1e12 G=1e9 MEG=1e6 K=1e3 MIL/m/u/n/p/f
 * 单字母 M 在 SPICE 中是 milli（1e-3），兆必须写 MEG —— 此差异必须保留语义。
 * 紧随其后的传统单位字母（OHM、VOLT、AMP、FARAD、HENRY...）仅作文本被吞掉。
 * 无法转换时 si=null 并附诊断，原始 token 留在原处。
 */
const SCALE: Record<string, number> = {
  t: 1e12,
  g: 1e9,
  meg: 1e6,
  k: 1e3,
  mil: 25.4e-6,
  m: 1e-3,
  u: 1e-6,
  µ: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
  // 显式无量纲
  '': 1,
};

const UNIT_WORDS = [
  'ohm',
  'ohms',
  'volt',
  'volts',
  'v',
  'amp',
  'amps',
  'a',
  'farad',
  'farads',
  'henry',
  'henries',
  'hz',
  'deg',
  '',
];

export interface ParseNumberResult {
  numeric: number | null;
  unit: UnitRef;
  diagnostic: string | null;
}

const NUMBER_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(.*)$/;

export function parseSpiceNumber(rawToken: string): ParseNumberResult {
  const raw = rawToken.trim();
  const m = NUMBER_RE.exec(raw);
  if (!m) {
    return {
      numeric: null,
      unit: { si: null, unit: '', suffix: null },
      diagnostic: `not-a-number: "${rawToken}"`,
    };
  }
  const mantissa = m[1];
  let rest = m[2].trim();
  let suffix: string | null = null;
  let scale = 1;

  if (rest.length > 0) {
    const lower = rest.toLowerCase();
    // 优先匹配多字符后缀（MEG/MIL）
    const three = lower.slice(0, 3);
    const one = lower.slice(0, 1);
    if (three === 'meg' || three === 'mil') {
      suffix = rest.slice(0, 3);
      scale = SCALE[three];
      rest = rest.slice(3);
    } else if (Object.prototype.hasOwnProperty.call(SCALE, one)) {
      suffix = rest.slice(0, 1);
      scale = SCALE[one];
      rest = rest.slice(1);
    }
    // 剩余的传统单位文本：识别则吞，不识别则诊断但仍返回数值
    const trailing = rest.trim().toLowerCase();
    if (trailing.length > 0 && !UNIT_WORDS.includes(trailing)) {
      return {
        numeric: Number(mantissa) * scale,
        unit: { si: Number(mantissa) * scale, unit: '', suffix },
        diagnostic: `unrecognized-unit-word: "${rest}" in "${rawToken}"`,
      };
    }
  }

  const value = Number(mantissa) * scale;
  return {
    numeric: value,
    unit: { si: value, unit: '', suffix },
    diagnostic: null,
  };
}

/** 比较两个带后缀数值：规范化后相等即等价（如 2.2k == 2200） */
export function numberEquivalent(a: number | null, b: number | null, relTol = 1e-9): boolean {
  if (a === null || b === null) return false;
  if (a === b) return true;
  const denom = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / denom <= relTol;
}
