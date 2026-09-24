import { createHash } from 'node:crypto';
import type { RawStatement, RawParam, SourceFile } from './types';

// 原样切分行（含续接），不做任何规范化改写。
export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export function makeSource(id: string, path: string, text: string): SourceFile {
  return { id, path, text: text.replace(/\r\n/g, '\n'), sha: sha1(text.replace(/\r\n/g, '\n')) };
}

const SUFFIX_CHARS = new Set('tgmkunpf'); // meg 单独处理

// 从 token 中抽出表达式依赖（标识符），不改变原表达式。
export function exprDeps(rawExpr: string): string[] {
  const inner = rawExpr.trim().replace(/^\{/, '').replace(/\}$/, '');
  const deps = new Set<string>();
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  const fns = new Set(['abs','log','ln','exp','sqrt','sin','cos','tan','min','max','pow','if','sgn','floor','ceil']);
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    const name = m[0];
    if (fns.has(name.toLowerCase())) continue;
    // 单位后缀式数字（如 2u）不会命中：数字开头
    deps.add(name);
  }
  return [...deps];
}

function parseParams(tokens: string[]): RawParam[] {
  const out: RawParam[] = [];
  for (const t of tokens) {
    const eq = t.indexOf('=');
    if (eq > 0) {
      const name = t.slice(0, eq);
      const rawExpr = t.slice(eq + 1);
      out.push({ name, rawExpr, deps: exprDeps(rawExpr) });
    }
  }
  return out;
}

export interface ParsedSource {
  source: SourceFile;
  statements: RawStatement[];
}

const DIRECTIVES = new Set(['subckt','ends','param','model','include','lib','end','global','option','options','func','temp','dc','ac','tran','print','plot','measure']);

// 解析：原文本与每个结构对象并存；注释、续接原样保留。
export function parseSource(source: SourceFile): ParsedSource {
  const lines = source.text.split('\n');
  const statements: RawStatement[] = [];

  const groups: { start: number; end: number; rawLines: string[]; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i + 1 < lines.length && /^\s*\+/.test(lines[i + 1])) {
      const start = i;
      const rawLines: string[] = [];
      let text = line;
      rawLines.push(line);
      while (i + 1 < lines.length && /^\s*\+/.test(lines[i + 1])) {
        i++;
        rawLines.push(lines[i]);
        // 行续接：保留原始行；拼接仅用于结构解析
        text += ' ' + lines[i].replace(/^\s*\+\s?/, '');
      }
      groups.push({ start, end: i, rawLines, text });
    } else {
      groups.push({ start: i, end: i, rawLines: [line], text: line });
    }
  }

  for (const g of groups) {
    const first = g.text.trimStart();
    const lineStart = g.start + 1;
    const lineEnd = g.end + 1;
    const continued = g.rawLines.length > 1;
    const id = `stmt:${source.id}:${lineStart}`;
    const raw = g.rawLines.join('\n');

    let kind: RawStatement['kind'] = 'other';
    const stmt: RawStatement = {
      id, sourceId: source.id, lineStart, lineEnd, continued, raw, kind,
    };

    if (first === '' ) { kind = 'blank'; stmt.kind = kind; statements.push(stmt); continue; }
    if (first.startsWith('*')) { kind = 'comment'; stmt.kind = kind; statements.push(stmt); continue; }

    if (first.startsWith('.')) {
      const directive = first.slice(1).split(/[\s(]/)[0].toLowerCase();
      const body = first.slice(1).trim();
      const dirWord = body.split(/[\s(]/)[0].toLowerCase();
      stmt.head = dirWord;
      const rest = body.slice(dirWord.length).trim();
      if (dirWord === 'subckt') {
        kind = 'subckt';
        const toks = tokenize(rest);
        stmt.name = toks[0]?.toLowerCase();
        const portEnd = toks.findIndex((t, i) => i > 0 && t.includes('='));
        const cut = portEnd === -1 ? toks.length : portEnd;
        stmt.ports = toks.slice(1, cut).map(n => n.toLowerCase());
        stmt.params = parseParams(toks.slice(cut));
      } else if (dirWord === 'ends') {
        kind = 'ends';
        stmt.name = rest.toLowerCase() || undefined;
      } else if (dirWord === 'param') {
        kind = 'param';
        stmt.params = parseParams(tokenizeParamList(rest));
      } else if (dirWord === 'model') {
        kind = 'model';
        // .model name type ( params ) — model 版本原样保留
        const m = /^(\S+)\s+(\S+)\s*\(([\s\S]*)\)\s*$/.exec(rest);
        if (m) {
          stmt.name = m[1].toLowerCase();
          stmt.modelType = m[2].toUpperCase();
          stmt.params = parseParams(tokenizeParamList(m[3]));
        } else {
          const toks = tokenize(rest);
          stmt.name = toks[0]?.toLowerCase();
          stmt.modelType = toks[1]?.toUpperCase();
        }
      } else if (dirWord === 'include' || dirWord === 'lib') {
        kind = 'include';
        stmt.includeTarget = rest.replace(/^["']|["']$/g, '').split(/\s+/)[0];
      } else if (dirWord === 'end') {
        kind = 'end';
      } else if (DIRECTIVES.has(dirWord)) {
        kind = 'other';
      } else {
        kind = 'other';
      }
      stmt.kind = kind;
      statements.push(stmt);
      continue;
    }

    // 元素 / 子电路实例
    const letter = first[0].toUpperCase();
    const toks = tokenize(first);
    stmt.head = letter;
    stmt.name = toks[0];
    if (letter === 'X') {
      kind = 'instance';
      // 节点：直到第一个带 = 的参数或子电路名（最后一个非参数 token）
      const firstParam = toks.findIndex((t, i) => i > 0 && t.includes('='));
      const until = firstParam === -1 ? toks.length : firstParam;
      // SPICE: Xname n1 n2 ... subckt [params]
      stmt.subckt = toks[until - 1]?.toLowerCase();
      stmt.nodes = toks.slice(1, until - 1).map(n => n.toLowerCase());
      stmt.params = parseParams(toks.slice(until));
    } else if ('RCLVGIFEHBKQTUDMSAYJZ'.includes(letter)) {
      kind = 'element';
      const firstParam = toks.findIndex((t, i) => i > 0 && t.includes('='));
      const until = firstParam === -1 ? toks.length : firstParam;
      stmt.nodes = toks.slice(1, until).map(n => n.toLowerCase());
      stmt.params = parseParams(toks.slice(until));
      // model 引用（D/Q/M 等）：节点后第一个非参数 token
      if (['D','Q','M','J','U','Z','S','B','G','E','F','H','K','T','V','I'].includes(letter)) {
        const afterNodes = toks.slice(1);
        const mp = afterNodes.findIndex(t => !t.includes('='));
        if (mp >= 0 && letter !== 'V' && letter !== 'I') stmt.model = afterNodes[mp].toLowerCase();
      }
      stmt.unknown = !'RCLVGIFEHBKQTUDMSAYJZ'.includes(letter) || false;
    } else {
      // 未知元件：保留原样，标记 unknown，连接不删除
      kind = 'element';
      stmt.unknown = true;
      stmt.nodes = toks.slice(1).filter(t => !t.includes('=')).map(n => n.toLowerCase());
      stmt.params = parseParams(toks.filter(t => t.includes('=')));
    }
    stmt.kind = kind;
    statements.push(stmt);
  }
  return { source, statements };
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /"[^"]*"|\{[^{}]*\}|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[0]);
  return out;
}

function tokenizeParamList(text: string): string[] {
  // .param a=1 b={x*2} ；逗号或空白分隔
  return tokenize(text).map(t => t.replace(/^,/, '').replace(/,$/, '')).filter(Boolean);
}
