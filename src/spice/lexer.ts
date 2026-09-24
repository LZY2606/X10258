import type { Coord, Origin, SourceFile, SourceLine, Token } from '../shared/types';
import { stableId } from './ident';

/** 物理行切分：保留行续接关系，不改写任何字符。 */
export function splitPhysicalLines(file: SourceFile): SourceLine[] {
  const out: SourceLine[] = [];
  const rawLines = file.rawText.split(/\r\n|\r|\n/);
  rawLines.forEach((raw, idx) => {
    const physicalLine = idx + 1;
    out.push({
      id: `${file.fileId}:L${physicalLine}`,
      fileId: file.fileId,
      physicalLine,
      raw,
      continuation: /^\s*\+/.test(raw),
    });
  });
  return out;
}

export interface LogicalRaw {
  /** 组成该逻辑行的物理行 id（顺序保留） */
  physicalIds: string[];
  /** 拼接后的文本（续行的 '+' 保留为原样；仅用于 token 化，展示仍逐行） */
  joined: string;
  start: Origin;
}

/**
 * 把物理行聚成逻辑行：
 *  - 以 '+' 开头的物理行续接上一逻辑行；
 *  - 注释（* 起始）与控制行（. 起始）规则按 ngspice；
 *  - 不删除、不改写原文。
 */
export function logicalLines(file: SourceFile, lines: SourceLine[], includeChain: string[] = []): { raws: LogicalRaw[]; commentLines: SourceLine[] } {
  const raws: LogicalRaw[] = [];
  const commentLines: SourceLine[] = [];
  let cur: LogicalRaw | null = null;

  const coordOf = (lineNo: number, col: number): Coord => ({ line: lineNo, column: col });
  const originOf = (lineNo: number, col: number): Origin => ({ fileId: file.fileId, path: file.path, includeChain, start: coordOf(lineNo, col) });

  for (const ln of lines) {
    const trimmed = ln.raw.trimStart();
    if (cur && ln.continuation) {
      // 续行：以一个空格连接，'+' 仍保留在 joined 中（语义上等同分隔）。
      cur.physicalIds.push(ln.id);
      cur.joined += ' ' + ln.raw.replace(/^\s*\+\s?/, '');
      continue;
    }
    if (trimmed === '' ) { if (cur) { raws.push(cur); cur = null; } continue; }
    if (trimmed.startsWith('*')) { if (cur) { raws.push(cur); cur = null; } commentLines.push(ln); continue; }
    if (cur) raws.push(cur);
    cur = { physicalIds: [ln.id], joined: ln.raw.trim(), start: originOf(ln.physicalLine, ln.raw.length - trimmed.length) };
  }
  if (cur) raws.push(cur);
  return { raws, commentLines };
}

/** 逻辑行 token 化：支持花括号表达式与引号串；token 保留原样大小写。 */
export function tokenizeLogical(raw: string, startLine: number): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let col = 0;
  const push = (text: string, c: number, line = startLine): void => {
    toks.push({ text, start: { line, column: c }, end: { line, column: c + text.length } });
  };
  while (i < raw.length) {
    const c = raw[i];
    if (c === ' ' || c === '\t') { i++; col++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < raw.length && raw[j] !== '"') j++;
      push(raw.slice(i, j + 1), col);
      col += j + 1 - i; i = j + 1; continue;
    }
    if (c === '{' ) {
      // 花括号表达式作为单个 token 保留（含括号），不改写
      let depth = 1; let j = i + 1;
      while (j < raw.length && depth > 0) { if (raw[j] === '{') depth++; else if (raw[j] === '}') depth--; j++; }
      push(raw.slice(i, j), col);
      col += j - i; i = j; continue;
    }
    if (c === '=' ) { push('=', col); i++; col++; continue; }
    let j = i + 1;
    while (j < raw.length && raw[j] !== ' ' && raw[j] !== '\t' && raw[j] !== '=') j++;
    push(raw.slice(i, j), col);
    col += j - i; i = j;
  }
  return toks;
}

export function fileIdFor(path: string): string {
  return stableId('file', path);
}
