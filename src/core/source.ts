// 源层：原文本、物理行、行续接、逻辑行、分词。
// 原则：rawText 与物理行逐字节保留；逻辑行仅记录“如何由续接构成”，不改写 token。
import {
  fileId, logicalLineId, sha256, type LogicalLine, type PhysicalLine, type SourceFile
} from './ids.js';
import type {} from './types.js';

/** 按 LF/CRLF 切物理行；保留每行原文（不含换行符本身）。 */
export function splitPhysicalLines(raw: string): PhysicalLine[] {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parts = normalized.split('\n');
  // split 会在文件以换行结尾时多产生一个空串；保留该空串以忠实反映物理行。
  return parts.map((text, index) => ({
    index,
    text,
    // 行续接：物理行最后一个非空白字符为 '+'，且该行不是整行注释
    hasContinuation: text.trimEnd().endsWith('+') && !text.startsWith('*')
  }));
}

/**
 * 逻辑行：
 * - 以 '*' 开头的物理行是整行注释（独立逻辑行，原样保留）。
 * - 物理行去前导空白后以 '+' 开头，则续接到上一条逻辑行。
 */
export function buildLogicalLines(phys: PhysicalLine[]): LogicalLine[] {
  const lines: LogicalLine[] = [];
  for (const pl of phys) {
    const fullComment = pl.text.startsWith('*');
    const isContinuation = /^\s*\+/.test(pl.text) && lines.length > 0 && !fullComment;
    if (!isContinuation) {
      lines.push({
        id: '',
        physicalStart: pl.index,
        physicalEnd: pl.index,
        segments: [pl.text],
        joined: pl.text,
        comment: null
      });
    } else {
      const target = lines[lines.length - 1];
      target.segments.push(pl.text.replace(/^\s*\+/, ''));
      target.physicalEnd = pl.index;
      target.joined = target.segments
        .map((s, i) => (i === 0 ? s.trimEnd() : s))
        .join(' ');
    }
  }
  return lines;
}

/** 提取行内注释（$ 起）与 token；原文保留在 token 中。.ENDS/$ 不做语义删除。 */
export function tokenize(joined: string): { tokens: string[]; comment: string | null } {
  let code = joined;
  let comment: string | null = null;
  const dollar = indexOfCommentDollar(joined);
  if (dollar >= 0) {
    comment = joined.slice(dollar);
    code = joined.slice(0, dollar);
  }
  const tokens = code.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return { tokens, comment };
}

function indexOfCommentDollar(s: string): number {
  let quote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') quote = !quote;
    if (!quote && ch === '$') return i;
  }
  return -1;
}

export function makeSourceFile(
  bundle: string, relPath: string, rawText: string
): SourceFile {
  const id = fileId(bundle, relPath);
  const physicalLines = splitPhysicalLines(rawText);
  const logicalLines = buildLogicalLines(physicalLines);
  for (const l of logicalLines) {
    const { comment } = tokenize(l.joined);
    l.comment = comment;
    l.id = logicalLineId(id, l.physicalStart);
  }
  return {
    id, path: relPath.split('\\').join('/'), rawText,
    sha256: sha256(rawText), physicalLines, logicalLines
  };
}
