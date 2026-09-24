import type { ExprNode } from './types';
import { parseSpiceNumber } from './units';

/**
 * SPICE 参数表达式词法 + Pratt 解析。
 * 未知函数/未知变量不报错：保留 opaque/ref，交给作用域求值阶段诊断。
 */
type Tok =
  | { t: 'num'; raw: string }
  | { t: 'ident'; name: string }
  | { t: 'op'; op: string }
  | { t: 'lp' } | { t: 'rp' } | { t: 'comma' };

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '(') { toks.push({ t: 'lp' }); i++; continue; }
    if (c === ')') { toks.push({ t: 'rp' }); i++; continue; }
    if (c === ',') { toks.push({ t: 'comma' }); i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.a-zA-Zµ]/.test(src[j])) j++;
      toks.push({ t: 'num', raw: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_.]/.test(src[j])) j++;
      toks.push({ t: 'ident', name: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||', '**'].includes(two)) {
      toks.push({ t: 'op', op: two }); i += 2; continue;
    }
    if ('+-*/%^<>!'.includes(c)) { toks.push({ t: 'op', op: c }); i++; continue; }
    // 无法词法化：交由调用方作为 opaque
    throw new Error(`lex-error at ${i}: ${src.slice(i)}`);
  }
  return toks;
}

const PREC: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 3, '&': 4,
  '==': 5, '!=': 5, '<': 6, '>': 6, '<=': 6, '>=': 6,
  '+': 7, '-': 7, '*': 8, '/': 8, '%': 8,
};

class Parser {
  constructor(private toks: Tok[]) {}
  private p = 0;
  private peek(): Tok | undefined { return this.toks[this.p]; }
  private next(): Tok { return this.toks[this.p++]; }

  parse(): ExprNode {
    const e = this.binary(0);
    if (this.peek()) throw new Error('trailing-token');
    return e;
  }

  private binary(minPrec: number): ExprNode {
    let left = this.unary();
    for (;;) {
      const tk = this.peek();
      if (!tk || tk.t !== 'op') break;
      const prec = PREC[tk.op];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const right = this.binary(prec + 1);
      left = { t: 'bin', op: tk.op, l: left, r: right };
    }
    return left;
  }

  private unary(): ExprNode {
    const tk = this.peek();
    if (tk && tk.t === 'op' && (tk.op === '-' || tk.op === '+')) {
      this.next();
      return { t: 'unary', op: tk.op, e: this.unary() };
    }
    return this.primary();
  }

  private primary(): ExprNode {
    const tk = this.next();
    if (!tk) throw new Error('unexpected-end');
    if (tk.t === 'num') {
      const parsed = parseSpiceNumber(tk.raw);
      return { t: 'num', raw: tk.raw, value: parsed.value, suffix: parsed.suffix ?? undefined };
    }
    if (tk.t === 'lp') {
      const e = this.binary(0);
      const close = this.next();
      if (!close || close.t !== 'rp') throw new Error('missing-rp');
      return e;
    }
    if (tk.t === 'ident') {
      if (this.peek()?.t === 'lp') {
        this.next();
        const args: ExprNode[] = [];
        if (this.peek()?.t !== 'rp') {
          args.push(this.binary(0));
          while (this.peek()?.t === 'comma') { this.next(); args.push(this.binary(0)); }
        }
        const close = this.next();
        if (!close || close.t !== 'rp') throw new Error('missing-rp-call');
        return { t: 'call', name: tk.name.toLowerCase(), args };
      }
      return { t: 'ref', name: tk.name.toLowerCase() };
    }
    throw new Error('unexpected-token');
  }
}

export function parseExpr(raw: string): ExprNode {
  try {
    return new Parser(lex(raw)).parse();
  } catch (e) {
    return { t: 'opaque', raw, reason: (e as Error).message };
  }
}

/** 求值；env 返回 number|null（未知即 null），未知函数保留 null */
export function evalExpr(
  node: ExprNode,
  env: (name: string) => number | null,
  call?: (name: string, args: number[]) => number | null,
): number | null {
  switch (node.t) {
    case 'num': return node.value;
    case 'ref': return env(node.name);
    case 'opaque': return null;
    case 'unary': {
      const v = evalExpr(node.e, env, call);
      return v === null ? null : node.op === '-' ? -v : v;
    }
    case 'bin': {
      const l = evalExpr(node.l, env, call);
      const r = evalExpr(node.r, env, call);
      if (l === null || r === null) return null;
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r === 0 ? null : l / r;
        case '%': return r === 0 ? null : l % r;
        case '**': return l ** r;
        case '^': return l ** r;
        case '==': return Number(l === r);
        case '!=': return Number(l !== r);
        case '<': return Number(l < r);
        case '>': return Number(l > r);
        case '<=': return Number(l <= r);
        case '>=': return Number(l >= r);
        case '&&': return Number(Boolean(l) && Boolean(r));
        case '||': return Number(Boolean(l) || Boolean(r));
        default: return null;
      }
    }
    case 'call': {
      const vs = node.args.map((a) => evalExpr(a, env, call));
      if (vs.some((v) => v === null)) return null;
      if (call) {
        const v = call(node.name, vs as number[]);
        if (v !== null && v !== undefined) return v;
      }
      return builtin(node.name, vs as number[]);
    }
  }
}

function builtin(name: string, a: number[]): number | null {
  switch (name) {
    case 'abs': return Math.abs(a[0]);
    case 'sqrt': return a[0] < 0 ? null : Math.sqrt(a[0]);
    case 'min': return Math.min(...a);
    case 'max': return Math.max(...a);
    case 'pow': return a[0] ** a[1];
    case 'pwr': return Math.sign(a[0]) * Math.abs(a[0]) ** a[1];
    case 'log': return Math.log(a[0]);
    case 'log10': return Math.log10(a[0]);
    case 'exp': return Math.exp(a[0]);
    case 'sin': return Math.sin(a[0]);
    case 'cos': return Math.cos(a[0]);
    case 'tan': return Math.tan(a[0]);
    case 'if':
    case 'ternary_fcn':
      return a[0] !== 0 ? a[1] : a[2] ?? null;
    case 'limit':
      return Math.min(Math.max(a[0], a[1]), a[2]);
    default:
      return null; // 未知函数：opaque，不臆造
  }
}

/** 收集表达式引用的变量名（依赖图边） */
export function refsOf(node: ExprNode, out = new Set<string>()): Set<string> {
  switch (node.t) {
    case 'ref': out.add(node.name); break;
    case 'unary': refsOf(node.e, out); break;
    case 'bin': refsOf(node.l, out); refsOf(node.r, out); break;
    case 'call': node.args.forEach((a) => refsOf(a, out)); break;
  }
  return out;
}
