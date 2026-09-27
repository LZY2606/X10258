/**
 * 词法层：物理行 -> 逻辑行（行续接）-> 保真令牌。
 * 不做任何大小写/数字/后缀规范化；原文逐字保存。
 */
import type { LogicalLine, Origin, ParamAssign, RawLine, SourceFile } from '../shared/types.js';
import { stableId } from '../shared/ids.js';

export function splitPhysicalLines(text: string): RawLine[] {
  // 逐字切分，保留空行；去掉行终止符但保留其存在信息。
  const lines: RawLine[] = [];
  let start = 0;
  let lineNo = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      lineNo += 1;
      let raw = text.slice(start, i);
      if (raw.endsWith('\r')) raw = raw.slice(0, -1);
      lines.push({ fileId: '', lineNo, raw, logicalNo: 0, continuationIndex: 0 });
      start = i + 1;
      if (i === text.length) break;
    }
  }
  return lines;
}

/**
 * 行续接规则（SPICE）：下一物理行第一个非空字符是 '+'，则拼接到当前逻辑行。
 * 首字符为 '*' 的是整行注释（即使在续接语境也不拼接——严格 SPICE 行为）。
 */
export function buildLogicalLines(rawLines: RawLine[]): LogicalLine[] {
  const out: LogicalLine[] = [];
  let current: LogicalLine | null = null;
  let cont = 0;

  for (const rl of rawLines) {
    const isCont = rl.raw.trimStart().startsWith('+') && current !== null && !current.joinedRaw.trimStart().startsWith('*');
    if (isCont && current) {
      cont += 1;
      rl.logicalNo = current.logicalNo;
      rl.continuationIndex = cont;
      // 去掉续行起始的 '+' 与紧邻空白后拼接，但物理行原文仍可由 rawLines 反查。
      const piece = rl.raw.trimStart().slice(1);
      current.joinedRaw += ' ' + piece;
      current.physicalLines.push(rl.lineNo);
      current.hasContinuation = true;
      continue;
    }
    if (current) out.push(current);
    cont = 0;
    rl.continuationIndex = 0;
    rl.logicalNo = rl.lineNo;
    current = {
      fileId: rl.fileId,
      logicalNo: rl.lineNo,
      firstLineNo: rl.lineNo,
      physicalLines: [rl.lineNo],
      joinedRaw: rl.raw,
      tokens: [],
      inlineComment: null,
      hasContinuation: false,
    };
  }
  if (current) out.push(current);

  for (const ll of out) {
    const stripped = stripComment(ll.joinedRaw);
    ll.inlineComment = stripped.comment;
    ll.tokens = tokenizeRespectGroups(stripped.code);
  }
  return out;
}

function stripComment(line: string): { code: string; comment: string | null } {
  // 整行注释
  if (line.trimStart().startsWith('*')) {
    return { code: '', comment: line };
  }
  // 行内注释：ngspice ';'；HSPICE '$'。花括号/引号内的不算。
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{' || c === '(') depth++;
    else if (c === '}' || c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ';' || c === '$')) {
      return { code: line.slice(0, i), comment: line.slice(i) };
    }
  }
  return { code: line, comment: null };
}

/**
 * 令牌切分：空白分隔，但 { ... } 与 ( ... ) 内的空格不切分（参数表达式保持完整）。
 * 令牌原文不改写。
 */
export function tokenizeRespectGroups(code: string): string[] {
  const toks: string[] = [];
  let cur = '';
  let brace = 0;
  let paren = 0;
  let quote: string | null = null;
  const flush = (): void => { if (cur !== '') { toks.push(cur); cur = ''; } };
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '{') { brace++; cur += c; continue; }
    if (c === '}') { brace = Math.max(0, brace - 1); cur += c; continue; }
    if (c === '(') { paren++; cur += c; continue; }
    if (c === ')') { paren = Math.max(0, paren - 1); cur += c; continue; }
    if (/\s/.test(c) && brace === 0 && paren === 0) { flush(); continue; }
    cur += c;
  }
  flush();
  return toks;
}

export function makeOrigin(
  fileId: string,
  ll: LogicalLine,
  snippet = '',
): Origin {
  return {
    fileId,
    logicalNo: ll.logicalNo,
    firstLineNo: ll.firstLineNo,
    physicalLines: [...ll.physicalLines],
    snippet,
  };
}

/** 解析 NAME=VALUE 令牌（VALUE 可能是 {表达式}），逐字保留。 */
export function parseAssignToken(tok: string, origin: Origin): ParamAssign | null {
  const eq = findTopLevelEquals(tok);
  if (eq < 0) return null;
  const name = tok.slice(0, eq);
  let value = tok.slice(eq + 1);
  // 去掉包裹花括号（仅用于判定是表达式；raw 仍保留花括号信息于 exprRaw）。
  if (value.startsWith('{') && value.endsWith('}')) value = value;
  return {
    name,
    exprRaw: value,
    origin,
    hasDefault: value.length > 0,
  };
}

function findTopLevelEquals(tok: string): number {
  for (let i = 0; i < tok.length; i++) {
    if (tok[i] === '=') {
      // 跳过 >= <= == != 这类比较符
      if (i > 0 && '<>!='.includes(tok[i - 1])) continue;
      if (i + 1 < tok.length && tok[i + 1] === '=') continue;
      return i;
    }
  }
  return -1;
}

/** 去掉参数列表外层包裹括号： ( A=1 B=2 ) */
export function stripWrappingParens(tokens: string[]): string[] {
  if (tokens.length >= 2 && tokens[0] === '(' && tokens[tokens.length - 1] === ')') {
    return tokens.slice(1, -1);
  }
  return tokens;
}

export function makeFile(filePath: string, text: string, forcedFileId?: string): SourceFile {
  const fileId = forcedFileId ?? stableId('F', [filePath]);
  const rawLines = splitPhysicalLines(text);
  for (const rl of rawLines) rl.fileId = fileId;
  const logicalLines = buildLogicalLines(rawLines);
  for (const ll of logicalLines) ll.fileId = fileId;
  return {
    fileId,
    path: filePath,
    text,
    rawLines,
    logicalLines,
    items: [],
    diagnostics: [],
  };
}
