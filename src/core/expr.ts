// 参数表达式：词法 + 递归下降解析；保留原始字符串；支持依赖名提取与安全求值。
// 无法解析的表达式返回 null expr + 诊断，不丢弃。
import type { Diagnostic, Expr } from './types.js';
import { parseQuantity } from './quantity.js';

const FUNCS = new Set([
  'abs', 'sqrt', 'sin', 'cos', 'tan', 'exp', 'log', 'log10', 'min', 'max',
  'pow', 'floor', 'ceil', 'int', 'if', 'pwr'
]);
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Tok =
  | { k: 'num'; v: string }
  | { k: 'name'; v: string }
  | { k: 'op'; v: string }
  | { k: 'lp' } | { k: 'rp' } | { k: 'comma' };

function lex(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch) || ((ch === '+' || ch === '-') && /[0-9.]/.test(s[i + 1] ?? '') &&
        (out.length === 0 || (out[out.length - 1].k === 'op') || out[out.length - 1].k === 'lp' ||
         out[out.length - 1].k === 'comma'))) {
      let j = i + 1;
      while (j < s.length && /[0-9.a-zA-Z]/.test(s[j])) j++;
      out.push({ k: 'num', v: s.slice(i, j) });
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_.]/.test(s[j])) j++;
      out.push({ k: 'name', v: s.slice(i, j) });
      i = j; continue;
    }
    if ('()'.includes(ch)) { out.push(ch === '(' ? { k: 'lp' } : { k: 'rp' }); i++; continue; }
    if (ch === ',') { out.push({ k: 'comma' }); i++; continue; }
    const two = s.slice(i, i + 2);
    if (['**', '>=', '<=', '==', '!=', '&&', '||'].includes(two)) {
      out.push({ k: 'op', v: two }); i += 2; continue;
    }
    if ('+-*/<>'.includes(ch)) { out.push({ k: 'op', v: ch }); i++; continue; }
    throw new Error(`bad-char:${ch}`);
  }
  return out;
}

export function parseExpr(raw: string): { expr: Expr | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  let toks: Tok[];
  try { toks = lex(raw); }
  catch (e) {
    return { expr: null, diagnostics: [{ level: 'error', code: 'expr-lex', message: (e as Error).message }] };
  }
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  function parseExprNode(minPrec = 0): Expr {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (!t || t.k !== 'op') break;
      const prec = binPrec(t.v);
      if (prec < minPrec) break;
      next();
      const right = parseExprNode(prec + 1);
      left = { t: 'bin', op: t.v, l: left, r: right };
    }
    return left;
  }
  function parseUnary(): Expr {
    const t = peek();
    if (t && t.k === 'op' && (t.v === '-' || t.v === '+')) {
      next();
      return { t: 'unary', op: t.v as '-' | '+', e: parseUnary() };
    }
    return parsePrimary();
  }
  function parsePrimary(): Expr {
    const t = next();
    if (!t) throw new Error('unexpected-end');
    if (t.k === 'num') {
      const q = parseQuantity(t.v, 'generic');
      return { t: 'num', value: q.number, raw: t.v, unit: q.unit, suffix: q.suffixRaw };
    }
    if (t.k === 'name') {
      if (peek()?.k === 'lp') {
        next();
        const args: Expr[] = [];
        if (peek()?.k !== 'rp') {
          args.push(parseExprNode());
          while (peek()?.k === 'comma') { next(); args.push(parseExprNode()); }
        }
        if (peek()?.k !== 'rp') throw new Error('expected-rp');
        next();
        if (!FUNCS.has(t.v.toLowerCase())) {
          diagnostics.push({ level: 'warning', code: 'expr-unknown-func', message: `未知函数 ${t.v}()` });
        }
        return { t: 'call', name: t.v.toLowerCase(), args, raw: t.v };
      }
      if (t.v.toLowerCase() in CONSTS) {
        return { t: 'num', value: CONSTS[t.v.toLowerCase()], raw: t.v, unit: { context: 'generic', scaleFactor: 1, unitWord: null }, suffix: null };
      }
      return { t: 'ref', name: t.v.toUpperCase(), raw: t.v };
    }
    if (t.k === 'lp') {
      const e = parseExprNode();
      if (peek()?.k !== 'rp') throw new Error('expected-rp');
      next();
      return e;
    }
    throw new Error(`unexpected:${JSON.stringify(t)}`;
  }
  try {
    const expr = parseExprNode();
    if (p !== toks.length) throw new Error('trailing-tokens');
    return { expr, diagnostics };
  }
  catch (e) {
    return { expr: null, diagnostics: [{ level: 'error', code: 'expr-parse', message: (e as Error).message }] };
  }
}

function binPrec(op: string): number {
  switch (op) {
    case '||': return 1;
    case '&&': return 2;
    case '==': case '!=': return 3;
    case '<': case '>': case '<=': case '>=': return 4;
    case '+': case '-': return 5;
    case '*': case '/': return 6;
    case '**': return 7;
    default: return -1;
  }
}

export function exprDeps(expr: Expr): string[] {
  switch (expr.t) {
    case 'num': return [];
    case 'ref': return [expr.name];
    case 'unary': return exprDeps(expr.e);
    case 'bin': return [...exprDeps(expr.l), ...exprDeps(expr.r)];
    case 'call': return expr.args.flatMap(exprDeps);
  }
}

/** 求值：refs 给定时求解；任何引用缺失/不可解析 -> null（保留未决状态）。 */
export function evalExpr(expr: Expr, refs: Record<string, number | null>): number | null {
  switch (expr.t) {
    case 'num': return expr.value;
    case 'ref': {
      const v = refs[expr.name];
      return v === undefined ? null : v;
    }
    case 'unary': {
      const v = evalExpr(expr.e, refs);
      if (v === null) return null;
      return expr.op === '-' ? -v : v;
    }
    case 'bin': {
      const l = evalExpr(expr.l, refs);
      const r = evalExpr(expr.r, refs);
      if (l === null || r === null) return null;
      switch (expr.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r === 0 ? null : l / r;
        case '**': return l ** r;
        case '<': return l < r ? 1 : 0;
        case '>': return l > r ? 1 : 0;
        case '<=': return l <= r ? 1 : 0;
        case '>=': return l >= r ? 1 : 0;
        case '==': return l === r ? 1 : 0;
        case '!=': return l !== r ? 1 : 0;
        case '&&': return l && r ? 1 : 0;
        case '||': return l || r ? 1 : 0;
        default: return null;
      }
    }
    case 'call': {
      const vals = expr.args.map((a) => evalExpr(a, refs));
      if (vals.some((v) => v === null)) return null;
      const n = vals as number[];
      switch (expr.name) {
        case 'abs': return Math.abs(n[0]);
        case 'sqrt': return n[0] < 0 ? null : Math.sqrt(n[0]);
        case 'sin': return Math.sin(n[0]);
        case 'cos': return Math.cos(n[0]);
        case 'tan': return Math.tan(n[0]);
        case 'exp': return Math.exp(n[0]);
        case 'log': return Math.log(n[0]);
        case 'log10': return Math.log10(n[0]);
        case 'min': return Math.min(...n);
        case 'max': return Math.max(...n);
        case 'pow': case 'pwr': return n[0] ** n[1];
        case 'floor': return Math.floor(n[0]);
        case 'ceil': return Math.ceil(n[0]);
        case 'int': return Math.trunc(n[0]);
        // 未知函数：不确定，不编造结果
        default: return null;
      }
    }
  }
}
