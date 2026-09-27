import type { RawLine, SourceFile, Token } from './types';

/**
 * 逻辑行 = 物理行 + 以 '+' 开头的续行。
 * rawSegments 逐字保留物理行原文（含换行前的 '+'），joined 仅供词法分析。
 * 注释 '*' 与行内注释 ';' 区分（';' 在 SPICE 中为行内注释起始）。
 */
export function splitLogicalLines(source: SourceFile): RawLine[] {
  const text = source.rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const physical = text.split('\n');
  // 文件以换行结尾会产生一个空串物理行，保留它但不影响逻辑行
  const lines: RawLine[] = [];
  let i = 0;
  let logical = 0;
  const isContinuation = (s: string) => s.startsWith('+');

  while (i < physical.length) {
    const first = physical[i];
    const start = i;
    const segments = [first];
    i++;
    while (i < physical.length && isContinuation(physical[i])) {
      segments.push(physical[i]);
      i++;
    }
    const joined = segments
      .map((seg, idx) => (idx === 0 ? seg : ' ' + seg.slice(1)))
      .join('')
      .trim();
    lines.push({
      id: `${source.id}::L${logical + 1}`,
      sourceId: source.id,
      logicalIndex: logical + 1,
      physicalFrom: start + 1,
      physicalTo: start + segments.length,
      rawSegments: segments,
      joined,
    });
    logical++;
  }
  return lines;
}

/** 在已去注释的 joined 文本上取 token 及字符坐标 */
export function tokenize(joined: string): { tokens: Token[]; commentStart: number | null } {
  const tokens: Token[] = [];
  let i = 0;
  let commentStart: number | null = null;
  while (i < joined.length) {
    const c = joined[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === ';') { commentStart = i; break; }
    // 花括号表达式作为单个 token（含括号），保留内部原文
    if (c === '{') {
      const start = i;
      let depth = 0;
      do {
        if (joined[i] === '{') depth++;
        else if (joined[i] === '}') depth--;
        i++;
      } while (i < joined.length && depth > 0);
      tokens.push({ text: joined.slice(start, i), start, end: i });
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      while (i < joined.length && joined[i] !== quote) i++;
      i++;
      tokens.push({ text: joined.slice(start, i), start, end: i });
      continue;
    }
    if (c === '=') { tokens.push({ text: '=', start: i, end: i + 1 }); i++; continue; }
    const start = i;
    while (i < joined.length && joined[i] !== ' ' && joined[i] !== '\t' && joined[i] !== '=' && joined[i] !== ';') i++;
    tokens.push({ text: joined.slice(start, i), start, end: i });
  }
  return { tokens, commentStart };
}

export function stripComment(joined: string): string {
  // 返回去注释文本，但坐标保持不变（注释部分替换为空格）
  const idx = joined.indexOf(';');
  if (idx < 0) return joined;
  return joined.slice(0, idx) + ' '.repeat(joined.length - idx);
}
