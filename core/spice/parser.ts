/**
 * SPICE 解析器（导入层）：不改写任何原文。
 * 保留：原文本、行续接、子电路实例、参数表达式、model 版本、include 来源、单位后缀。
 */
import {
  KNOWN_DEVICE_LETTERS,
  type ExprNode,
  type NetlistFile,
  type ParamAssign,
  type RawLine,
  type Statement,
  type ValueToken,
} from './model';

/** 把逻辑行切成 token，尊重 {} 表达式、() 分组与引号 */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let depthBrace = 0;
  let depthParen = 0;
  let inQuote: string | null = null;
  const flush = () => {
    if (cur.length > 0) tokens.push(cur);
    cur = '';
  };
  for (const ch of line) {
    if (inQuote) {
      cur += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      cur += ch;
      continue;
    }
    if (ch === '{') depthBrace++;
    if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
    if (ch === '(') depthParen++;
    if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    if (/\s/.test(ch) && depthBrace === 0 && depthParen === 0) {
      flush();
    } else if (ch === ',' && depthBrace === 0 && depthParen === 0) {
      flush();
    } else {
      cur += ch;
    }
  }
  flush();
  return tokens;
}

/** 解析 { ... } 参数表达式为 AST，保留依赖（不可压平） */
export function parseExpression(src: string): ExprNode {
  const inner = src.trim().replace(/^\{/, '').replace(/\}$/, '');
  let pos = 0;
  const peek = () => inner[pos];
  const skipWs = () => {
    while (pos < inner.length && /\s/.test(inner[pos])) pos++;
  };
  function parsePrimary(): ExprNode {
    skipWs();
    const ch = peek();
    if (ch === '(') {
      pos++;
      const e = parseAdd();
      skipWs();
      if (peek() === ')') pos++;
      return e;
    }
    if (ch === '-' || ch === '+') {
      pos++;
      const operand = parsePrimary();
      return ch === '-' ? { kind: 'op', op: 'neg', args: [operand] } : operand;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(inner.slice(pos));
    if (m) {
      pos += m[0].length;
      skipWs();
      if (peek() === '(') {
        // 函数调用：作为 op 保留
        pos++;
        const args: ExprNode[] = [];
        while (pos < inner.length && peek() !== ')') {
          args.push(parseAdd());
          skipWs();
          if (peek() === ',') pos++;
        }
        if (peek() === ')') pos++;
        return { kind: 'op', op: `fn:${m[0]}`, args };
      }
      return { kind: 'ref', name: m[0] };
    }
    const n = /^[0-9.]+(?:[eE][+-]?\d+)?[A-Za-z]*/.exec(inner.slice(pos));
    if (n) {
      pos += n[0].length;
      return { kind: 'num', raw: n[0] };
    }
    // 无法识别的字符：跳过，保证健壮
    pos++;
    return { kind: 'num', raw: '0' };
  }
  function parseMul(): ExprNode {
    let left = parsePrimary();
    for (;;) {
      skipWs();
      const ch = peek();
      if (ch === '*' || ch === '/') {
        pos++;
        left = { kind: 'op', op: ch, args: [left, parsePrimary()] };
      } else return left;
    }
  }
  function parseAdd(): ExprNode {
    let left = parseMul();
    for (;;) {
      skipWs();
      const ch = peek();
      if (ch === '+' || ch === '-') {
        pos++;
        left = { kind: 'op', op: ch, args: [left, parseMul()] };
      } else return left;
    }
  }
  return parseAdd();
}

/** 提取表达式依赖的参数名 */
export function exprDeps(e: ExprNode): string[] {
  const out = new Set<string>();
  const walk = (n: ExprNode) => {
    if (n.kind === 'ref') out.add(n.name);
    else if (n.kind === 'op') n.args.forEach(walk);
  };
  walk(e);
  return [...out].sort();
}

function makeValue(raw: string): ValueToken {
  const t = raw.trim();
  if (t.startsWith('{') && t.endsWith('}')) {
    return { raw: t, kind: 'expr', expr: parseExpression(t) };
  }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[A-Za-z]*$/.test(t)) {
    return { raw: t, kind: 'number' };
  }
  if (t.startsWith('"') || t.startsWith("'")) return { raw: t, kind: 'string' };
  return { raw: t, kind: 'ident' };
}

function parseAssign(token: string): ParamAssign | null {
  const eq = token.indexOf('=');
  if (eq <= 0) return null;
  const key = token.slice(0, eq).trim();
  const value = token.slice(eq + 1).trim();
  if (!key || !value) return null;
  return { key, value: makeValue(value), raw: token };
}

/** 把一个网表文件解析为语句序列（保留行续接与原文） */
export function parseNetlist(path: string, rawText: string, role: NetlistFile['role'] = 'netlist'): NetlistFile {
  const fileId = `file:${path}`;
  const physical = rawText.split(/\r?\n/);
  // 1) 组装逻辑行（行续接保留）
  const logical: { lines: RawLine[]; raw: string; startLine: number }[] = [];
  physical.forEach((text, i) => {
    const line: RawLine = { file: path, line: i + 1, text, continued: /^\s*\+/.test(text) };
    if (line.continued && logical.length > 0) {
      const cur = logical[logical.length - 1];
      cur.lines.push(line);
      cur.raw += '\n' + text;
    } else {
      logical.push({ lines: [line], raw: text, startLine: i + 1 });
    }
  });

  const statements: Statement[] = [];
  let stmtIndex = 0;
  const nextId = () => `stmt:${path}:${stmtIndex++}`;

  logical.forEach((lg, li) => {
    const id = nextId();
    const source = { file: path, line: lg.startLine, statementId: id };
    const base = { id, raw: lg.raw, lines: lg.lines, source };
    // 续行内容并入分析文本：去掉行首 '+' 后拼接
    const analysis = lg.lines.map((l) => l.text.replace(/^\s*\+\s?/, ' ')).join(' ').trim();
    const firstToken = tokenize(analysis)[0] ?? '';

    if (li === 0 && !analysis.startsWith('.') && !analysis.startsWith('*') && analysis.length > 0) {
      statements.push({ ...base, type: 'title', text: analysis });
      return;
    }
    if (analysis.startsWith('*') || analysis.length === 0) {
      statements.push({ ...base, type: 'comment', text: analysis });
      return;
    }
    if (analysis.startsWith('.')) {
      const tokens = tokenize(analysis);
      const directive = tokens[0].slice(1).toLowerCase();
      switch (directive) {
        case 'subckt': {
          const name = tokens[1] ?? '';
          const ports: string[] = [];
          const defaults: ParamAssign[] = [];
          for (const t of tokens.slice(2)) {
            const a = parseAssign(t);
            if (a) defaults.push(a);
            else if (/^params:?$/i.test(t)) continue;
            else ports.push(t);
          }
          statements.push({ ...base, type: 'subckt', name, ports, defaults });
          return;
        }
        case 'ends': {
          statements.push({ ...base, type: 'ends', name: tokens[1] ?? null });
          return;
        }
        case 'model': {
          const name = tokens[1] ?? '';
          const modelType = (tokens[2] ?? '').replace(/[()]/g, '');
          const params: ParamAssign[] = [];
          for (const t of tokens.slice(3)) {
            const a = parseAssign(t.replace(/[()]/g, ''));
            if (a) params.push(a);
          }
          statements.push({ ...base, type: 'model', name, modelType, params });
          return;
        }
        case 'include':
        case 'inc': {
          const p = (tokens[1] ?? '').replace(/^['"]|['"]$/g, '');
          statements.push({ ...base, type: 'include', path: p });
          return;
        }
        case 'param': {
          const params: ParamAssign[] = [];
          for (const t of tokens.slice(1)) {
            const a = parseAssign(t);
            if (a) params.push(a);
          }
          statements.push({ ...base, type: 'param', params });
          return;
        }
        case 'end': {
          statements.push({ ...base, type: 'end' });
          return;
        }
        default: {
          statements.push({ ...base, type: 'directive', name: directive, args: tokens.slice(1) });
          return;
        }
      }
    }
    // 器件行
    const tokens = tokenize(analysis);
    const name = tokens[0] ?? '';
    const kindLetter = (name[0] ?? '?').toUpperCase();
    const known = KNOWN_DEVICE_LETTERS.has(kindLetter);
    const params: ParamAssign[] = [];
    const ordered: string[] = [];
    for (const t of tokens.slice(1)) {
      const a = parseAssign(t);
      if (a) params.push(a);
      else ordered.push(t);
    }
    const split = splitDeviceTokens(kindLetter, ordered);
    statements.push({
      ...base,
      type: 'device',
      name,
      kindLetter,
      known,
      nodes: split.nodes,
      positional: split.positional,
      params,
    });
  });

  return { id: fileId, path, role, rawText, statements };
}

/** 已知元件按节点数约定拆分；未知元件：标识符视为 opaque 连接，数值视为取值 */
function splitDeviceTokens(
  kind: string,
  ordered: string[],
): { nodes: string[]; positional: ValueToken[] } {
  const nodeCount: Record<string, number> = {
    R: 2, C: 2, L: 2, D: 2, V: 2, I: 2, K: 2, S: 3, W: 3,
    Q: 3, M: 4, J: 3, E: 4, G: 4, F: 2, H: 2, T: 4, B: 2,
  };
  if (kind === 'X') {
    // X 实例：最后一个位置 token 是子电路名，其余是节点（子电路实例原样保留）
    const nodes = ordered.slice(0, Math.max(0, ordered.length - 1));
    const last = ordered.length > 0 ? [ordered[ordered.length - 1]] : [];
    return { nodes, positional: last.map((s) => makeValue(s)) };
  }
  const n = nodeCount[kind];
  if (n === undefined) {
    // 未知元件：数值样 token 作为取值，其余全部作为 opaque 连接保留（不删除）
    const nodes: string[] = [];
    const positional: ValueToken[] = [];
    for (const t of ordered) {
      if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[A-Za-z]*$/.test(t) || t.startsWith('{')) {
        positional.push(makeValue(t));
      } else {
        nodes.push(t);
      }
    }
    return { nodes, positional };
  }
  const nodes = ordered.slice(0, n);
  const positional = ordered.slice(n).map((s) => makeValue(s));
  return { nodes, positional };
}
