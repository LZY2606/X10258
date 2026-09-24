import type { SpiceNumber } from '../shared/types';

// SPICE 比例后缀（大小写不敏感）。'mil' 在本域中不是标准比例后缀，忽略。
const SCALE: Record<string, number> = {
  t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3,
  u: 1e-6, 'µ': 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
};

// 常见物理单位后缀：仅做基准标注，不改变量级。
const UNITS = new Set(['ohm', 'v', 'a', 'amp', 'amps', 'hz', 's', 'sec', 'w', 'f', 'h', 'deg']);

const NUM_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Zµ]+)?$/;

/**
 * 解析 SPICE 数值。
 * - 导入层保留 raw 原样；派生层才规范化到 SI。
 * - 无法转换（表达式/未知后缀）时 ok=false，原值留在原位置并给出原因，不丢弃。
 */
export function parseSpiceNumber(raw0: string): SpiceNumber {
  const raw = raw0.trim();
  const m = NUM_RE.exec(raw);
  if (!m) {
    return { ok: false, raw, reason: /[a-zA-Z]/.test(raw) ? 'expression-or-unknown-suffix' : 'not-a-number' };
  }
  const [, mantissa, suffix] = m;
  const num = Number(mantissa);
  if (!Number.isFinite(num)) return { ok: false, raw, reason: 'non-finite' };
  if (!suffix) return { ok: true, raw, value: num, basis: 'SI:dimensionless' };

  const lower = suffix.toLowerCase();
  if (lower === 'mil') {
    // mil 是英制长度，不做静默换算：保留原值并附诊断（坐标基准缺失）。
    return { ok: false, raw, unitSuffix: suffix, reason: 'non-SI-unit:mil-requires-length-basis' };
  }
  // 最长匹配：先尝试多字母比例（meg），再单字母比例 + 可选单位。
  if (lower.startsWith('meg')) {
    const rest = lower.slice(3);
    if (rest === '' || UNITS.has(rest)) {
      return { ok: true, raw, value: num * 1e6, scaleSuffix: suffix.slice(0, 3), unitSuffix: rest || undefined, basis: rest ? `SI:${rest}` : 'SI:scaled' };
    }
  }
  const scaleCh = lower[0];
  if (scaleCh in SCALE) {
    const rest = lower.slice(1);
    if (rest === '' || UNITS.has(rest)) {
      return { ok: true, raw, value: num * SCALE[scaleCh], scaleSuffix: suffix[0], unitSuffix: rest || undefined, basis: rest ? `SI:${rest}` : 'SI:scaled' };
    }
  }
  // 识别为纯物理单位（无比例），例如 100ohm
  if (UNITS.has(lower)) {
    return { ok: true, raw, value: num, unitSuffix: suffix, basis: `SI:${lower}` };
  }
  return { ok: false, raw, unitSuffix: suffix, reason: `unknown-unit-suffix:${suffix}` };
}

/** 仅做量级比较用的取值；表达式等返回 undefined。 */
export function numericValue(raw: string): number | undefined {
  const n = parseSpiceNumber(raw);
  return n.ok ? n.value : undefined;
}
