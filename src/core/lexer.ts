import { stableId } from "./ids.js";
import type { RawLogicalLine, SourceLoc } from "./types.js";

/** 保留行内容：按换行符切分，去掉行尾换行本身（行尾前后空白均保留）。 */
export function splitPhysicalLines(content: string): { rawText: string; line: number; noNewline: boolean }[] {
  const out: { rawText: string; line: number; noNewline: boolean }[] = [];
  let line = 1;
  let i = 0;
  while (i < content.length) {
    let j = i;
    while (j < content.length && content[j] !== "\n") j++;
    let text = content.slice(i, j);
    if (text.endsWith("\r")) text = text.slice(0, -1);
    const noNewline = j >= content.length;
    out.push({ rawText: text, line, noNewline });
    line++;
    i = j + 1;
  }
  return out;
}

/** SPICE 控制行：第一个非空白字符为 '.'。注释：整行 '*'，行内 ';' 或 '$'。 */
function classify(firstToken: string | undefined, rawLine: string): RawLogicalLine["kind"] {
  if (firstToken === undefined) return "blank";
  const t = firstToken;
  if (t.startsWith("*") && rawLine.trimStart().startsWith("*")) return "comment";
  if (t.startsWith(".")) return "control";
  return "element";
}

function tokenizeLogicalLine(joined: string): { tokens: string[]; comment: string | null } {
  // 行内注释：';' 始终生效；'$' 仅在它前面有空白/行首时生效（兼容 “$1e-3” 不会误判，
  // 但 SPICE 中 '$' 作为注释需要空白分隔；这里保守处理）。
  let code = joined;
  let comment: string | null = null;
  let cut = -1;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === ";") { cut = i; break; }
    if (ch === "$" && (i === 0 || /\s/.test(code[i - 1]!))) { cut = i; break; }
  }
  if (cut >= 0) {
    comment = code.slice(cut);
    code = code.slice(0, cut);
  }
  // 引号内整体作为一个 token（保留引号）。
  const tokens: string[] = [];
  const re = /"[^"]*"|'[^']*'|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) tokens.push(m[0]);
  return { tokens, comment };
}

/**
 * 把物理行合并为逻辑行：后续行第一个非空白字符为 '+' 表示行续接。
 * 每个物理行 rawText 原样保留；colStart/colEnd 指向逻辑首行。
 */
export function lexFile(fileId: string, content: string, includeChain: string[]): RawLogicalLine[] {
  const physical = splitPhysicalLines(content);
  const logicals: RawLogicalLine[] = [];
  let idx = 0;
  while (idx < physical.length) {
    const first = physical[idx]!;
    // 空行与整行注释独立成行，不参与续接
    const trimmed = first.rawText.trim();
    if (trimmed === "" || trimmed.startsWith("*")) {
      const loc: SourceLoc = {
        fileId, line: first.line, colStart: 0,
        colEnd: first.rawText.length, includeChain: [...includeChain]
      };
      const isComment = trimmed.startsWith("*");
      logicals.push({
        id: stableId("ll", [fileId, first.line, first.line]),
        physical: [first],
        loc,
        continued: false,
        tokens: isComment ? [] : [],
        comment: isComment ? first.rawText : null,
        kind: isComment ? "comment" : "blank"
      });
      idx++;
      continue;
    }
    const group = [first];
    let k = idx + 1;
    while (k < physical.length && physical[k]!.rawText.trimStart().startsWith("+")) {
      group.push(physical[k]!);
      k++;
    }
    // 拼接用于分词：续行的 '+' 替换为空格（仅派生用；physical 保留原文）。
    const joined = group
      .map((p, gi) => (gi === 0 ? p.rawText : p.rawText.trimStart().slice(1)))
      .join(" ");
    const { tokens, comment } = tokenizeLogicalLine(joined);
    const kind = classify(tokens[0], first.rawText);
    const loc: SourceLoc = {
      fileId, line: first.line, colStart: 0,
      colEnd: first.rawText.length, includeChain: [...includeChain]
    };
    logicals.push({
      id: stableId("ll", [fileId, first.line, group[group.length - 1]!.line]),
      physical: group,
      loc,
      continued: group.length > 1,
      tokens,
      comment,
      kind,
      controlName: kind === "control" ? tokens[0]!.toLowerCase() : undefined
    });
    idx = k;
  }
  return logicals;
}
