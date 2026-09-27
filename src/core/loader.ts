import { splitLogicalLines } from './lexer';
import { tokenize } from './lexer';
import { parseUnit } from './parser';
import { sha256Text, stableId } from './ids';
import type { Diagnostic, IncludeEdge, NetlistUnit, RawLine, Side, SourceFile } from './types';

/** include 解析器：从虚拟文件系统按路径取文本（仓库 fixture/内存均可） */
export interface Vfs {
  read(path: string, fromDir: string): { text: string; resolvedPath: string } | null;
  dirOf(path: string): string;
}

export interface RootInput {
  path: string;
  text: string;
}

export interface LoadResult {
  unit: NetlistUnit;
}

/**
 * 加载并解析一侧网表。
 * 循环 include：记录 cycle 边与诊断，环上文件只加载一次（避免无限展开），
 * 但关系保留、不删除、不静默忽略。
 */
export function loadUnit(side: Side, root: RootInput, vfs: Vfs): LoadResult {
  const sources: SourceFile[] = [];
  const lines: RawLine[] = [];
  const includes: IncludeEdge[] = [];
  const diagnostics: Diagnostic[] = [];

  const rootSource: SourceFile = {
    id: stableId('src', side, root.path),
    kind: 'netlist',
    path: root.path,
    rawText: root.text,
    includedBy: null,
    sha256: sha256Text(root.text),
  };
  sources.push(rootSource);

  interface Frame { sourceId: string; dir: string; chain: string[] }
  const queue: Frame[] = [{ sourceId: rootSource.id, dir: vfs.dirOf(root.path), chain: [rootSource.path] }];
  const enqueued = new Set<string>([rootSource.path]);

  while (queue.length > 0) {
    const frame = queue.shift()!;
    const source = sources.find((s) => s.id === frame.sourceId)!;
    const rawLines = splitLogicalLines(source);
    lines.push(...rawLines);

    for (const line of rawLines) {
      const up = line.joined.trim().toUpperCase();
      if (!(up.startsWith('.INC') || up.startsWith('.LIB'))) continue;
      const { tokens } = tokenize(line.joined);
      // .INC[LUDE] path  或 .LIB path
      const pathTok = tokens[1];
      if (!pathTok) {
        diagnostics.push({
          id: stableId('diag', 'INCLUDE_NO_PATH', line.id),
          severity: 'error',
          code: 'INCLUDE_NO_PATH',
          message: '.INCLUDE/.LIB 缺少路径',
          sourceId: source.id,
          lineId: line.id,
          subjectId: null,
        });
        continue;
      }
      const rawPath = pathTok.text.replace(/^["']|["']$/g, '');
      const read = vfs.read(rawPath, frame.dir);
      if (!read) {
        includes.push({
          id: stableId('inc', source.id, line.id, rawPath),
          fromSource: source.id,
          fromLine: line.id,
          toSource: stableId('src', side, rawPath),
          rawPath,
          cycle: false,
          cyclePath: null,
          diagnostic: `include-not-found: ${rawPath}`,
        });
        diagnostics.push({
          id: stableId('diag', 'INCLUDE_NOT_FOUND', line.id, rawPath),
          severity: 'error',
          code: 'INCLUDE_NOT_FOUND',
          message: `无法解析 include: ${rawPath}`,
          sourceId: source.id,
          lineId: line.id,
          subjectId: null,
        });
        continue;
      }

      const cycle = frame.chain.includes(read.resolvedPath);
      const toSourceId = stableId('src', side, read.resolvedPath);
      includes.push({
        id: stableId('inc', source.id, line.id, read.resolvedPath),
        fromSource: source.id,
        fromLine: line.id,
        toSource: toSourceId,
        rawPath,
        cycle,
        cyclePath: cycle ? frame.chain.concat(read.resolvedPath) : null,
        diagnostic: cycle ? `cyclic-include: ${frame.chain.concat(read.resolvedPath).join(' -> ')}` : null,
      });

      if (cycle) {
        diagnostics.push({
          id: stableId('diag', 'CYCLIC_INCLUDE', line.id, read.resolvedPath),
          severity: 'error',
          code: 'CYCLIC_INCLUDE',
          message: `循环 include：${frame.chain.concat(read.resolvedPath).join(' -> ')}（环被保留，文件不重复展开）`,
          sourceId: source.id,
          lineId: line.id,
          subjectId: toSourceId,
        });
        continue;
      }

      if (!enqueued.has(read.resolvedPath)) {
        enqueued.add(read.resolvedPath);
        const incSource: SourceFile = {
          id: toSourceId,
          kind: 'include',
          path: read.resolvedPath,
          rawText: read.text,
          includedBy: { sourceId: source.id, lineId: line.id },
          sha256: sha256Text(read.text),
        };
        sources.push(incSource);
        queue.push({ sourceId: incSource.id, dir: vfs.dirOf(read.resolvedPath), chain: frame.chain.concat(read.resolvedPath) });
      }
    }
  }

  const parsed = parseUnit({ side, sources, lines });
  return {
    unit: {
      ...parsed,
      includes,
      diagnostics: parsed.diagnostics.concat(diagnostics.filter((d) => !parsed.diagnostics.some((x) => x.id === d.id))),
    },
  };
}

/** 简易内存 VFS（fixture/测试用），路径按 basename 相对解析 */
export function memoryVfs(files: Record<string, string>): Vfs {
  const normalize = (p: string) => p.replace(/^\.\//, '').replace(/^\//, '');
  const norm: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) norm[normalize(k)] = v;
  return {
    dirOf: (path) => {
      const n = normalize(path);
      const idx = n.lastIndexOf('/');
      return idx >= 0 ? n.slice(0, idx) : '';
    },
    read(path, fromDir) {
      const candidates = [normalize(path), fromDir ? normalize(`${fromDir}/${path}`) : null].filter(Boolean) as string[];
      for (const c of candidates) {
        if (Object.prototype.hasOwnProperty.call(norm, c)) return { text: norm[c], resolvedPath: c };
      }
      // basename 回退
      const base = path.split('/').pop()!;
      for (const [k, v] of Object.entries(norm)) {
        if (k.endsWith('/' + base) || k === base) return { text: v, resolvedPath: k };
      }
      return null;
    },
  };
}
