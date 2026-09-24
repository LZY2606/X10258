import { createHash } from "node:crypto";

/** 内容寻址稳定身份（跨导出/删除/导入保持不变）。 */
export function cid(prefix: string, material: string): string {
  return `${prefix}:${createHash("sha1").update(material).digest("hex").slice(0, 16)}`;
}

export function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

export function upperName(s: string): string {
  return s.toUpperCase();
}

/** SPICE 数值后缀因子。仅在派生层使用；原始 token 始终另存。
 *  ngspice 约定：t=1e12 g=1e9 meg=1e6 k=1e3 mil=25.4e-6 m=1e-3 u/μ=1e-6
 *  n=1e-9 p=1e-12 f=1e-15；裸 M 按毫（1e-3）；单位字符（ohm/v/a/s/h/f）忽略。 */
export const SUFFIX_FACTORS: Record<string, number> = {
  t: 1e12,
  g: 1e9,
  meg: 1e6,
  k: 1e3,
  mil: 25.4e-6,
  m: 1e-3,
  u: 1e-6,
  "\u00b5": 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15
};

const UNIT_WORDS = new Set([
  "ohm",
  "ohms",
  "v",
  "volt",
  "volts",
  "a",
  "amp",
  "amps",
  "s",
  "sec",
  "secs",
  "h",
  "henry",
  "henrys",
  "f",
  "farad",
  "farads",
  "hz",
  "deg",
  ""
]);

export interface ParsedNumber {
  value: number | null;
  factor: number;
  scaleSuffix: string | null;
  unitWord: string | null;
  numericPart: string;
  diagnostic: string | null;
}

/** 解析 `4.7k` / `1MEGOHM` / `2.2uF` / `100` / `33MIL`。
 *  长后缀优先（meg/mil 先于 m），裸 M→milli。无法转换时 value=null 并附诊断。 */
export function parseSpiceNumber(raw: string): ParsedNumber {
  const trimmed = raw.trim();
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(.*)$/.exec(trimmed);
  if (!m) {
    return {
      value: null,
      factor: 1,
      scaleSuffix: null,
      unitWord: null,
      numericPart: "",
      diagnostic: `无法转换为数值（保留原位置）: "${raw}"`
    };
  }
  const numericPart = m[1];
  let rest = m[2].trim();
  let lower = rest.toLowerCase();
  let scaleSuffix: string | null = null;
  let factor = 1;

  const tryOrder = ["meg", "mil", "t", "g", "k", "m", "u", "\u00b5", "n", "p", "f"];
  for (const suf of tryOrder) {
    if (lower.startsWith(suf)) {
      scaleSuffix = rest.slice(0, suf.length);
      factor = SUFFIX_FACTORS[suf];
      rest = rest.slice(suf.length);
      lower = rest.toLowerCase();
      break;
    }
  }
  let unitWord: string | null = null;
  const unit = rest.trim();
  if (unit.length > 0) {
    if (UNIT_WORDS.has(unit.toLowerCase())) {
      unitWord = unit;
    } else {
      return {
        value: null,
        factor,
        scaleSuffix,
        unitWord: unit,
        numericPart,
        diagnostic: `未识别单位词 "${unit}"（原始后缀保留，不参与规范化）`
      };
    }
  }
  const base = Number(numericPart);
  if (Number.isNaN(base)) {
    return {
      value: null,
      factor,
      scaleSuffix,
      unitWord,
      numericPart,
      diagnostic: `数值部分非法: "${numericPart}"`
    };
  }
  return { value: base * factor, factor, scaleSuffix, unitWord, numericPart, diagnostic: null };
}

export function groupBy<T>(arr: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of arr) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}

export function sortStable<T>(arr: T[], key: (t: T) => string): T[] {
  return [...arr].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
}

export function stableStringify(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(",")}]`;
  const obj = x as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
