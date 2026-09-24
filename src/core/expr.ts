// 表达式求值：作用域链解析；依赖不可解析时返回 undefined（不吞掉不确定状态）。
export type Scope = Map<string, number>;

export function evalExpr(rawExpr: string, scopes: Scope[]): number | undefined {
  let inner = rawExpr.trim();
  if (inner.startsWith('{') && inner.endsWith('}')) inner = inner.slice(1, -1);
  const tokens = tokenize(inner);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function resolve(name: string): number | undefined {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].has(name)) return scopes[i].get(name);
    }
    return undefined;
  }

  function parsePrimary(): number | undefined {
    const t = next();
    if (t === undefined) return undefined;
    if (t === '(') { const v = parseAdd(); if (next() !== ')') return undefined; return v; }
    if (t === '-') { const v = parsePrimary(); return v === undefined ? undefined : -v; }
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[A-Za-z]*$/.test(t) && /^\d|^\.\d|^-\d|^-\.\d/.test(t)) {
      const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([A-Za-z]*)$/.exec(t)!;
      const tail = m[2].toLowerCase();
      const mult = tail === '' ? 1
        : tail.startsWith('meg') ? 1e6 : tail.startsWith('t') ? 1e12
        : tail.startsWith('g') ? 1e9 : tail.startsWith('k') ? 1e3
        : tail.startsWith('m') ? 1e-3 : tail.startsWith('u') ? 1e-6
        : tail.startsWith('n') ? 1e-9 : tail.startsWith('p') ? 1e-12
        : tail.startsWith('f') ? 1e-15 : NaN;
      if (Number.isNaN(mult)) return undefined;
      return parseFloat(m[1]) * mult;
    }
    if (/^[A-Za-z_]/.test(t)) {
      const name = t.toLowerCase();
      if (peek() === '(') {
        next();
        const arg = parseAdd();
        if (next() !== ')') return undefined;
        if (arg === undefined) return undefined;
        switch (name) {
          case 'abs': return Math.abs(arg);
          case 'sqrt': return Math.sqrt(arg);
          case 'exp': return Math.exp(arg);
          case 'log': case 'ln': return Math.log(arg);
          case 'min': case 'max': return undefined; // 单参形式不支持
          default: return undefined;
        }
      }
      return resolve(name);
    }
    return undefined;
  }
  function parsePow(): number | undefined {
    let v = parsePrimary();
    while (peek() === '**' || peek() === '^') { next(); const r = parsePrimary(); if (v === undefined || r === undefined) return undefined; v = Math.pow(v, r); }
    return v;
  }
  function parseMul(): number | undefined {
    let v = parsePow();
    while (peek() === '*' || peek() === '/') { const op = next(); const r = parsePow(); if (v === undefined || r === undefined) return undefined; v = op === '*' ? v * r : v / r; }
    return v;
  }
  function parseAdd(): number | undefined {
    let v = parseMul();
    while (peek() === '+' || peek() === '-') { const op = next(); const r = parseMul(); if (v === undefined || r === undefined) return undefined; v = op === '+' ? v + r : v - r; }
    return v;
  }
  const result = parseAdd();
  if (pos !== tokens.length) return undefined;
  return result;
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /\*\*|[()+\-*/^]|\d+\.?\d*(?:[eE][+-]?\d+)?[A-Za-z]*|\.\d+(?:[eE][+-]?\d+)?[A-Za-z]*|[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[0]);
  return out;
}
