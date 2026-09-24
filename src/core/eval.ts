// 保守的 SPICE 参数表达式求值器：仅在派生层使用，不回写任何原文。
// 不支持的函数/变量返回 {ok:false}，调用方保留表达式原文并记录诊断。

type Ctx = Map<string, number>;

const FUNCS: Record<string, (...a: number[]) => number> = {
  abs: Math.abs, sqrt: Math.sqrt, min: Math.min, max: Math.max,
  pow: Math.pow, exp: Math.exp, log: Math.log, log10: Math.log10,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos,
  atan: Math.atan, floor: Math.floor, ceil: Math.ceil, int: Math.trunc,
  limit: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
  pwr: (x, y) => Math.sign(x) * Math.pow(Math.abs(x), y),
  pwrs: Math.pow
};

type Tok =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*([0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|[A-Za-z_][A-Za-z0-9_.]*|==|!=|<=|>=|[+\-*/(),<>=?:])/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(src)) !== null) {
    if (src.slice(last, m.index).trim() !== "") throw new Error(`bad-char near '${src.slice(last, m.index)}'`);
    const t = m[1]!;
    if (/^[0-9]/.test(t) || (t.startsWith(".") && /[0-9]/.test(t))) out.push({ t: "num", v: Number(t) });
    else if (/[A-Za-z_]/.test(t)) out.push({ t: "id", v: t.toLowerCase() });
    else out.push({ t: "op", v: t });
    last = re.lastIndex;
  }
  if (src.slice(last).trim() !== "") throw new Error("trailing-chars");
  return out;
}

type NumFn = (ctx: Ctx) => number;

class Parser {
  private p = 0;
  constructor(private readonly toks: Tok[]) {}
  private peek(): Tok | undefined { return this.toks[this.p]; }
  private nextTok(): Tok { return this.toks[this.p++]!; }
  private isOp(v?: string): boolean {
    const t = this.peek();
    return !!t && t.t === "op" && (v === undefined || t.v === v);
  }
  private eat(v: string) {
    if (!this.isOp(v)) throw new Error(`expected '${v}'`);
    this.p++;
  }

  parse(): NumFn {
    const e = this.ternary();
    if (this.p !== this.toks.length) throw new Error("extra tokens");
    return e;
  }

  private ternary(): NumFn {
    const cond = this.expr(0);
    if (this.isOp("?")) {
      this.nextTok();
      const thn = this.ternary();
      this.eat(":");
      const els = this.ternary();
      return (ctx) => (cond(ctx) !== 0 ? thn(ctx) : els(ctx));
    }
    return cond;
  }

  private expr(minbp: number): NumFn {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (!t || t.t !== "op" || t.v === "?" || t.v === ":" || t.v === "," || t.v === ")") break;
      const bp = BIN_BP[t.v];
      if (bp === undefined || bp.lbp < minbp) break;
      this.nextTok();
      const right = this.expr(bp.rbp);
      const capturedLeft = left;
      const op = t.v;
      left = (ctx) => applyBin(op, capturedLeft(ctx), right(ctx));
    }
    return left;
  }

  private unary(): NumFn {
    if (this.isOp("-")) { this.nextTok(); const e = this.unary(); return (ctx) => -e(ctx); }
    if (this.isOp("+")) { this.nextTok(); return this.unary(); }
    if (this.isOp("(")) {
      this.eat("(");
      const e = this.ternary();
      this.eat(")");
      return e;
    }
    const t = this.nextTok();
    if (t.t === "num") { const v = t.v; return () => v; }
    if (t.t === "id") {
      if (this.isOp("(")) {
        this.eat("(");
        const args: NumFn[] = [];
        if (!this.isOp(")")) {
          args.push(this.ternary());
          while (this.isOp(",")) { this.nextTok(); args.push(this.ternary()); }
        }
        this.eat(")");
        const fn = FUNCS[t.v];
        if (!fn) throw new Error(`unknown-func:${t.v}`);
        return (ctx) => fn(...args.map((a) => a(ctx)));
      }
      return (ctx) => {
        if (t.v === "pi") return Math.PI;
        if (!ctx.has(t.v)) throw new Error(`unresolved:${t.v}`);
        return ctx.get(t.v)!;
      };
    }
    throw new Error("unexpected token");
  }
}

const BIN_BP: Record<string, { lbp: number; rbp: number }> = {
  "||": { lbp: 2, rbp: 3 }, "&&": { lbp: 4, rbp: 5 },
  "==": { lbp: 6, rbp: 7 }, "!=": { lbp: 6, rbp: 7 },
  "<": { lbp: 8, rbp: 9 }, "<=": { lbp: 8, rbp: 9 },
  ">": { lbp: 8, rbp: 9 }, ">=": { lbp: 8, rbp: 9 },
  "+": { lbp: 10, rbp: 11 }, "-": { lbp: 10, rbp: 11 },
  "*": { lbp: 12, rbp: 13 }, "/": { lbp: 12, rbp: 13 }
};

function applyBin(op: string, a: number, b: number): number {
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/": return a / b;
    case "<": return a < b ? 1 : 0;
    case "<=": return a <= b ? 1 : 0;
    case ">": return a > b ? 1 : 0;
    case ">=": return a >= b ? 1 : 0;
    case "==": return a === b ? 1 : 0;
    case "!=": return a !== b ? 1 : 0;
    case "&&": return a !== 0 && b !== 0 ? 1 : 0;
    case "||": return a !== 0 || b !== 0 ? 1 : 0;
    default: throw new Error(`bad-op:${op}`);
  }
}

export interface EvalResult {
  ok: boolean;
  value?: number;
  reason?: string;
}

export function evaluateExpression(raw: string, ctx: Map<string, number>): EvalResult {
  try {
    const fn = new Parser(tokenize(raw)).parse();
    return { ok: true, value: fn(ctx) };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export function expressionVariables(raw: string): string[] {
  let toks: Tok[];
  try { toks = tokenize(raw); } catch { return []; }
  const ids = new Set<string>();
  for (const t of toks) {
    if (t.t === "id" && !(t.v in FUNCS) && t.v !== "pi") ids.add(t.v);
  }
  return [...ids].sort();
}
