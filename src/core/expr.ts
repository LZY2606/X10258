import { ParamExpr } from "../shared/types.ts";
import { parseSpiceNumber } from "./util.ts";

const FUNCS: Record<string, (xs: number[]) => number> = {
  abs: ([x]) => Math.abs(x),
  min: (xs) => Math.min(...xs),
  max: (xs) => Math.max(...xs),
  sqrt: ([x]) => Math.sqrt(x),
  log: ([x]) => Math.log(x),
  log10: ([x]) => Math.log10(x),
  exp: ([x]) => Math.exp(x),
  pow: ([x, y]) => Math.pow(x, y),
  int: ([x]) => Math.trunc(x),
  sin: ([x]) => Math.sin(x),
  cos: ([x]) => Math.cos(x),
  tan: ([x]) => Math.tan(x),
  if: ([c, a, b]) => (c !== 0 ? a : b)
};

type Token =
  | { t: "num"; v: number; raw: string }
  | { t: "name"; v: string }
  | { t: "op"; v: string }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "comma" };

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "(") {
      out.push({ t: "lp" });
      i++;
      continue;
    }
    if (c === ")") {
      out.push({ t: "rp" });
      i++;
      continue;
    }
    if (c === ",") {
      out.push({ t: "comma" });
      i++;
      continue;
    }
    if ("+-*/<>!=&|".includes(c)) {
      const two = s.slice(i, i + 2);
      if (["<=", ">=", "==", "!=", "&&", "||"].includes(two)) {
        out.push({ t: "op", v: two });
        i += 2;
      } else {
        out.push({ t: "op", v: c });
        i++;
      }
      continue;
    }
    const num = /[0-9.]/.test(c);
    if (num) {
      let j = i;
      while (j < s.length && /[0-9.a-zA-Z_]/.test(s[j])) j++;
      const raw = s.slice(i, j);
      const parsed = parseSpiceNumber(raw);
      out.push({ t: "num", v: parsed.value ?? NaN, raw });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++;
      out.push({ t: "name", v: s.slice(i, j).toUpperCase() });
      i = j;
      continue;
    }
    throw new Error(`表达式含非法字符 "${c}"`);
  }
  return out;
}

/** 提取参数依赖（大写名）；数字后缀（如 10k）不被当作名字。 */
export function extractDeps(expr: string): string[] {
  let toks: Token[];
  try {
    toks = tokenize(expr);
  } catch {
    return [];
  }
  const deps = new Set<string>();
  for (const tk of toks) {
    if (tk.t === "name" && !(tk.v.toLowerCase() in FUNCS) && tk.v !== "IF") deps.add(tk.v);
  }
  return [...deps].sort();
}

type Node =
  | { k: "num"; v: number }
  | { k: "var"; v: string }
  | { k: "call"; name: string; args: Node[] }
  | { k: "un"; op: string; x: Node }
  | { k: "bin"; op: string; a: Node; b: Node };

class Parser {
  pos = 0;
  constructor(private toks: Token[]) {}
  peek(): Token | undefined {
    return this.toks[this.pos];
  }
  next(): Token {
    return this.toks[this.pos++];
  }
  parseExpr(): Node {
    return this.parseCompare();
  }
  parseCompare(): Node {
    let l = this.parseAdd();
    for (;;) {
      const tk = this.peek();
      if (tk && tk.t === "op" && ["<=", ">=", "==", "!=", "<", ">"].includes(tk.v)) {
        this.next();
        const r = this.parseAdd();
        l = { k: "bin", op: tk.v, a: l, b: r };
      } else break;
    }
    return l;
  }
  parseAdd(): Node {
    let l = this.parseMul();
    for (;;) {
      const tk = this.peek();
      if (tk && tk.t === "op" && (tk.v === "+" || tk.v === "-")) {
        this.next();
        const r = this.parseMul();
        l = { k: "bin", op: tk.v, a: l, b: r };
      } else break;
    }
    return l;
  }
  parseMul(): Node {
    let l = this.parseUnary();
    for (;;) {
      const tk = this.peek();
      if (tk && tk.t === "op" && (tk.v === "*" || tk.v === "/")) {
        this.next();
        const r = this.parseUnary();
        l = { k: "bin", op: tk.v, a: l, b: r };
      } else break;
    }
    return l;
  }
  parseUnary(): Node {
    const tk = this.peek();
    if (tk && tk.t === "op" && (tk.v === "+" || tk.v === "-")) {
      this.next();
      return { k: "un", op: tk.v, x: this.parseUnary() };
    }
    return this.parseAtom();
  }
  parseAtom(): Node {
    const tk = this.next();
    if (!tk) throw new Error("表达式意外结束");
    if (tk.t === "num") return { k: "num", v: tk.v };
    if (tk.t === "lp") {
      const e = this.parseExpr();
      const rp = this.next();
      if (!rp || rp.t !== "rp") throw new Error("缺少右括号");
      return e;
    }
    if (tk.t === "name") {
      const nxt = this.peek();
      if (nxt && nxt.t === "lp") {
        this.next();
        const args: Node[] = [];
        if (this.peek()?.t !== "rp") {
          args.push(this.parseExpr());
          while (this.peek()?.t === "comma") {
            this.next();
            args.push(this.parseExpr());
          }
        }
        const rp = this.next();
        if (!rp || rp.t !== "rp") throw new Error("函数调用缺少右括号");
        return { k: "call", name: tk.v.toLowerCase(), args };
      }
      return { k: "var", v: tk.v };
    }
    throw new Error(`意外 token ${JSON.stringify(tk)}`);
  }
}

export function evalAst(expr: string, lookup: (name: string) => number | undefined): number {
  const ast = new Parser(tokenize(expr)).parseExpr();
  const go = (n: Node): number => {
    switch (n.k) {
      case "num":
        if (Number.isNaN(n.v)) throw new Error("含不可解析的数值后缀");
        return n.v;
      case "var": {
        const v = lookup(n.v);
        if (v === undefined) throw new Error(`未解析参数 ${n.v}`);
        return v;
      }
      case "call": {
        const f = FUNCS[n.name];
        if (!f) throw new Error(`未知函数 ${n.name}`);
        return f(n.args.map(go));
      }
      case "un":
        return n.op === "-" ? -go(n.x) : go(n.x);
      case "bin": {
        const a = go(n.a);
        const b = go(n.b);
        switch (n.op) {
          case "+": return a + b;
          case "-": return a - b;
          case "*": return a * b;
          case "/": return a / b;
          case "<": return a < b ? 1 : 0;
          case ">": return a > b ? 1 : 0;
          case "<=": return a <= b ? 1 : 0;
          case ">=": return a >= b ? 1 : 0;
          case "==": return a === b ? 1 : 0;
          case "!=": return a !== b ? 1 : 0;
        }
        throw new Error(`未知运算符 ${n.op}`);
      }
    }
  };
  return go(ast);
}

/** 构造 ParamExpr：原 raw 不改写；派生层求值，失败留在原位置附诊断。 */
export function makeParamExpr(raw: string, unit = ""): ParamExpr {
  const trimmed = raw.trim();
  const isBrace = trimmed.startsWith("{") && trimmed.endsWith("}");
  const expr = isBrace ? trimmed.slice(1, -1).trim() : trimmed;
  const deps = extractDeps(expr);
  const parsed = parseSpiceNumber(expr);
  const looksPureNumber = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\S*$/.test(expr);
  if (looksPureNumber) {
    return {
      raw,
      expr,
      unitSuffix: parsed.scaleSuffix,
      deps,
      value: parsed.value,
      unit,
      diagnostic: parsed.diagnostic
    };
  }
  return {
    raw,
    expr,
    unitSuffix: null,
    deps,
    value: null,
    unit,
    diagnostic: deps.length > 0 ? "待作用域求值" : "表达式待求值"
  };
}
