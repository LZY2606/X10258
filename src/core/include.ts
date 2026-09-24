// include/.lib 解析：虚拟文件集（仓库 fixture，不依赖真实磁盘扫描），
// 保留来源链与定义顺序；循环 include 被记录并在首次重复处停止展开。
import type { FileSource, IncludeEdge, IncludeResolution, ParsedFile } from '../shared/types.js';

function normalizePath(p: string): string {
  return p.replace(/^\.?\//, '').replace(/\\/g, '/');
}

export function resolveIncludes(
  rootFiles: ParsedFile[],
  fileByPath: Map<string, ParsedFile>,
): IncludeResolution {
  const edges: IncludeEdge[] = [];
  const order: string[] = [];
  const cycles: string[][] = [];
  const missing: IncludeResolution['missing'] = [];

  const lookup = (path: string): ParsedFile | undefined => {
    const norm = normalizePath(path);
    return fileByPath.get(path) ?? fileByPath.get(norm) ??
      [...fileByPath.values()].find((f) => normalizePath(f.source.path) === norm);
  };

  const walk = (file: ParsedFile, stack: string[]) => {
    const fid = file.source.fileId;
    if (stack.includes(fid)) {
      cycles.push([...stack, fid]);
      return;
    }
    if (!order.includes(fid)) order.push(fid);
    const nextStack = [...stack, fid];
    for (const ctl of file.controls) {
      if (ctl.kind !== 'include') continue;
      const path = ctl.tokens[0]!;
      const kind = (ctl.tokens[1] ?? 'include') as 'include' | 'library';
      const target = lookup(path);
      const edge: IncludeEdge = {
        fromFileId: fid,
        toPath: path,
        toFileId: target?.source.fileId,
        atLine: ctl.span.line,
        kind,
        resolved: Boolean(target),
      };
      edges.push(edge);
      if (!target) {
        missing.push({ path, fromFileId: fid, atLine: ctl.span.line });
        continue;
      }
      walk(target, nextStack);
    }
  };

  for (const root of rootFiles) walk(root, []);
  return { roots: rootFiles.map((f) => f.source.fileId), order, edges, cycles, missing };
}

export function makeFileSource(path: string, rawText: string, kind: FileSource['includeKind'], fileId: string, includedBy?: string): FileSource {
  return { path, fileId, rawText, includeKind: kind, includedBy };
}
