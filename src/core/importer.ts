import { parseFile } from "./parser.js";
import type { RawNetlist } from "./rawNetlist.js";
import { stableId, sha256, canonicalName } from "./ids.js";
import type { RawFile, Diagnostic, SourceLoc, IncludeRef } from "./types.js";

export interface FileProvider {
  /** 按（来源文件目录 + 原始路径）读取，返回新登记的 RawFile；缺失返回 null。 */
  resolve(rawPath: string, fromFileId: string | null, mode: "include" | "lib", section: string | null): RawFile | null;
}

export interface ImportedBundle {
  files: RawFile[];
  netlist: RawNetlist;
  diagnostics: Diagnostic[];
  /** include 边：from fileId -> to fileId（循环时 to 为起点）。 */
  includeEdges: { from: string; to: string; refId: string; cyclic: boolean }[];
}

/** 从根文件出发，递归解析 include，检测循环。 */
export function importBundle(root: RawFile, provider: FileProvider): ImportedBundle {
  const files = new Map<string, RawFile>();
  const merged: RawNetlist = {
    logicalLines: [], elements: [], subckts: [], models: [], includes: [],
    paramAssignments: [], globalNodes: [], diagnostics: []
  };
  const diagnostics: Diagnostic[] = [];
  const edges: ImportedBundle["includeEdges"] = [];
  const seenSub = new Map<string, number>();
  const seenModel = new Map<string, number>();

  // DFS 栈记录 include 链路（按 fileId），用于循环检测与 chain 标注
  function walk(file: RawFile, chain: string[]) {
    if (files.has(file.id)) return;
    files.set(file.id, file);
    const { netlist, pendingIncludes } = parseFile(file);

    // 子电路重名：同 bundle 内同名多个定义
    for (const sub of netlist.subckts) {
      const key = canonicalName(sub.nameRaw);
      const count = seenSub.get(key) ?? 0;
      seenSub.set(key, count + 1);
      if (count > 0) {
        diagnostics.push({
          id: stableId("dg", ["dup-sub", sub.id, count]),
          code: "duplicate-subckt-name",
          level: "warning",
          message: `subckt '${sub.nameRaw}' redefined (version #${count}) from ${file.path}:${sub.loc.line}; candidate retained, binding requires decision`,
          loc: sub.loc,
          subjectId: sub.id
        });
      }
      merged.subckts.push(sub);
    }
    for (const model of netlist.models) {
      const key = canonicalName(model.nameRaw);
      const count = seenModel.get(key) ?? 0;
      seenModel.set(key, count + 1);
      if (count > 0) {
        diagnostics.push({
          id: stableId("dg", ["dup-mdl", model.id, count]),
          code: "duplicate-model-name",
          level: "warning",
          message: `model '${model.nameRaw}' redefined (version #${count}) from ${file.path}; version retained`,
          loc: model.loc,
          subjectId: model.id
        });
      }
      merged.models.push(model);
    }

    merged.logicalLines.push(...netlist.logicalLines);
    merged.elements.push(...netlist.elements);
    merged.includes.push(...netlist.includes);
    merged.paramAssignments.push(...netlist.paramAssignments);
    merged.globalNodes.push(...netlist.globalNodes);
    merged.diagnostics.push(...netlist.diagnostics);
    diagnostics.push(...netlist.diagnostics);

    for (const ref of pendingIncludes) {
      const child = provider.resolve(ref.pathRaw, file.id, ref.mode, ref.sectionRaw);
      if (!child) {
        const d: Diagnostic = {
          id: stableId("dg", ["missing-inc", ref.id]),
          code: "include-unresolved",
          level: "error",
          message: `cannot resolve .${ref.mode} '${ref.pathRaw}'`,
          loc: ref.loc,
          subjectId: ref.id
        };
        diagnostics.push(d);
        merged.diagnostics.push(d);
        ref.diagnostic = d.message;
        continue;
      }
      const cycle = chain.includes(child.id);
      if (cycle) {
        const d: Diagnostic = {
          id: stableId("dg", ["cycle-inc", ref.id, chain.join(">")]),
          code: "include-cycle",
          level: "error",
          message: `circular include detected: ${[...chain, child.id].join(" -> ")}`,
          loc: ref.loc,
          subjectId: ref.id
        };
        diagnostics.push(d);
        merged.diagnostics.push(d);
        ref.resolvedFileId = child.id;
        ref.diagnostic = d.message;
        edges.push({ from: file.id, to: child.id, refId: ref.id, cyclic: true });
        continue;
      }
      ref.resolvedFileId = child.id;
      edges.push({ from: file.id, to: child.id, refId: ref.id, cyclic: false });
      walk(child, [...chain, child.id]);
    }
  }

  walk(root, [root.id]);
  return { files: [...files.values()], netlist: merged, diagnostics, includeEdges: edges };
}

/** 读取 .lib 的指定 section（.LIB name 到 .ENDL name 之间）。整文件 include 则返回全部。 */
export function extractLibSection(content: string, sectionRaw: string): { text: string; startLine: number; found: boolean } {
  const lines = content.split("\n");
  const want = sectionRaw.toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim().toLowerCase();
    if (t.startsWith(".lib ") || t === ".lib") {
      const name = lines[i]!.trim().split(/\s+/)[1]?.toLowerCase();
      if (name === want) { start = i + 1; break; }
    }
  }
  if (start < 0) return { text: "", startLine: 0, found: false };
  const buf: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const t = lines[i]!.trim().toLowerCase();
    if (t.startsWith(".endl")) break;
    buf.push(lines[i]!);
  }
  return { text: buf.join("\n"), startLine: start + 1, found: true };
}

export function makeFile(path: string, content: string, side: RawFile["side"]): RawFile {
  return {
    id: stableId("file", [side, path, sha256(content).slice(0, 24)]),
    path,
    content,
    sha256: sha256(content),
    side
  };
}

export type { IncludeRef, SourceLoc };
