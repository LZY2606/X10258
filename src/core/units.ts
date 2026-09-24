// 单位后缀处理仅在“派生层”发生；原始后缀始终保留在 raw 字段。
// SPICE 数值：数字 + 可选标准比例后缀 + 可选工程单位文本（被忽略，仅记录）。

const SCALE: Record<string, number> = {
  t: 1e12, g: 1e9, meg: 1e6, k: 1e3, "": 1,
  m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15
};

export function basisForContext(context: string): string {
  const c = context.toLowerCase();
  if (c === "r" || c === "resistance") return "resistance:ohm";
  if (c === "c" || c === "capacitance") return "capacitance:F";
  if (c === "l" || c === "inductance") return "inductance:H";
  if (c === "freq" || c === "frequency") return "frequency:Hz";
  if (c === "v" || c === "voltage") return "voltage:V";
  if (c === "i" || c === "current") return "current:A";
  if (c === "time") return "time:s";
  return "dimensionless";
}

const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/;

export interface ParsedSuffix {
  siValue: number | null;
  unitSuffix: string;
  diagnostic: string | null;
}

/**
 * 解析 “10k”、“2.2uF”、“1Meg”、“3GHz”、“0.001” 等。
 * 无法转换（含表达式/未知后缀）时 siValue=null，原文留在调用处。
 */
export function parseSpiceNumber(raw: string): ParsedSuffix {
  const s = raw.trim();
  const m = NUM_RE.exec(s);
  if (!m) return { siValue: null, unitSuffix: s, diagnostic: `not-a-literal: ${s}` };
  const num = Number(m[0]);
  const rest = s.slice(m[0].length);
  if (rest === "") return { siValue: num, unitSuffix: "", diagnostic: null };
  const lower = rest.toLowerCase();
  if (lower.startsWith("meg")) {
    return { siValue: num * 1e6, unitSuffix: rest, diagnostic: null };
  }
  const scaleLetter = lower[0]!;
  if (scaleLetter in SCALE) {
    const scale = SCALE[scaleLetter]!;
    return { siValue: num * scale, unitSuffix: rest, diagnostic: null };
  }
  return { siValue: null, unitSuffix: rest, diagnostic: `unknown-scale-suffix: ${rest}` };
}

/** 提取表达式自由变量（参数依赖），排除函数名/关键字/数值。 */
export function freeVariables(expr: string, knownParams: Set<string>): string[] {
  const ids = expr.match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? [];
  const builtins = new Set([
    "abs", "sqrt", "min", "max", "pow", "exp", "log", "log10", "sin", "cos", "tan",
    "if", "then", "else", "and", "or", "not", "pi", "less", "greater", "equal",
    "asin", "acos", "atan", "atan2", "floor", "ceil", "int", "limit", "pwr", "pwrs"
  ]);
  const out = new Set<string>();
  for (const id of ids) {
    const key = id.toLowerCase();
    if (!builtins.has(key) && !/^\d/.test(id) && !knownParams.has(key)) out.add(key);
  }
  return [...out].sort();
}
