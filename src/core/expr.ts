/**
 * 参数表达式：
 *  - 保留原文，不压平；
 *  - 提取自由变量（依赖图边）；
 *  - 在给定环境下做受限安全求值（无函数构造器）。
 * 无法唯一求值（缺变量/多候选/循环）时 numeric=null 并附诊断，绝不猜值。
 */

export interface ExprAnalysis {
  /** 去掉外层花括号后的表达式原文（仍保留内部大小写/空格展示用另存） */
  body: string;
  /** 变量依赖名（大写规范化用于匹配，另存原文名） */
  dependencies: { name: string; raw: string }[];
  diagnostic: string | null;
}

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_.]*/g;
const BUILTIN_FUNCS = new Set([
  'abs',
  'sqrt',
  'min',
  'max',
  'pow',
  'exp',
  'log',
  'log10',
  'sin',
  'cos',
  'tan',
  'atan',
  'if',
  'limit',
  'pwr',
]);

export function analyzeExpression(raw: string): ExprAnalysis {
  let body = raw.trim();
  const wrapped = body.startsWith('{') && body.endsWith('}');
  if (wrapped) body = body.slice(1, -1).trim();
  const deps: { name: string; raw: string }[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  IDENT_RE.lastIndex = 0;
  while ((m = IDENT_RE.exec(body)) !== null) {
    const word = m[0];
    // 函数调用不计入变量依赖
    const after = body.slice(m.index + word.length).trimStart();
    if (after.startsWith('(')) continue;
    if (BUILTIN_FUNCS.has(word.toLowerCase())) continue;
    const key = word.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      deps.push({ name: key, raw: word });
    }
  }
  return { body, dependencies: deps, diagnostic: null };
}

/** 词法 + 递归下降的小表达式求值器（不使用 eval/Function） */
type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string } | { t: 'lp' } | { t: 'rp' } | { t: 'comma' };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (/[0-9.]/.test(c) || ((c === '+' || c === '-') && /[0-9.]/.test(src[i + 1] ?? '') && (toks.length === 0 || (toks[toks.length - 1].t === 'op')))) {
      let j = i + 1;
      while (j < src.length && /[0-9.eE+\-]/.test(src[j])) {
        if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1])) break;
        j++;
      }
      const num = src.slice(i, j);
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(num)) {
        throw new Error(`bad-number: ${num}`);
      }
      toks.push({ t: 'num', v: Number(num) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '(') { toks.push({ t: 'lp' }); i++; continue; }
    if (c === ')') { toks.push({ t: 'rp' }); i++; continue; }
    if (c === ',') { toks.push({ t: 'comma' }); i++; continue; }
    const two = src.slice(i, i + 2);
    if (two === '**' || two === '<=' || two === '>=' || two === '==' || two === '!=') {
      toks.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/<>'.includes(c)) {
      toks.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new Error(`bad-char: ${c}`);
  }
  return toks;
}

class Parser {
  private p = 0;
  constructor(private toks: Tok[], private env: Map<string, number>) {}

  private peek(): Tok | undefined { return this.toks[this.p]; }
  private next(): Tok { const t = this.toks[this.p++]; if (!t) throw new Error('unexpected-end'); return t; }

  parse(): number {
    const v = this.parseExpr();
    if (this.p !== this.toks.length) throw new Error('trailing-tokens');
    return v;
  }

  private parseExpr(): number {
    let left = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
        this.next();
        const r = this.parseTerm();
        left = t.v === '+' ? left + r : left - r;
      } else return left;
    }
  }
  private parseTerm(): number {
    let left = this.parseFactor();
    for (;;) {
      const t = this.peek();
      if (t && t.t === 'op' && (t.v === '*' || t.v === '/')) {
        this.next();
        const r = this.parseFactor();
        left = t.v === '*' ? left * r : left / r;
      } else return left;
    }
  }
  private parseFactor(): number {
    const base = this.parseUnary();
    const t = this.peek();
    if (t && t.t === 'op' && t.v === '**') {
      this.next();
      return Math.pow(base, this.parseFactor());
    }
    return base;
  }
  private parseUnary(): number {
    const t = this.peek();
    if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
      this.next();
      const v = this.parseUnary();
      return t.v === '-' ? -v : v;
    }
    return this.parsePrimary();
  }
  private parsePrimary(): number {
    const t = this.next();
    if (t.t === 'num') return t.v;
    if (t.t === 'lp') {
      const v = this.parseExpr();
      const c = this.next();
      if (c.t !== 'rp') throw new Error('expected-rp');
      return v;
    }
    if (t.t === 'id') {
      // 函数调用
      const nx = this.peek();
      if (nx && nx.t === 'lp') {
        this.next();
        const args: number[] = [];
        if (this.peek()?.t !== 'rp') {
          args.push(this.parseExpr());
          while (this.peek()?.t === 'comma') { this.next(); args.push(this.parseExpr()); }
        }
        const c = this.next();
        if (c.t !== 'rp') throw new Error('expected-rp');
        return callBuiltin(t.v, args);
      }
      const key = t.v.toUpperCase();
      if (!this.env.has(key)) throw new Error(`unresolved:${t.v}`);
      return this.env.get(key)!;
    }
    throw new Error('unexpected-token');
  }
}

function callBuiltin(name: string, args: number[]): number {
  const n = name.toLowerCase();
  switch (n) {
    case 'abs': return Math.abs(args[0]);
    case 'sqrt': return Math.sqrt(args[0]);
    case 'min': return Math.min(...args);
    case 'max': return Math.max(...args);
    case 'pow': return Math.pow(args[0], args[1]);
    case 'pwr': return Math.pow(Math.abs(args[0]), args[1]);
    case 'exp': return Math.exp(args[0]);
    case 'log': return Math.log(args[0]);
    case 'log10': return Math.log10(args[0]);
    case 'sin': return Math.sin(args[0]);
    case 'cos': return Math.cos(args[0]);
    case 'tan': return Math.tan(args[0]);
    case 'atan': return Math.atan(args[0]);
    case 'limit':
      return Math.min(Math.max(args[0], args[1]), args[2]);
    case 'if':
      return args[0] !== 0 ? args[1] : args[2];
    default:
      throw new Error(`unknown-func:${name}`);
  }
}

export interface EvalResult {
  value: number | null;
  diagnostic: string | null;
}

export function evaluate(body: string, env: Map<string, number>): EvalResult {
  try {
    const toks = tokenize(body);
    const parser = new Parser(toks, env);
    return { value: parser.parse(), diagnostic: null };
  } catch (e) {
    return { value: null, diagnostic: (e as Error).message };
  }
}
