import {
  Diagnostic,
  FlatNetlist,
  IncludeEdge,
  SourceFile
} from "../shared/types.ts";
import { buildStatements } from "./lexer.ts";
import { ingestFile } from "./lexer.ts";
import { collectModels, collectSubckts, topLevelParams } from "./parser.ts";
import { flatten } from "./flatten.ts";

export interface VfsEntry {
  path: string;
  origin: SourceFile["origin"];
  content: string;
}

export interface ImportResult {
  netlist: FlatNetlist;
  edges: IncludeEdge[];
}

function stripQuotes(p: string): string {
  const t = p.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** 候选路径解析：原样路径 -> 去 ./ -> basename -> 目录拼接（全部记录到 searched）。 */
export function candidatePaths(rawPath: string, fromDir: string): string[] {
  const p = stripQuotes(rawPath);
  const cands = [
    p,
    p.replace(/^\.\//, ""),
    p.split("/").pop() ?? p,
    `${fromDir.replace(/\/$/, "")}/${p}`
  ];
  return [...new Set(cands)];
}

/** 递归导入：include 边、循环检测（保留诊断，不无限展开）。 */
export function importNetlist(
  side: "A" | "B",
  rootPath: string,
  vfs: VfsEntry[]
): ImportResult {
  const byPath = new Map<string, VfsEntry>();
  for (const e of vfs) byPath.set(e.path, e);

  const files = new Map<string, SourceFile>();
  const edges: IncludeEdge[] = [];
  const diagnostics: Diagnostic[] = [];

  const root = byPath.get(rootPath);
  if (!root) throw new Error(`VFS 中找不到根网表 ${rootPath}`);

  const visit = (
    path: string,
    origin: SourceFile["origin"],
    content: string,
    chain: string[]
  ): SourceFile => {
    const file = ingestFile(path, origin, content);
    if (files.has(file.id)) return file;
    files.set(file.id, file);

    const statements = buildStatements(file);
    for (const stmt of statements) {
      if (stmt.kind !== "include" && stmt.kind !== "lib") continue;
      const rawPath =
        stmt.tokens[1] && stmt.tokens[1].toUpperCase().startsWith("PARAMS:")
          ? stmt.tokens[1]
          : stmt.tokens[1] ?? "";
      const searched = candidatePaths(rawPath, path.split("/").slice(0, -1).join("/"));
      const foundPath = searched.find((c) => byPath.has(c));
      if (!foundPath) {
        edges.push({
          statementId: stmt.id,
          rawPath: stripQuotes(rawPath),
          resolvedFileId: null,
          searched,
          cycle: false,
          cyclePath: [],
          diagnostic: `include 目标未找到: ${stripQuotes(rawPath)}`
        });
        diagnostics.push({
          code: "include-missing",
          message: `${path}:${stmt.firstLineNo} 无法解析 include "${stripQuotes(rawPath)}"（候选 ${searched.join(", ")}）`,
          statementId: stmt.id,
          fileId: file.id
        });
        continue;
      }
      const entry = byPath.get(foundPath)!;
      const probe = ingestFile(foundPath, entry.origin, entry.content);
      const cycle = chain.includes(probe.id);
      if (cycle) {
        edges.push({
          statementId: stmt.id,
          rawPath: stripQuotes(rawPath),
          resolvedFileId: null,
          searched,
          cycle: true,
          cyclePath: [...chain, probe.id],
          diagnostic: `检测到循环 include: ${[...chain.map((c) => c), probe.id].join(" -> ")}`
        });
        diagnostics.push({
          code: "include-cycle",
          message: `${path}:${stmt.firstLineNo} 循环 include 已截断: ${stripQuotes(rawPath)}`,
          statementId: stmt.id,
          fileId: file.id
        });
        continue;
      }
      const child = visit(foundPath, entry.origin, entry.content, [...chain, file.id]);
      edges.push({
        statementId: stmt.id,
        rawPath: stripQuotes(rawPath),
        resolvedFileId: child.id,
        searched,
        cycle: false,
        cyclePath: [],
        diagnostic: null
      });
    }
    return file;
  };

  visit(rootPath, root.origin, root.content, []);

  const allFiles = [...files.values()];
  const allStatements = allFiles.flatMap((f) => buildStatements(f));
  const subckts = collectSubckts(allStatements);
  const models = collectModels(allStatements);
  const globals = topLevelParams(allStatements);

  const netlist = flatten({
    side,
    rootFileId: ingestFile(rootPath, root.origin, root.content).id,
    files: allFiles,
    statements: allStatements,
    subckts,
    models,
    topParams: globals,
    edges,
    diagnostics
  });

  return { netlist, edges };
}
