import {
  FileOrigin,
  RawLine,
  SourceFile,
  Statement,
  StatementKind
} from "../shared/types.ts";
import { cid } from "./util.ts";

/** 摄取源文件：逐物理行保留原文（不规范化大小写/后缀/空格）。 */
export function ingestFile(path: string, origin: FileOrigin, content: string): SourceFile {
  const id = cid("F", `${path}|${content}`);
  const rawLines = content.split("\n").map((text, idx) => ({
    id: `${id}#L${idx + 1}`,
    fileId: id,
    lineNo: idx + 1,
    text,
    continuationOf: null as string | null
  }));
  return { id, path, origin, content, lines: rawLines };
}

const INSTANCE_LETTERS = new Set([
  "R", "C", "L", "D", "Q", "M", "J", "V", "I", "E", "G", "H", "F", "S", "W", "T", "U", "K", "B", "O", "P", "N", "Z", "Y", "A", "X"
]);

function firstWord(line: string): string {
  return (line.trim().split(/\s+/)[0] ?? "").toUpperCase();
}

function classify(firstToken: string): StatementKind {
  if (firstToken === ".SUBCKT") return "subckt";
  if (firstToken === ".ENDS") return "ends";
  if (firstToken === ".MODEL") return "model";
  if (firstToken === ".INCLUDE" || firstToken === ".INC") return "include";
  if (firstToken === ".LIB") return "lib";
  if (firstToken === ".PARAM" || firstToken === ".PARAMETER") return "param";
  if (firstToken === ".GLOBAL") return "global";
  if (firstToken.startsWith(".")) return "control";
  if (firstToken.startsWith("*")) return "comment";
  const letter = firstToken.charAt(0).toUpperCase();
  if (INSTANCE_LETTERS.has(letter)) return "instance";
  if (firstToken.length === 0) return "comment";
  return "unknown";
}

/** token 化一条逻辑行：保留原始拼写；剥离行内 `$` 注释（原文另存）。
 *  大括号表达式 `{...}` 作为单个 token 保留。*/
function tokenizeLogical(joined: string): { tokens: string[]; inlineComment: string | null } {
  let inlineComment: string | null = null;
  let body = joined;
  // $ 注释：不出现在单引号内（SPICE 罕见，保守处理）
  const dollar = joined.search(/\$/);
  if (dollar >= 0) {
    inlineComment = joined.slice(dollar);
    body = joined.slice(0, dollar);
  }
  const tokens: string[] = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;
    if (body[i] === "{" ) {
      const end = body.indexOf("}", i);
      const stop = end < 0 ? body.length : end + 1;
      tokens.push(body.slice(i, stop));
      i = stop;
      continue;
    }
    if (body[i] === '"' || body[i] === "'") {
      const q = body[i];
      let j = i + 1;
      while (j < body.length && body[j] !== q) j++;
      tokens.push(body.slice(i, Math.min(j + 1, body.length)));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < body.length && !/\s/.test(body[j])) j++;
    tokens.push(body.slice(i, j));
    i = j;
  }
  return { tokens, inlineComment };
}

/** 将物理行按 `+` 续接合并为逻辑语句；原行序列完整保留。 */
export function buildStatements(file: SourceFile): Statement[] {
  const out: Statement[] = [];
  let current: {
    firstLineNo: number;
    lineIds: string[];
    rawLines: string[];
    joined: string;
  } | null = null;

  const flush = () => {
    if (!current) return;
    const firstText = current.rawLines[0];
    const ft = firstWord(firstText);
    const kind = ft.startsWith("*") || ft.length === 0 ? "comment" : classify(ft);
    const { tokens, inlineComment } = tokenizeLogical(current.joined);
    out.push({
      id: `${file.id}#S${current.firstLineNo}`,
      kind,
      fileId: file.id,
      firstLineNo: current.firstLineNo,
      lineIds: current.lineIds,
      rawLines: current.rawLines,
      tokens,
      inlineComment
    });
    current = null;
  };

  for (const line of file.lines) {
    const isContinuation = /^\s*\+/.test(line.text);
    if (isContinuation && current) {
      line.continuationOf = `${file.id}#L${current.firstLineNo}`;
      current.lineIds.push(line.id);
      current.rawLines.push(line.text);
      current.joined += " " + line.text.replace(/^\s*\+/, "").trim();
      continue;
    }
    flush();
    current = {
      firstLineNo: line.lineNo,
      lineIds: [line.id],
      rawLines: [line.text],
      joined: line.text.trim()
    };
  }
  flush();
  return out;
}
