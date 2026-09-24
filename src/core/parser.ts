// SPICE 解析器：导入层只保留原始表示。
// 原文本、行续接、子电路实例、参数表达式、model 版本、include 来源、单位后缀均不改写。
import { createHash } from 'node:crypto';
import { parseValue, type ParsedValue } from './units.js';

export interface Diagnostic {
  id: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  fileId?: string;
  line?: number;
  raw?: string;
}

export interface SourceFile {
  id: string;
  path: string;
  rawText: string;
  sha: string;
}

export function makeSourceFile(path: string, rawText: string): SourceFile {
  const sha = createHash('sha256').update(rawText).digest('hex').slice(0, 16);
  return { id: `file:${path}`, path, rawText, sha };
}

export type StmtKind =
  | 'title' | 'comment' | 'subckt' | 'ends' | 'model' | 'include' | 'lib'
  | 'param' | 'options' | 'element' | 'end' | 'directive' | 'unknown';

export interface Statement {
  id: string; // 稳定身份：fileId#L起始行
  fileId: string;
  startLine: number;
  endLine: number;
  raw: string; // 含续行，逐字保留
  kind: StmtKind;
  name?: string;
  elemKind?: string;
  nodes?: string[];
  modelRef?: string;
  positional?: string[];
  params?: Record<string, string>; // 原始表达式字符串，不求值
  subcktName?: string;
  subcktNodes?: string[];
  subcktDefaults?: Record<string, string>;
  modelName?: string;
  modelType?: string;
  modelParams?: Record<string, string>;
  includePath?: string;
  libSection?: string;
  paramDefs?: Record<string, string>;
}

/** 切分 token：尊重 {表达式} 与引号，不改动内容。 */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '{') { depth++; cur += ch; continue; }
    if (ch === '}') { depth = Math.max(0, depth - 1); cur += ch; continue; }
    if (depth === 0 && (ch === ' ' || ch === '\t' || ch === ',')) {
      if (cur) { tokens.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** 拆分 key=value 与位置参数，保留原始字符串。 */
export function splitParams(tokens: string[]): { positional: string[]; params: Record<string, string> } {
  const positional: string[] = [];
  const params: Record<string, string> = {};
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq > 0 && !tok.startsWith('{')) {
      params[tok.slice(0, eq)] = tok.slice(eq + 1);
    } else {
      positional.push(tok);
    }
  }
  return { positional, params };
}

const KNOWN_ELEM_KINDS = new Set(['R', 'C', 'L', 'V', 'I', 'M', 'Q', 'D', 'J', 'X', 'K', 'E', 'F', 'G', 'H', 'S', 'W', 'B']);

export function parseFile(file: SourceFile): { statements: Statement[]; diagnostics: Diagnostic[] } {
  const lines = file.rawText.split(/\r?\n/);
  const statements: Statement[] = [];
  const diagnostics: Diagnostic[] = [];
  interface Group { start: number; end: number; raw: string; }
  const groups: Group[] = [];
  let cur: Group | null = null;
  const pushCur = () => { if (cur) { groups.push(cur); cur = null; } };

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith('+') && cur) {
      cur.raw += '\n' + line;
      cur.end = lineNo;
      return;
    }
    pushCur();
    cur = { start: lineNo, end: lineNo, raw: line };
  });
  pushCur();

  let firstContent = true;
  for (const g of groups) {
    const firstLine = g.raw.split('\n')[0];
    const trimmed = firstLine.trim();
    const id = `${file.id}#L${g.start}`;
    const base = { id, fileId: file.id, startLine: g.start, endLine: g.end, raw: g.raw };
    if (trimmed === '') { continue; }
    if (firstContent && !trimmed.startsWith('*') && !trimmed.startsWith('.')) {
      statements.push({ ...base, kind: 'title' });
      firstContent = false;
      continue;
    }
    firstContent = false;
    if (trimmed.startsWith('*')) {
      statements.push({ ...base, kind: 'comment' });
      continue;
    }
    // 续行合并后的逻辑行（仅用于解析；raw 保持逐字）
    const logical = g.raw.split('\n').map((l, i) => (i === 0 ? l : l.trim().replace(/^\+/, ''))).join(' ');
    const tokens = tokenize(logical);
    const head = tokens[0] ?? '';
    if (head.startsWith('.')) {
      const dir = head.toLowerCase();
      if (dir === '.subckt') {
        const name = tokens[1] ?? '';
        const rest = tokens.slice(2);
        const paramsIdx = rest.findIndex((t) => t.toLowerCase() === 'params:');
        const nodeToks = paramsIdx >= 0 ? rest.slice(0, paramsIdx) : rest.filter((t) => !t.includes('='));
        const paramToks = paramsIdx >= 0 ? rest.slice(paramsIdx + 1) : rest.filter((t) => t.includes('='));
        const { params } = splitParams(paramToks);
        statements.push({ ...base, kind: 'subckt', subcktName: name, subcktNodes: nodeToks, subcktDefaults: params });
      } else if (dir === '.ends') {
        statements.push({ ...base, kind: 'ends', subcktName: tokens[1] });
      } else if (dir === '.model') {
        const modelName = tokens[1] ?? '';
        const modelType = tokens[2] ?? '';
        const rest = tokens.slice(3).join(' ').replace(/^\(/, '').replace(/\)$/, '');
        const { params } = splitParams(tokenize(rest));
        statements.push({ ...base, kind: 'model', modelName, modelType, modelParams: params });
      } else if (dir === '.include' || dir === '.inc') {
        statements.push({ ...base, kind: 'include', includePath: (tokens[1] ?? '').replace(/^['"]|['"]$/g, '') });
      } else if (dir === '.lib') {
        statements.push({ ...base, kind: 'lib', includePath: (tokens[1] ?? '').replace(/^['"]|['"]$/g, ''), libSection: tokens[2] });
      } else if (dir === '.param') {
        const { params } = splitParams(tokens.slice(1));
        statements.push({ ...base, kind: 'param', paramDefs: params });
      } else if (dir === '.end') {
        statements.push({ ...base, kind: 'end' });
      } else if (dir === '.options' || dir === '.opt') {
        statements.push({ ...base, kind: 'options' });
      } else {
        statements.push({ ...base, kind: 'directive' });
        diagnostics.push({ id: `diag:${id}`, severity: 'info', message: `未识别的仿真指令 ${head}，按原样保留不参与连接`, fileId: file.id, line: g.start, raw: g.raw });
      }
      continue;
    }
    // 元件行
    const name = head;
    const elemKind = (name[0] ?? '').toUpperCase();
    const rest = tokens.slice(1);
    if (!KNOWN_ELEM_KINDS.has(elemKind)) {
      statements.push({ ...base, kind: 'unknown', name, elemKind, tokens: rest });
      diagnostics.push({ id: `diag:${id}`, severity: 'warning', message: `未知元件类型 "${elemKind}"（${name}）：保留 opaque 连接，不删除`, fileId: file.id, line: g.start, raw: g.raw });
      continue;
    }
    if (elemKind === 'X') {
      // 子电路实例：节点… 子电路名 参数
      const { positional, params } = splitParams(rest);
      const subcktRef = positional.length > 0 ? positional[positional.length - 1] : '';
      statements.push({ ...base, kind: 'element', name, elemKind, nodes: positional.slice(0, -1), modelRef: subcktRef, params });
      continue;
    }
    const { positional, params } = splitParams(rest);
    // 通用切分：前 N 个为节点，随后可选 model 与取值。按类型给出节点数。
    const nodeCounts: Record<string, number> = { R: 2, C: 2, L: 2, V: 2, I: 2, D: 2, Q: 3, M: 4, J: 3, E: 4, G: 4, B: 2 };
    const nCount = nodeCounts[elemKind] ?? Math.max(0, positional.length - 1);
    const nodes = positional.slice(0, nCount);
    const tail = positional.slice(nCount);
    let modelRef: string | undefined;
    let valueToks = tail;
    if (['M', 'Q', 'D', 'J'].includes(elemKind) && tail.length > 0) {
      modelRef = tail[0];
      valueToks = tail.slice(1);
    }
    statements.push({ ...base, kind: 'element', name, elemKind, nodes, modelRef, positional: valueToks, params });
  }
  return { statements, diagnostics };
}

/** 元件行的规范化取值（派生层）：raw 保留，normalized 可能缺失。 */
export function elementValues(stmt: Statement): { token: string; parsed: ParsedValue }[] {
  return (stmt.positional ?? []).map((t) => ({ token: t, parsed: parseValue(t) }));
}
