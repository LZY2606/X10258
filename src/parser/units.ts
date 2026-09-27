/**
 * 单位后缀（SPICE scale suffixes）。
 *
 * 关键语义：原始层永远保留 `raw`（如 "10k", "2.2uF", "3.3MEG"）。
 * 派生层才尝试转换；无法转换时返回 null 并由调用方附诊断，原值留在原位置，绝不删除。
 */

export interface Quantity {
  /** 逐字数字部分（含后缀前的全部字符）。 */
  raw: string;
  /** 纯数值部分。 */
  numericPart: string;
  /** 后缀逐字（可能是多字符如 MEG）。 */
  suffixRaw: string;
  /** 该字段在 SPICE 中允许的工程单位类别（用于诊断，不做强约束）。 */
  unitHint?: string;
  /** 派生：换算倍数；无法识别后缀时为 null。 */
  factor: number | null;
  /** 派生：numericPart * factor；不可转换为 null。 */
  value: number | null;
  /** 派生：基准单位标签（推断，仅用于展示）。 */
  baseUnit: string | null;
}

// SPICE 标准倍乘后缀（大小写不敏感）。注意 m=毫、MEG=兆 的经典陷阱。
const SCALE: Record<string, number> = {
  t: 1e12,
  g: 1e9,
  meg: 1e6,
  k: 1e3,
  m: 1e-3,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
  mil: 25.4e-6,
};

// 工程单位词（后缀中倍乘之后出现），保留为基准单位推断。
const UNIT_WORDS = new Set([
  'ohm', 'ohms', 'v', 'a', 'amp', 'amps', 'hz', 's', 'sec', 'secs',
  'f', 'farad', 'h', 'henry', 'henries', 'w', 'deg', 'c',
]);

const NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/;

export function parseQuantity(rawToken: string, unitHint?: string): Quantity {
  const raw = rawToken;
  const m = raw.match(NUMBER_RE);
  if (!m) {
    return { raw, numericPart: raw, suffixRaw: '', unitHint, factor: null, value: null, baseUnit: null };
  }
  const numericPart = m[0];
  let rest = raw.slice(numericPart.length);
  let factor: number | null = 1;
  let baseUnit: string | null = null;

  if (rest.length > 0) {
    const lower = rest.toLowerCase();
    // 优先匹配多字符倍乘 MEG / MIL。
    let matchedScale = '';
    for (const scaleWord of ['meg', 'mil']) {
      if (lower.startsWith(scaleWord)) {
        matchedScale = scaleWord;
        break;
      }
    }
    if (matchedScale) {
      factor = SCALE[matchedScale];
      rest = rest.slice(matchedScale.length);
    } else {
      const first = lower[0];
      if (first && Object.prototype.hasOwnProperty.call(SCALE, first)) {
        factor = SCALE[first];
        matchedScale = first;
        rest = rest.slice(1);
      } else {
        // 没有倍乘后缀；尝试把整段当单位词。
        factor = 1;
      }
    }
    const unitWord = rest.toLowerCase();
    if (unitWord === '' ) {
      baseUnit = null;
    } else if (UNIT_WORDS.has(unitWord)) {
      baseUnit = canonicalUnit(unitWord);
    } else {
      // 既不是倍乘也不是已知单位词：无法转换，原值保留。
      factor = null;
      baseUnit = null;
    }
  }

  let value: number | null = null;
  const num = Number(numericPart);
  if (factor !== null && Number.isFinite(num)) {
    value = num * factor;
  }
  return { raw, numericPart, suffixRaw: raw.slice(numericPart.length), unitHint, factor, value, baseUnit };
}

function canonicalUnit(word: string): string | null {
  switch (word) {
    case 'ohm':
    case 'ohms':
      return 'Ω';
    case 'v':
      return 'V';
    case 'a':
    case 'amp':
    case 'amps':
      return 'A';
    case 'hz':
      return 'Hz';
    case 's':
    case 'sec':
    case 'secs':
      return 's';
    case 'f':
    case 'farad':
      return 'F';
    case 'h':
    case 'henry':
    case 'henries':
      return 'H';
    case 'w':
      return 'W';
    case 'deg':
    case 'c':
      return '°';
    default:
      return null;
  }
}

/** 把派生值连同基准单位/基准坐标呈现；无法转换时返回 null（调用方保留 raw）。 */
export function formatNormalized(q: Quantity): string | null {
  if (q.value === null) return null;
  return `${q.value}${q.baseUnit ? ' ' + q.baseUnit : ''}`;
}
