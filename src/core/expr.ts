/** 参数表达式求值：{a*b+1} 形式。求值失败不丢值，保留原文并附诊断。 */
import { parseSpiceNumber } from './units.js';

export type Env = ReadonlyMap<string, number>;

export interface EvalResult {
  raw: string;
  value: number | null;
  missing: string[];
  diagnostic?: string;
}

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] | string {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if ('+-*/^(),'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    const rest = src.slice(i);
    const numM = /^(\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[A-Za-zµ]*/.exec(rest);
    if (numM) {
      const p = parseSpiceNumber(numM[0]);
      if (p.value === null) return `bad-number:${numM[0]}`;
      toks.push({ t: 'num', v: p.value }); i += numM[0].length; continue;
    }
    const idM = /^[A-Za-z_][A-Za-z0-9_.$]*/.exec(rest);
    if (idM) { toks.push({ t: 'id', v: idM[0].toLowerCase() }); i += idM[0].length; continue; }
    return `bad-char:${c}`;
  }
  return toks;
}

export function evalExpr(src: string, env: Env): EvalResult {
  const toks = tokenize(src);
  if (typeof toks === 'string') return { raw: src, value: null, missing: [], diagnostic: toks };
  const missing: string[] = [];
  let pos = 0;
  const peek = () => toks[pos];
  const eat = () => toks[pos++];

  function parsePrim(): number {
    const t = peek();
    if (!t) throw new Error('unexpected-end');
    if (t.t === 'num') { eat(); return t.v; }
    if (t.t === 'id') {
      eat();
      const v = env.get(t.v);
      if (v === undefined) { missing.push(t.v); throw new Error(`unknown-id:${t.v}`); }
      return v;
    }
    if (t.t === 'op' && t.v === '(') { eat(); const v = parseAdd(); const c = eat(); if (!c || c.t !== 'op' || c.v !== ')') throw new Error('unbalanced'); return v; }
    if (t.t === 'op' && t.v === '-') { eat(); return -parsePrim(); }
    throw new Error(`unexpected:${t.v}`);
  }
  function parsePow(): number { const b = parsePrim(); const t = peek(); if (t && t.t === 'op' && t.v === '^') { eat(); return Math.pow(b, parsePow()); } return b; }
  function parseMul(): number { let v = parsePow(); for (;;) { const t = peek(); if (t && t.t === 'op' && (t.v === '*' || t.v === '/')) { eat(); const r = parsePow(); v = t.v === '*' ? v * r : v / r; } else return v; } }
  function parseAdd(): number { let v = parseMul(); for (;;) { const t = peek(); if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) { eat(); const r = parseMul(); v = t.v === '+' ? v + r : v - r; } else return v; } }

  try {
    const v = parseAdd();
    if (pos !== toks.length) return { raw: src, value: null, missing, diagnostic: 'trailing-tokens' };
    return { raw: src, value: v, missing };
  } catch (e) {
    return { raw: src, value: null, missing, diagnostic: String((e as Error).message) };
  }
}

/** 参数值求值：支持 {expr}、纯数字（带单位后缀）、裸标识符引用。 */
export function evalParam(raw: string, env: Env): EvalResult {
  const trimmed = raw.trim();
  const brace = /^\{([\s\S]*)\}$/.exec(trimmed);
  if (brace) return { ...evalExpr(brace[1]!, env), raw };
  const asNum = parseSpiceNumber(trimmed);
  if (asNum.value !== null && !asNum.diagnostic) return { raw, value: asNum.value, missing: [] };
  if (asNum.value !== null && asNum.diagnostic) return { raw, value: asNum.value, missing: [], diagnostic: asNum.diagnostic };
  const ref = env.get(trimmed.toLowerCase());
  if (ref !== undefined) return { raw, value: ref, missing: [] };
  return { raw, value: null, missing: [trimmed.toLowerCase()], diagnostic: `unconvertible: ${raw}` };
}
