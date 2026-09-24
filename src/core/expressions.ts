// 参数表达式：原始表达式不改写；求值在作用域链中进行，并记录依赖。
// 无法求值（循环依赖、未知名字、无法转换字面量）时保留原文 + 诊断。
import { parseSpiceNumber } from './units.js';
import type { Diagnostic, ResolvedParam, TextSpan } from '../shared/types.js';

// --- 词法 ---
type Tok =
  | { t: 'num'; v: number; raw: string }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lp' } | { t: 'rp' } | { t: 'comma' };

function tokenize(expr: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i]!;
    if (c === ' ' || c === '\t') { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < expr.length && /[0-9.a-zA-Z]/.test(expr[j]!)) j++;
      const raw = expr.slice(i, j);
      const parsed = parseSpiceNumber(raw);
      if (!parsed.ok || parsed.normalizedSi === undefined) {
        // 未知后缀当作名字处理（可能是参数名）
        out.push({ t: 'name', v: raw });
      } else {
        out.push({ t: 'num', v: parsed.normalizedSi, raw });
      }
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i + 1;
      while (j < expr.length && /[a-zA-Z0-9_.]/.test(expr[j]!)) j++;
      out.push({ t: 'name', v: expr.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/^<>='.includes(c)) {
      if ((c === '<' || c === '>' || c === '=' || c === '!') && expr[i + 1] === '=') {
        out.push({ t: 'op', v: expr.slice(i, i + 2) });
        i += 2;
        continue;
      }
      if (c === '^') { out.push({ t: 'op', v: '^' }); i++; continue; }
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === '(') { out.push({ t: 'lp' }); i++; continue; }
    if (c === ')') { out.push({ t: 'rp' }); i++; continue; }
    if (c === ',') { out.push({ t: 'comma' }); i++; continue; }
    throw new Error(`表达式字符无法识别: ${c}`);
  }
  return out;
}

// --- Pratt 解析为 AST（保留名字依赖）---
type Node =
  | { k: 'num'; v: number }
  | { k: 'name'; v: string }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'unary'; op: string; e: Node }
  | { k: 'bin'; op: string; l: Node; r: Node };

class Parser_ {
  pos = 0;
  constructor(private toks: Tok[]) {}
  peek(): Tok | undefined { return this.toks[this.pos]; }
  next(): Tok { return this.toks[this.pos++]!; }
  parseExpr(minBp = 0): Node {
    let left = this.parsePrefix();
    for (;;) {
      const t = this.peek();
      if (!t || t.t !== 'op') break;
      const bp = BIN_BP[t.v];
      if (bp === undefined || bp < minBp) break;
      this.next();
      const right = this.parseExpr(bp + 1);
      left = { k: 'bin', op: t.v, l: left, r: right };
    }
    return left;
  }
  parsePrefix(): Node {
    const t = this.next();
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'name') {
      if (this.peek()?.t === 'lp') {
        this.next();
        const args: Node[] = [];
        if (this.peek()?.t !== 'rp') {
          args.push(this.parseExpr(0));
          while (this.peek()?.t === 'comma') { this.next(); args.push(this.parseExpr(0)); }
        }
        const close = this.next();
        if (close.t !== 'rp') throw new Error('函数调用缺少 )');
        return { k: 'call', name: t.v.toLowerCase(), args };
      }
      return { k: 'name', v: t.v.toLowerCase() };
    }
    if (t.t === 'op' && (t.v === '-' || t.v === '+')) {
      return { k: 'unary', op: t.v, e: this.parsePrefix() };
    }
    if (t.t === 'lp') {
      const e = this.parseExpr(0);
      const close = this.next();
      if (close.t !== 'rp') throw new Error('缺少 )');
      return e;
    }
    throw new Error(`意外的 token: ${JSON.stringify(t)}`);
  }
}

const BIN_BP: Record<string, number> = {
  '||': 6, '&&': 8,
  '==': 10, '!=': 10, '<': 12, '>': 12, '<=': 12, '>=': 12,
  '+': 20, '-': 20, '*': 30, '/': 30, '^': 40,
};

function collectNames(n: Node, out: Set<string>): void {
  if (n.k === 'name') out.add(n.v);
  else if (n.k === 'unary') collectNames(n.e, out);
  else if (n.k === 'bin') { collectNames(n.l, out); collectNames(n.r, out); }
  else if (n.k === 'call') n.args.forEach((a) => collectNames(a, out));
}

const FUNCS: Record<string, (xs: number[]) => number> = {
  abs: (xs) => Math.abs(xs[0]!),
  min: (xs) => Math.min(...xs),
  max: (xs) => Math.max(...xs),
  sqrt: (xs) => Math.sqrt(xs[0]!),
  pow: (xs) => Math.pow(xs[0]!, xs[1]!),
  exp: (xs) => Math.exp(xs[0]!),
  log: (xs) => Math.log(xs[0]!),
  log10: (xs) => Math.log10(xs[0]!),
  int: (xs) => Math.trunc(xs[0]!),
};

export type ScopeFrame = { key: string; raw: string; source: 'default' | 'instance-override' | 'global' }[];

export interface ExprResult {
  ok: boolean;
  value?: number;
  dependsOn: string[];
  unresolved: string[];
  diagnostic?: Diagnostic;
}

export function evaluateExpression(
  rawExpr: string,
  frames: ScopeFrame[],
  stack: Set<string>,
  span?: TextSpan,
): ExprResult {
  let ast: Node;
  try {
    ast = new Parser_(tokenize(rawExpr)).parseExpr(0);
  } catch (e) {
    return {
      ok: false,
      dependsOn: [],
      unresolved: [],
      diagnostic: {
        code: 'BAD_EXPRESSION',
        severity: 'error',
        message: `表达式无法解析，保留原文 "${rawExpr}": ${(e as Error).message}`,
        span,
        value: rawExpr,
      },
    };
  }
  const names = new Set<string>();
  collectNames(ast, names);

  const lookup = (name: string): number | undefined => {
    for (const frame of frames) {
      const hit = frame.find((p) => p.key.toLowerCase() === name);
      if (hit) {
        if (stack.has(name)) throw new CYCLE(name);
        return undefined; // 调用方负责按依赖递归；此处仅占位
      }
    }
    return undefined;
  };
  void lookup;

  const evalNode = (n: Node): number => {
    if (n.k === 'num') return n.v;
    if (n.k === 'unary') return n.op === '-' ? -evalNode(n.e) : evalNode(n.e);
    if (n.k === 'bin') {
      const l = evalNode(n.l);
      const r = evalNode(n.r);
      switch (n.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return l / r;
        case '^': return l ** r;
        case '<': return l < r ? 1 : 0;
        case '>': return l > r ? 1 : 0;
        case '<=': return l <= r ? 1 : 0;
        case '>=': return l >= r ? 1 : 0;
        case '==': return l === r ? 1 : 0;
        case '!=': return l !== r ? 1 : 0;
        case '&&': return l && r ? 1 : 0;
        case '||': return l || r ? 1 : 0;
        default: throw new Error(`未知运算符 ${n.op}`);
      }
    }
    if (n.k === 'call') {
      const fn = FUNCS[n.name];
      if (!fn) throw new Error(`未知函数 ${n.name}`);
      return fn(n.args.map(evalNode));
    }
    // name：按作用域链递归求值
    const name = n.v;
    for (const frame of frames) {
      const hit = frame.find((p) => p.key.toLowerCase() === name);
      if (hit) {
        if (stack.has(name)) throw new CYCLE(name);
        const v = resolveRawValue(hit.raw, frames, new Set(stack).add(name));
        if (v.value === undefined) throw new Error(`参数 ${name} 无法求值`);
        return v.value;
      }
    }
    throw new Error(`未知名字 ${name}`);
  };

  try {
    const value = evalNode(ast);
    return { ok: true, value, dependsOn: [...names], unresolved: [] };
  } catch (e) {
      if (e instanceof CYCLE) {
        return {
        ok: false,
        dependsOn: [...names],
        unresolved: [...names],
        diagnostic: {
          code: 'CYCLIC_PARAM',
          severity: 'error',
          message: `参数循环依赖: ${e.cycleName}`,
          span,
          value: rawExpr,
        },
      };
    }
    const unresolved = [...names];
    return {
      ok: false,
      dependsOn: unresolved,
      unresolved,
      diagnostic: {
        code: 'UNRESOLVED_EXPR',
        severity: 'warning',
        message: `表达式存在无法决定的名字，保留原文 "${rawExpr}": ${(e as Error).message}`,
        span,
        value: rawExpr,
      },
    };
  }
}

class CYCLE extends Error {
  constructor(public cycleName: string) { super(`cycle ${cycleName}`); }
}

export function resolveRawValue(raw: string, frames: ScopeFrame[], stack = new Set<string>()): {
  value: number | undefined;
  dependsOn: string[];
  diagnostic?: Diagnostic;
  suffix?: string;
} {
  const literal = parseSpiceNumber(raw);
  if (literal.ok && literal.normalizedSi !== undefined && !/[a-zA-Z_]/.test(raw.replace(/^\s*[+-]?[\d.]+e[+-]?\d+/i, ''))) {
    // 纯数值（允许指数），直接常量
    if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(raw.trim())) {
      return { value: literal.normalizedSi, dependsOn: [], suffix: literal.scaleSuffix };
    }
  }
  const r = evaluateExpression(raw, frames, stack);
  return { value: r.value, dependsOn: r.dependsOn, diagnostic: r.diagnostic };
}

export function buildResolvedParam(
  key: string,
  keyRaw: string,
  raw: string,
  span: TextSpan,
  frames: ScopeFrame[],
  provenance: ResolvedParam['provenance'],
): ResolvedParam {
  const r = evaluateExpression(raw, frames, new Set());
  const literal = parseSpiceNumber(raw);
  return {
    key,
    raw,
    value: r.ok && r.value !== undefined ? r.value : raw,
    evaluated: r.ok,
    unitSuffix: literal.ok ? literal.scaleSuffix : undefined,
    normalizedSi: r.ok ? r.value : literal.ok ? literal.normalizedSi : undefined,
    dependsOn: r.dependsOn,
    diagnostic: r.diagnostic,
    provenance: { ...provenance, key: keyRaw },
  };
}
