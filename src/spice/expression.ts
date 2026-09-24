// SPICE 参数表达式：
//  - 原始表达式文本永不改写；
//  - 依赖图记录自由变量；作用域求值只在派生层进行；
//  - 无法求值（循环/未定义）保留 symbolic，不删除、不伪造单一答案。

export type Tok =
  | { t: 'num'; text: string }
  | { t: 'name'; text: string }
  | { t: 'op'; text: string }
  | { t: 'lp' } | { t: 'rp' } | { t: 'comma' };

const FUNCS1 = new Set(['abs', 'sqrt', 'sin', 'cos', 'tan', 'exp', 'ln', 'log', 'floor', 'ceil', 'min', 'max', 'pwr', 'pow']);
export const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export function tokenize(src: string): Tok[] {
  const s = src;
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_.]/.test(s[j])) j++;
      toks.push({ t: 'name', text: s.slice(i, j) });
      i = j; continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[0-9.a-zA-Z_µ]/.test(s[j])) j++; // 10k、2.2u 等作为数值 token
      toks.push({ t: 'num', text: s.slice(i, j) });
      i = j; continue;
    }
    if ('+-*/><=!&|^~%'.includes(c)) {
      const two = s.slice(i, i + 2);
      if (['**', '==', '!=', '<=', '>=', '&&', '||'].includes(two)) { toks.push({ t: 'op', text: two }); i += 2; continue; }
      toks.push({ t: 'op', text: c }); i++; continue;
    }
    if (c === '(') { toks.push({ t: 'lp' }); i++; continue; }
    if (c === ')') { toks.push({ t: 'rp' }); i++; continue; }
    if (c === ',') { toks.push({ t: 'comma' }); i++; continue; }
    // 未知字符：作为 name-like 保留，交给诊断
    toks.push({ t: 'name', text: c }); i++;
  }
  return toks;
}

// AST（仅用于求值与依赖分析；不回写原文）
type Node =
  | { k: 'num'; v: number; raw: string }
  | { k: 'var'; name: string }
  | { k: 'un'; op: string; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; name: string; args: Node[] };

class Parser {
  private p = 0;
  constructor(private toks: Tok[]) {}
  peek(): Tok | undefined { return this.toks[this.p]; }
  next(): Tok { return this.toks[this.p++]; }
  expect(t: Tok['t']): Tok { const x = this.next(); if (x.t !== t) throw new Error(`expected ${t} got ${x.t}`); return x; }

  parse(): Node {
    const n = this.parseExpr();
    if (this.p !== this.toks.length) throw new Error('trailing tokens');
    return n;
  }
  parseExpr(): Node { return this.parseOr(); }
  parseOr(): Node { let l = this.parseAnd(); while (this.isOp('||')) { const op = this.next().text; l = { k: 'bin', op, a: l, b: this.parseAnd() }; } return l; }
  parseAnd(): Node { let l = this.parseCmp(); while (this.isOp('&&')) { const op = this.next().text; l = { k: 'bin', op, a: l, b: this.parseCmp() }; } return l; }
  parseCmp(): Node { let l = this.parseAdd(); while (this.peek()?.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes((this.peek() as { text: string }).text)) { const op = (this.next() as { text: string }).text; l = { k: 'bin', op, a: l, b: this.parseAdd() }; } return l; }
  parseAdd(): Node { let l = this.parseMul(); while (this.isOp('+', '-')) { const op = this.next().text; l = { k: 'bin', op, a: l, b: this.parseMul() }; } return l; }
  parseMul(): Node { let l = this.parsePow(); while (this.isOp('*', '/', '%')) { const op = this.next().text; l = { k: 'bin', op, a: l, b: this.parsePow() }; } return l; }
  parsePow(): Node { const a = this.parseUnary(); if (this.isOp('**', '^')) { const op = this.next().text; return { k: 'bin', op, a, b: this.parsePow() }; } return a; }
  parseUnary(): Node { if (this.isOp('-', '+', '~', '!')) { const op = this.next().text; return { k: 'un', op, a: this.parseUnary() }; } return this.parseAtom(); }
  parseAtom(): Node {
    const tk = this.peek();
    if (!tk) throw new Error('unexpected end');
    if (tk.t === 'num') { this.next(); return { k: 'num', v: numLit(tk.text), raw: tk.text }; }
    if (tk.t === 'lp') { this.next(); const e = this.parseExpr(); this.expect('rp'); return e; }
    if (tk.t === 'name') {
      this.next();
      if (this.peek()?.t === 'lp') {
        this.next();
        const args: Node[] = [];
        if (this.peek()?.t !== 'rp') { args.push(this.parseExpr()); while (this.peek()?.t === 'comma') { this.next(); args.push(this.parseExpr()); } }
        this.expect('rp');
        return { k: 'call', name: tk.text.toLowerCase(), args };
      }
      return { k: 'var', name: tk.text.toUpperCase() };
    }
    throw new Error(`unexpected token ${JSON.stringify(tk)}`);
  }
  isOp(...ops: string[]): boolean { const t = this.peek(); return !!t && t.t === 'op' && ops.includes(t.text); }
}

function numLit(text: string): number {
  // 数值字面量支持 SPICE 后缀（复用 number 模块的正则逻辑，避免循环依赖：内联简化）
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Zµ]+)?$/.exec(text);
  if (!m) return Number(text);
  const v = Number(m[1]);
  const suf = m[2]?.toLowerCase();
  if (!suf) return v;
  const map: Record<string, number> = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, 'µ': 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
  if (suf.startsWith('meg')) return v * 1e6;
  if (suf[0] in map) return v * map[suf[0]];
  return v; // 纯单位或未知：量级不变（单位仅基准标注）
}

export interface ParsedExpr {
  raw: string;
  ast: Node;
  freeVars: string[];
  error?: string;
}

export function parseExpression(raw: string): ParsedExpr {
  try {
    const ast = new Parser(tokenize(raw)).parse();
    const free = new Set<string>();
    const walk = (n: Node): void => {
      if (n.k === 'var' && !(n.name.toLowerCase() in CONSTS)) free.add(n.name);
      if (n.k === 'bin') { walk(n.a); walk(n.b); }
      if (n.k === 'un') walk(n.a);
      if (n.k === 'call') n.args.forEach(walk);
    };
    walk(ast);
    return { raw, ast, freeVars: [...free].sort() };
  } catch (e) {
    return { raw, ast: { k: 'num', v: NaN, raw }, freeVars: [], error: (e as Error).message };
  }
}

export type Lookup = (name: string) => number | undefined;

export function evalAst(n: Node, lookup: Lookup, stack: Set<string> = new Set()): number {
  switch (n.k) {
    case 'num': return n.v;
    case 'var': {
      const key = n.name.toLowerCase();
      if (key in CONSTS) return CONSTS[key];
      if (stack.has(n.name)) throw new Error(`cyclic-reference:${n.name}`);
      const v = lookup(n.name);
      if (v === undefined) throw new Error(`unresolved:${n.name}`);
      return v;
    }
    case 'un': {
      const a = evalAst(n.a, lookup, stack);
      return n.op === '-' ? -a : n.op === '+' ? a : n.op === '!' ? Number(!a) : ~a;
    }
    case 'bin': {
      const a = evalAst(n.a, lookup, stack);
      const b = evalAst(n.b, lookup, stack);
      switch (n.op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '/': return a / b; case '%': return a % b; case '**': case '^': return a ** b;
        case '==': return Number(a === b); case '!=': return Number(a !== b);
        case '<': return Number(a < b); case '>': return Number(a > b);
        case '<=': return Number(a <= b); case '>=': return Number(a >= b);
        case '&&': return Number(Boolean(a) && Boolean(b));
        case '||': return Number(Boolean(a) || Boolean(b));
        default: throw new Error(`bad-op:${n.op}`);
      }
    }
    case 'call': {
      const vals = n.args.map((x) => evalAst(x, lookup, stack));
      switch (n.name) {
        case 'abs': return Math.abs(vals[0]);
        case 'sqrt': return Math.sqrt(vals[0]);
        case 'sin': return Math.sin(vals[0]);
        case 'cos': return Math.cos(vals[0]);
        case 'tan': return Math.tan(vals[0]);
        case 'exp': return Math.exp(vals[0]);
        case 'ln': case 'log': return Math.log(vals[0]);
        case 'floor': return Math.floor(vals[0]);
        case 'ceil': return Math.ceil(vals[0]);
        case 'min': return Math.min(...vals);
        case 'max': return Math.max(...vals);
        case 'pwr': case 'pow': return vals[0] ** vals[1];
        default: throw new Error(`unknown-func:${n.name}`);
      }
    }
  }
}

/** 在给定环境中求值；失败返回 undefined（调用方保留 symbolic 与诊断）。 */
export function tryEval(raw: string, lookup: Lookup): { value?: number; error?: string } {
  const pe = parseExpression(raw);
  if (pe.error) return { error: pe.error };
  try {
    return { value: evalAst(pe.ast, lookup) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function freeVariables(raw: string): string[] {
  return parseExpression(raw).freeVars;
}

export interface ExprEquiv {
  equivalent: boolean;
  reason: 'both-unresolved-same-symbolic' | 'both-numeric-equal' | 'differ' | 'one-unresolved';
  relError?: number;
  aResolved: boolean;
  bResolved: boolean;
}

export function expressionsEquivalent(rawA: string, rawB: string, envA: Lookup, envB: Lookup, tol = 1e-9): ExprEquiv {
  const a = tryEval(rawA, envA);
  const b = tryEval(rawB, envB);
  const aR = a.error === undefined;
  const bR = b.error === undefined;
  if (aR && bR) {
    const va = a.value as number; const vb = b.value as number;
    const denom = Math.max(1, Math.abs(va), Math.abs(vb));
    const rel = Math.abs(va - vb) / denom;
    return { equivalent: rel <= tol, reason: rel <= tol ? 'both-numeric-equal' : 'differ', relError: rel, aResolved: true, bResolved: true };
  }
  if (!aR && !bR) {
    // 双方都无法求值：只有"规范化符号文本一致"才视为等价，绝不压平作用域差异。
    const sym = rawA.replace(/\s+/g, '').toUpperCase() === rawB.replace(/\s+/g, '').toUpperCase();
    return { equivalent: sym, reason: 'both-unresolved-same-symbolic', aResolved: false, bResolved: false };
  }
  return { equivalent: false, reason: 'one-unresolved', aResolved: aR, bResolved: bR };
}
