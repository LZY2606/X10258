// 派生层：单位后缀与数量规范化。
// 原始 token 永远保留；无法转换时 number=null，诊断随对象留在原位置。
import type { Diagnostic, Quantity, UnitTag } from './types.js';

// SPICE 标准倍率（大小写不敏感的单字母；MEG/MIL 多字母）
const SCALE: Record<string, number> = {
  t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6,
  n: 1e-9, p: 1e-12, f: 1e-15,
  meg: 1e6, mil: 25.4e-6
};

const UNIT_WORDS: Record<UnitTag['context'], string[]> = {
  resistance: ['ohm', 'ohms', 'r'],
  capacitance: ['f', 'farad', 'farads'],
  inductance: ['h', 'henry', 'henries'],
  voltage: ['v', 'volt', 'volts', 'vd', 'vi'],
  current: ['a', 'amp', 'amps', 'ma'],
  frequency: ['hz', 'khz', 'mhz'],
  time: ['s', 'sec', 'secs', 'ms?'],
  length: ['m', 'meter', 'meters'],
  generic: [],
  unconvertible: []
};

function isUnitWord(word: string, ctx: UnitTag['context']): boolean {
  const w = word.toLowerCase();
  if (UNIT_WORDS[ctx].includes(w)) return true;
  // 已知领域单位（跨域时仅作“可识别词”）
  return Object.values(UNIT_WORDS).some((list) => list.includes(w));
}

const NUMBER = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([A-Za-z]*)$/;

export function parseQuantity(rawToken: string, context: UnitTag['context']): Quantity {
  const diagnostics: Diagnostic[] = [];
  const match = NUMBER.exec(rawToken);
  if (!match) {
    return bad(rawToken, context, 'qty-not-number',
      `无法把 "${rawToken}" 转换为数值，保留原表示`);
  }
  const numPart = match[1];
  const tail = match[2] ?? '';
  let scale: number | null = null;
  let unitWord: string | null = null;

  if (tail === '') {
    scale = 1;
  } else {
    const low = tail.toLowerCase();
    let rest = '';
    if (low.startsWith('meg')) { scale = SCALE.meg; rest = tail.slice(3); }
    else if (low.startsWith('mil')) { scale = SCALE.mil; rest = tail.slice(3); }
    else {
      const first = low[0];
      // 电容语境下，单字母 f/F 视为单位“法拉”，而非 SPICE 的飞倍率
      if (first === 'f' && tail.length === 1 && context === 'capacitance') {
        scale = 1; unitWord = tail;
      } else if (first in SCALE) {
        scale = SCALE[first]; rest = tail.slice(1);
      } else if (isUnitWord(tail, context)) {
        scale = 1; unitWord = tail;
      } else {
        return bad(rawToken, context, 'qty-unknown-suffix',
          `未知单位后缀 "${tail}"，值留在原位置不规范化`);
      }
      if (rest) unitWord = rest || null;
    }
    if (unitWord && !isUnitWord(unitWord, context)) {
      diagnostics.push({
        level: 'warning', code: 'qty-unit-domain-mismatch',
        message: `单位词 "${unitWord}" 与语境 ${context} 不一致，按 SPICE 规则忽略单位词，仅采用倍率`
      });
    }
  }

  const base = Number(numPart);
  if (!Number.isFinite(base)) {
    return bad(rawToken, context, 'qty-not-finite', `数值 "${rawToken}" 非有限数`);
  }
  const unit: UnitTag = {
    context, scaleFactor: scale, unitWord
  };
  return {
    rawToken, number: base * (scale ?? 1), unit,
    suffixRaw: tail || null, ok: true, diagnostics
  };
}

function bad(rawToken: string, context: UnitTag['context'], code: string, message: string): Quantity {
  return {
    rawToken, number: null,
    unit: { context, scaleFactor: null, unitWord: null },
    suffixRaw: null, ok: false,
    diagnostics: [{ level: 'error', code, message }]
  };
}

/** 等价比较：规范化 SI 值容差比较；任一不可转换则回退到原文比较。 */
export function quantitiesEqual(a: Quantity, b: Quantity, relTol = 1e-9): boolean {
  if (a.ok && b.ok && a.number !== null && b.number !== null) {
    const denom = Math.max(1, Math.abs(a.number), Math.abs(b.number));
    return Math.abs(a.number - b.number) / denom <= relTol;
  }
  return a.rawToken === b.rawToken;
}
