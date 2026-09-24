// SPICE 数值后缀。原始层不改写；派生层规范化为 SI。
// 无法转换的值保留原文并附诊断。
import type { Diagnostic, TextSpan } from '../shared/types.js';

// SPICE 标准量级后缀（大小写不敏感；忽略紧随的工程单位字母如 OHM、V）
export const SPICE_SCALE: Record<string, number> = {
  t: 1e12, g: 1e9, meg: 1e6, k: 1e3,
  m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
};

const NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/;

export interface ParsedSpiceNumber {
  ok: boolean;
  raw: string;
  numericPart?: string;
  scaleSuffix?: string;
  unitTail?: string;
  normalizedSi?: number;
  diagnostic?: Diagnostic;
}

export function parseSpiceNumber(raw: string, span?: TextSpan): ParsedSpiceNumber {
  const token = raw.trim();
  const match = NUMBER_RE.exec(token);
  if (!match || match.index !== 0) {
    return {
      ok: false,
      raw,
      diagnostic: {
        code: 'UNRESOLVED_VALUE',
        severity: 'warning',
        message: `值无法转换，保留原文: "${raw}"`,
        span,
        value: raw,
      },
    };
  }
  const numericPart = match[0];
  let rest = token.slice(numericPart.length).toLowerCase();
  let scale = 1;
  let scaleSuffix: string | undefined;
  if (rest.startsWith('meg')) {
    scale = 1e6;
    scaleSuffix = 'meg';
    rest = rest.slice(3);
  } else if (rest.length > 0 && /^[a-z]/.test(rest)) {
    const ch = rest[0]!;
    if (ch in SPICE_SCALE) {
      scale = SPICE_SCALE[ch]!;
      scaleSuffix = ch;
      rest = rest.slice(1);
    } else if (ch === 'e' || ch === 'a') {
      // 'e' 已在指数中消费；'a' 仅作单位字母（如 amp）忽略
      rest = rest.slice(1);
    }
  }
  // 剩余必须是单位字母（ohm/v/a/s/h/f...）或为空，否则为无法识别后缀
  let unitTail: string | undefined;
  if (rest.length > 0) {
    if (/^[a-z%]+$/.test(rest)) {
      unitTail = rest;
    } else {
      return {
        ok: false,
        raw,
        numericPart,
        diagnostic: {
          code: 'BAD_UNIT_SUFFIX',
          severity: 'warning',
          message: `值后缀无法识别，保留原文: "${raw}"`,
          span,
          value: raw,
        },
      };
    }
  }
  return {
    ok: true,
    raw,
    numericPart,
    scaleSuffix,
    unitTail,
    normalizedSi: Number(numericPart) * scale,
  };
}
