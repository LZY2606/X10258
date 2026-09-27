/**
 * 参数表达式。
 *
 * 保真：表达式始终以 `exprRaw` 原样保存，这里只在“派生层”解析与求值。
 * 不可压平语义：求值不是把表达式改写成常量，而是在某个参数作用域里得到一个派生值，
 * 同时记录该值依赖了哪些（作用域, 形参）绑定，供依赖图传播/失效使用。
 */

export type TokKind =
  | 'num' | 'name' | 'op' | 'lp' | 'rp' | 'comma' | 'str';

export interface Tok {
  kind: TokKind;
  raw: string;
  pos: number;
}

export class ExprError extends Error {
  constructor(message: string, public pos: number, public exprRaw: string) {
    super(`表达式错误 @${pos}: ${message}（原文: ${exprRaw}）`);
    this.name = 'ExprError';
  }
}

const FUNCS: Record<string, (...xs: number[]) => number> = {
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  exp: Math.exp,
  log: Math.log10,
  ln: Math.log,
  sqrt: Math.sqrt,
  min: (...xs) => Math.min(...xs),
  max: (...xs) => Math.max(...xs),
  pow: Math.pow,
  int: (x) => Math.trunc(x),
  floor: Math.floor,
  ceil: Math.ceil,
  if: (c, a, b) => (c !== 0 ? a : b),
  limit: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
};

const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const NUM_RE = /[0-9.]/;

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '(') { toks.push({ kind: 'lp', raw: c, pos: i }); i++; continue; }
    if (c === ')') { toks.push({ kind: 'rp', raw: c, pos: i }); i++; continue; }
    if (c === ',') { toks.push({ kind: 'comma', raw: c, pos: i }); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j++;
      toks.push({ kind: 'str', raw: src.slice(i + 1, j), pos: i });
      i = j + 1;
      continue;
    }
    if (NUM_RE.test(c) || (c === '+' && /[0-9.]/.test(src[i + 1] ?? '')) || (c === '-' && /[0-9.]/.test(src[i + 1] ?? '') && /op|lp|comma|^$/.test(prevKind(toks)))) {
      const start = i;
      let j = i + 1;
      while (j < src.length && /[0-9.eE+\-]/.test(src[j])) {
        // 科学计数法里的 +/- 才属于数字。
        if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1])) break;
        j++;
      }
      // SPICE 倍乘后缀（字母紧跟数字），纳入数值 token 原文，求值时换算。
      while (j < src.length && /[a-zA-Z]/.test(src[j])) j++;
      toks.push({ kind: 'num', raw: src.slice(start, j), pos: start });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_.]/.test(src[j])) j++;
      toks.push({ kind: 'name', raw: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    // 多字符运算符
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    if (three === '**/' ) { toks.push({ kind: 'op', raw: three, pos: i }); i += 3; continue; }
    if (['**', '>=', '<=', '==', '!=', '&&', '||'].includes(two)) {
      toks.push({ kind: 'op', raw: two, pos: i });
      i += 2;
      continue;
    }
    if ('+-*/%<>!?:'.includes(c)) {
      toks.push({ kind: 'op', raw: c, pos: i });
      i++;
      continue;
    }
    throw new ExprError(`非法字符 “${c}”`, i, src);
  }
  return toks;
}

function prevKind(toks: Tok[]): string {
  return toks.length ? toks[toks.length - 1].kind : '';
}

// ---------------- AST ----------------

export type Node =
  | { t: 'num'; raw: string; value: number }
  | { t: 'var'; name: string }
  | { t: 'un'; op: string; x: Node }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'cond'; c: Node; a: Node; b: Node }
  | { t: 'call'; fn: string; args: Node[] };

import { parseQuantity } from './units.js';

export function parseExpr(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = (): Tok | undefined => toks[p];
  const eat = (): Tok => toks[p++];

  function parseTernary(min: number): Node {
    let left = parseUnary();
    for (;;) {
      const tk = peek();
      if (!tk || tk.kind !== 'op') break;
      const prec = binPrec(tk.raw);
      if (prec < min) break;
      eat();
      const right = parseTernary(prec + 1);
      left = { t: 'bin', op: tk.raw, l: left, r: right };
    }
    return left;
  }

  function parseExprTop(): Node {
    const cond = parseTernary(0);
    if (peek()?.kind === 'op' && peek()!.raw === '?') {
      eat();
      const a = parseTernary(0);
      if (!(peek()?.kind === 'op' && peek()!.raw === ':')) throw new ExprError("三元运算缺少 ':'", peek()?.pos ?? 0, src);
      eat();
      const b = parseTernary(0);
      return { t: 'cond', c: cond, a: a, b: b };
    }
    return cond;
  }

  function parseUnary(): Node {
    const tk = peek();
    if (tk && tk.kind === 'op' && (tk.raw === '-' || tk.raw === '+')) {
      eat();
      const x = parseUnary();
      return tk.raw === '-' ? { t: 'un', op: '-', x } : x;
    }
    if (tk && tk.kind === 'op' && tk.raw === '!') {
      eat();
      return { t: 'un', op: '!', x: parseUnary() };
    }
    return parseAtom();
  }

  function parseAtom(): Node {
    const tk = eat();
    if (!tk) throw new ExprError('意外结束', src.length, src);
    if (tk.kind === 'num') {
      const q = parseQuantity(tk.raw);
      if (q.value === null) throw new ExprError(`无法解释的数值/后缀 “${tk.raw}”`, tk.pos, src);
      return { t: 'num', raw: tk.raw, value: q.value };
    }
    if (tk.kind === 'lp') {
      const inner = parseExprTop();
      const cl = eat();
      if (!cl || cl.kind !== 'rp') throw new ExprError("缺少 ')'", tk.pos, src);
      return inner;
    }
    if (tk.kind === 'name') {
      if (peek()?.kind === 'lp') {
        eat();
        const args: Node[] = [];
        if (peek()?.kind !== 'rp') {
          args.push(parseExprTop());
          while (peek()?.kind === 'comma') {
            eat();
            args.push(parseExprTop());
          }
        }
        const cl = eat();
        if (!cl || cl.kind !== 'rp') throw new ExprError("函数调用缺少 ')'", tk.pos, src);
        return { t: 'call', fn: tk.raw.toLowerCase(), args };
      }
      return { t: 'var', name: tk.raw };
    }
    throw new ExprError(`意外令牌 “${tk.raw}”`, tk.pos, src);
  }

  function binPrec(op: string): number {
    switch (op) {
      case '||': return 1;
      case '&&': return 2;
      case '==': case '!=': return 3;
      case '<': case '>': case '<=': case '>=': return 4;
      case '+': case '-': return 5;
      case '*': case '/': case '%': return 6;
      case '**': return 7;
      default: return -1;
    }
  }

  const ast = parseExprTop();
  if (p < toks.length) throw new ExprError(`多余令牌 “${toks[p].raw}”`, toks[p].pos, src);
  return ast;
}

/** 自由变量名（小写键），但保留原名于 rawNames。 */
export function freeVars(src: string): { vars: string[]; names: Record<string, string> } {
  let ast: Node;
  try {
    ast = parseExpr(src);
  } catch {
    return { vars: [], names: {} };
  }
  const set = new Set<string>();
  const names: Record<string, string> = {};
  const walk = (n: Node): void => {
    switch (n.t) {
      case 'num': return;
      case 'var':
        set.add(n.name.toLowerCase());
        names[n.name.toLowerCase()] = n.name;
        return;
      case 'un': walk(n.x); return;
      case 'bin': walk(n.l); walk(n.r); return;
      case 'cond': walk(n.c); walk(n.a); walk(n.b); return;
      case 'call': n.args.forEach(walk); return;
    }
  };
  walk(ast);
  return { vars: [...set], names };
}

export type Env = (name: string) => number | undefined;

export function evalNode(n: Node, env: Env): number {
  switch (n.t) {
    case 'num': return n.value;
    case 'var': {
      const key = n.name.toLowerCase();
      const v = env(key);
      if (v === undefined) throw new ExprError(`未绑定的参数 “${n.name}”`, 0, '');
      return v;
    }
    case 'un': {
      const x = evalNode(n.x, env);
      return n.op === '-' ? -x : (x === 0 ? 1 : 0);
    }
    case 'bin': {
      // ** 右结合已在 parse 层处理；这里短路逻辑运算。
      if (n.op === '&&') return (evalNode(n.l, env) !== 0 && evalNode(n.r, env) !== 0) ? 1 : 0;
      if (n.op === '||') return (evalNode(n.l, env) !== 0 || evalNode(n.r, env) !== 0) ? 1 : 0;
      const a = evalNode(n.l, env);
      const b = evalNode(n.r, env);
      switch (n.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '%': return a % b;
        case '**': return a ** b;
        case '<': return a < b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
        case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        default: throw new ExprError(`未知运算符 ${n.op}`, 0, '');
      }
    }
    case 'cond': return evalNode(n.c, env) !== 0 ? evalNode(n.a, env) : evalNode(n.b, env);
    case 'call': {
      const fn = FUNCS[n.fn];
      if (!fn) throw new ExprError(`未知函数 “${n.fn}”`, 0, '');
      return fn(...n.args.map((a) => evalNode(a, env)));
    }
  }
}

export function evalExpr(src: string, env: Env): number {
  void CONSTS;
  return evalNode(parseExpr(src), (name) => {
    if (name in CONSTS) return CONSTS[name];
    return env(name);
  });
}
