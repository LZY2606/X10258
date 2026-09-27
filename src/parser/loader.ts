/**
 * include 解析与定义注册表。
 *
 * - include 路径、引号、.lib section 等原文不改写；
 * - 循环 include 被检测为事件，循环边不二次进入（不死循环），但保留来源链；
 * - 子电路重名：全部候选都保留（adopted + alternatives），不静默覆盖；
 * - model 版本：同名多版全部保留，记录选择与冲突。
 */
import type {
  Diagnostic, Origin, ParsedInclude, ParsedModel, ParsedNetItem, ParsedNetlist,
  ParsedSubckt, SourceFile, Spine,
} from '../shared/types.js';
import { makeFile } from './lexer.js';
import { parseSpine } from './parser.js';
import { stableId } from '../shared/ids.js';

export interface FileProvider {
  /** 返回逐字文本；不存在时返回 null。 */  read(path: string): string | null;
  /** 列出可解析候选（用于诊断/展示），可选。 */
  exists(path: string): boolean;
}

export class MapFileProvider implements FileProvider {
  constructor(private map: Record<string, string>) {}
  read(path: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.map, path) ? this.map[path] : null;
  }
  exists(path: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.map, path);
  }
}

function normPath(baseDir: string, rel: string): string {
  const cleanRel = rel.replace(/\\/g, '/');
  if (cleanRel.startsWith('/')) return cleanRel.replace(/^\/+/, '');
  const parts = (baseDir ? baseDir.split('/') : []).concat(cleanRel.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') { if (out.length) out.pop(); continue; }
    out.push(p);
  }
  return out.join('/');
}

export interface ResolutionEvent {
  type: 'include-resolved' | 'include-missing' | 'include-cycle';
  spine: Spine;
  fromFileId: string;
  directiveOrigin: Origin;
  pathRaw: string;
  resolvedPath?: string;
  toFileId?: string;
  cyclePath?: string[];
}

export function loadNetlist(
  spine: Spine,
  rootPath: string,
  provider: FileProvider,
): { netlist: ParsedNetlist; events: ResolutionEvent[]; diagnostics: Diagnostic[] } {
  const files: Record<string, SourceFile> = {};
  const events: ResolutionEvent[] = [];
  const diagnostics: Diagnostic[] = [];
  const pathToId: Record<string, string> = {};

  const getId = (path: string): string => {
    if (!pathToId[path]) pathToId[path] = stableId('F', [path]);
    return pathToId[path];
  };

  const inclusionOrder: string[] = [];
  const edges: ParsedNetlist['includeGraph']['edges'] = [];

  // DFS（保留包含顺序与调用栈做循环检测）。
  const visit = (path: string, stack: string[]): string | null => {
    const id = getId(path);
    if (files[id]) return id;
    const text = provider.read(path);
    if (text === null) return null;
    // 身份是路径坐标，解析前固定，保证来源坐标在重算/导入后稳定。
    const file = makeFile(path, text, id);
    parseSpine(file);
    files[id] = file;
    inclusionOrder.push(id);

    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const includes = files[id].items.filter((x): x is ParsedInclude => x.kind === 'include');
    let includeIndex = 0;
    for (const inc of includes) {
      const idx = includeIndex++;
      let resolved: string | null = null;
      let cycle = false;
      let cyclePath: string[] = [];

      if (inc.pathRaw === '') {
        diagnostics.push({
          code: 'INCLUDE_NO_PATH', severity: 'error',
          message: `${inc.directive} 缺少路径`, origin: inc.origin,
        });
      } else {
        const target = normPath(dir, inc.pathRaw);
        if (stack.includes(target)) {
          cycle = true;
          cyclePath = [...stack.slice(stack.indexOf(target)), target];
          events.push({
            type: 'include-cycle', spine, fromFileId: id,
            directiveOrigin: inc.origin, pathRaw: inc.pathRaw,
            resolvedPath: target, cyclePath,
          });
          diagnostics.push({
            code: 'INCLUDE_CYCLE', severity: 'warning',
            message: `循环 include 已截断: ${cyclePath.join(' -> ')}`,
            origin: inc.origin, offendingRaw: inc.pathRaw,
          });
        } else if (!provider.exists(target)) {
          events.push({
            type: 'include-missing', spine, fromFileId: id,
            directiveOrigin: inc.origin, pathRaw: inc.pathRaw, resolvedPath: target,
          });
          diagnostics.push({
            code: 'INCLUDE_MISSING', severity: 'error',
            message: `include 目标不存在（原文保留，不删除该指令）: ${inc.pathRaw}`,
            origin: inc.origin, offendingRaw: inc.pathRaw,
          });
        } else {
          resolved = visit(target, [...stack, target]);
          events.push({
            type: 'include-resolved', spine, fromFileId: id,
            directiveOrigin: inc.origin, pathRaw: inc.pathRaw,
            resolvedPath: target, toFileId: resolved ?? undefined,
          });
        }
      }
      inc.resolvedFileId = resolved;
      edges.push({ fromFileId: id, includeIndex: idx, toFileId: resolved, cycle, cyclePath });
    }
    return id;
  };

  const rootFileId = visit(rootPath, [rootPath]);
  if (rootFileId === null) {
    throw new Error(`根网表不存在: ${rootPath}`);
  }
  for (const f of Object.values(files)) diagnostics.push(...f.diagnostics);

  return {
    netlist: { spine, rootFileId, files, includeGraph: { edges, inclusionOrder }, diagnostics: dedupeDiag(diagnostics) },
    events,
    diagnostics,
  };
}


function dedupeDiag(ds: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of ds) {
    const key = `${d.code}|${d.origin?.fileId}|${d.origin?.logicalNo}|${d.offendingRaw ?? ''}|${d.message}`;
    if (!seen.has(key)) { seen.add(key); out.push(d); }
  }
  return out;
}

// ---------------- 定义注册表 ----------------

export interface SubcktDefCandidate {
  definition: ParsedSubckt;
  fileId: string;
  rank: number; // 出现顺序（越小越早）
}

export interface ModelVersionCandidate {
  model: ParsedModel;
  fileId: string;
  rank: number;
}

export interface DefinitionRegistry {
  subckts: Record<string, {
    nameKey: string;
    adopted: SubcktDefCandidate;
    alternatives: SubcktDefCandidate[];
  }>;
  models: Record<string, {
    nameKey: string;
    adopted: ModelVersionCandidate;
    versions: ModelVersionCandidate[];
  }>;
  events: RegistryEvent[];
}

export type RegistryEvent =
  | { type: 'subckt-redefined'; spine: Spine; nameKey: string; kept: Origin; dropped: Origin; rankNew: number }
  | { type: 'model-redefined'; spine: Spine; nameKey: string; kept: Origin; versions: Origin[] };

export function buildRegistry(spine: Spine, netlist: ParsedNetlist): DefinitionRegistry {
  const subDefs: Record<string, SubcktDefCandidate[]> = {};
  const modelDefs: Record<string, ModelVersionCandidate[]> = {};
  const events: RegistryEvent[] = [];

  let rank = 0;
  for (const fid of netlist.includeGraph.inclusionOrder) {
    const file = netlist.files[fid];
    for (const item of file.items) {
      if (item.kind === 'subckt') {
        (subDefs[item.nameKey] ??= []).push({ definition: item, fileId: fid, rank: rank++ });
      } else if (item.kind === 'model') {
        (modelDefs[item.nameKey] ??= []).push({ model: item, fileId: fid, rank: rank++ });
      }
    }
  }

  const subckts: DefinitionRegistry['subckts'] = {};
  for (const [nameKey, cands] of Object.entries(subDefs)) {
    const sorted = [...cands].sort((a, b) => a.rank - b.rank);
    // 默认采纳“最早包含”的定义；其余全部保留为候选（重名不覆盖丢失）。
    const adopted = sorted[0];
    if (sorted.length > 1) {
      for (const alt of sorted.slice(1)) {
        events.push({
          type: 'subckt-redefined', spine, nameKey,
          kept: adopted.definition.origin, dropped: alt.definition.origin, rankNew: alt.rank,
        });
      }
    }
    subckts[nameKey] = { nameKey, adopted, alternatives: sorted.slice(1) };
  }

  const models: DefinitionRegistry['models'] = {};
  for (const [nameKey, vers] of Object.entries(modelDefs)) {
    const sorted = [...vers].sort((a, b) => a.rank - b.rank);
    const adopted = sorted[0];
    if (sorted.length > 1) {
      events.push({
        type: 'model-redefined', spine, nameKey,
        kept: adopted.model.origin, versions: sorted.map((v) => v.model.origin),
      });
    }
    models[nameKey] = { nameKey, adopted, versions: sorted };
  }

  return { subckts, models, events };
}
