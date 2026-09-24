import type { Diagnostic, LoadedUnit, SourceFile, SubcktDef, ModelDef, LogicalLine, InstanceLine } from '../shared/types';
import { parseFile } from './parser';
import { fileIdFor } from './lexer';
import { stableId } from './ident';

export interface VirtualFS {
  read(path: string): string | undefined;
  resolve(fromPath: string, target: string): string;
}

export function posixResolve(fromPath: string, target: string): string {
  if (target.startsWith('/')) return target;
  const base = fromPath.split('/').slice(0, -1);
  const parts = target.split('/');
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') base.pop();
    else base.push(p);
  }
  return base.join('/');
}

export const memoryFS = (files: Record<string, string>): VirtualFS => ({
  read: (p) => files[p],
  resolve: posixResolve,
});

export interface ModuleSet {
  rootPath: string;
  units: LoadedUnit[];
  /** 同名子电路全部保留（重名），键为大写名 */
  subckts: Map<string, SubcktVersion[]>;
  models: Map<string, ModelVersion[]>;
  topLines: LogicalLine[];
  diagnostics: Diagnostic[];
}

export interface SubcktVersion {
  def: SubcktDef;
  unitFileId: string;
  path: string;
  /** include 深度（0 = 根），用于报告来源 */
  depth: number;
  /** 同重名组内的序号（按加载顺序），不作为唯一身份（身份来自内容） */
  ordinal: number;
}

export interface ModelVersion {
  model: ModelDef;
  unitFileId: string;
  path: string;
  ordinal: number;
}

/** 加载根文件，递归 include，检测循环。include 来源原样保留。 */
export function loadModuleSet(rootPath: string, fs: VirtualFS): ModuleSet {
  const units: LoadedUnit[] = [];
  const subckts = new Map<string, SubcktVersion[]>();
  const models = new Map<string, ModelVersion[]>();
  const diagnostics: Diagnostic[] = [];
  const seenFile = new Set<string>();

  const addUnit = (path: string, chain: string[]): LoadedUnit | undefined => {
    const text = fs.read(path);
    if (text === undefined) {
      diagnostics.push({ code: 'INCLUDE_MISSING', message: `include target not found: ${path}`, severity: 'error' });
      return undefined;
    }
    const file: SourceFile = { fileId: fileIdFor(path), path, rawText: text };
    const parsed = parseFile(file);
    diagnostics.push(...parsed.diagnostics.map((d) => ({ ...d, origin: d.origin ? { ...d.origin, includeChain: chain } : d.origin })));
    const unit: LoadedUnit = { fileId: file.fileId, path, includeChain: chain, parsed };
    units.push(unit);
    return unit;
  };

  interface Frame { path: string; chain: string[]; depth: number }
  const walk = (frame: Frame, active: Set<string>): void => {
    if (active.has(frame.path)) {
      diagnostics.push({ code: 'INCLUDE_CYCLE', message: `circular include detected at ${frame.path}: ${[...active, frame.path].join(' -> ')}`, severity: 'error' });
      return;
    }
    if (seenFile.has(frame.path)) {
      diagnostics.push({ code: 'INCLUDE_REPEAT', message: `already included: ${frame.path} (second occurrence retained as source, not re-expanded)`, severity: 'info' });
      return;
    }
    seenFile.add(frame.path);
    const next = new Set(active); next.add(frame.path);
    const unit = addUnit(frame.path, frame.chain);
    if (!unit) return;

    // 收集该单元内的 subckt/model（顶层 + 嵌套定义的 body 不含 subckt，但 def.body 含实例）
    for (const d of unit.parsed.directives) {
      if (d.kind === 'subckt') {
        const arr = subckts.get(d.name) ?? [];
        arr.push({ def: d, unitFileId: unit.fileId, path: unit.path, depth: frame.depth, ordinal: arr.length });
        subckts.set(d.name, arr);
      } else if (d.kind === 'model') {
        const arr = models.get(d.name) ?? [];
        arr.push({ model: d, unitFileId: unit.fileId, path: unit.path, ordinal: arr.length });
        models.set(d.name, arr);
      }
    }

    // 递归 include（深度优先，保持来源顺序）。section 由文本截取实现。
    for (const d of unit.parsed.directives) {
      if (d.kind === 'include' || d.kind === 'lib') {
        const targetPath = fs.resolve(frame.path, d.target);
        const child: Frame = { path: targetPath, chain: [...frame.chain, frame.path], depth: frame.depth + 1 };
        if (d.kind === 'lib' && d.section) {
          walkLibSection(child, next, d.section, fs, addUnit, diagnostics, units, subckts, models);
        } else {
          walk(child, next);
        }
      }
    }
  };

  walk({ path: rootPath, chain: [], depth: 0 }, new Set());

  // 顶层行：根单元（depth 0）指令中的实例/param（用于展平）
  const rootUnit = units.find((u) => u.includeChain.length === 0);
  const topLines = rootUnit ? rootUnit.parsed.directives.filter((d) => d.kind !== 'include' && d.kind !== 'lib') : [];

  // 重名诊断：同名 subckt 多版本
  for (const [name, arr] of subckts) {
    if (arr.length > 1) {
      diagnostics.push({
        code: 'SUBCKT_SHADOW',
        message: `subckt ${name} has ${arr.length} definitions across include sources; all versions retained`,
        severity: 'warning',
      });
    }
  }

  return { rootPath, units, subckts, models, topLines, diagnostics };
}

function walkLibSection(
  frame: Frame,
  active: Set<string>,
  section: string,
  fs: VirtualFS,
  addUnit: (path: string, chain: string[]) => LoadedUnit | undefined,
  diagnostics: Diagnostic[],
  units: LoadedUnit[],
  subckts: Map<string, SubcktVersion[]>,
  models: Map<string, ModelVersion[]>,
): void {
  if (active.has(frame.path)) {
    diagnostics.push({ code: 'INCLUDE_CYCLE', message: `circular .lib at ${frame.path}`, severity: 'error' });
    return;
  }
  const text = fs.read(frame.path);
  if (text === undefined) {
    diagnostics.push({ code: 'LIB_MISSING', message: `.lib target not found: ${frame.path}`, severity: 'error' });
    return;
  }
  // section 文本截取：.LIB name / .ENDS name（原样保留片段）
  const lines = text.split(/\r\n|\r|\n/);
  const startIdx = lines.findIndex((l) => /^\s*\.lib\s+/i.test(l) && l.toUpperCase().includes(section.toUpperCase()));
  if (startIdx < 0) {
    diagnostics.push({ code: 'LIB_SECTION_MISSING', message: `.lib section ${section} not found in ${frame.path}`, severity: 'error' });
    return;
  }
  const slice: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    slice.push(lines[i]);
    if (i > startIdx && /^\s*\.ends\b/i.test(lines[i])) break;
  }
  const virtualPath = `${frame.path}#${section}`;
  const file: SourceFile = { fileId: fileIdFor(virtualPath), path: virtualPath, rawText: slice.join('\n') };
  const parsed = parseFile(file);
  units.push({ fileId: file.fileId, path: virtualPath, includeChain: frame.chain, parsed });
  for (const d of parsed.directives) {
    if (d.kind === 'subckt') {
      const arr = subckts.get(d.name) ?? [];
      arr.push({ def: d, unitFileId: file.fileId, path: virtualPath, depth: frame.depth, ordinal: arr.length });
      subckts.set(d.name, arr);
    } else if (d.kind === 'model') {
      const arr = models.get(d.name) ?? [];
      arr.push({ model: d, unitFileId: file.fileId, path: virtualPath, ordinal: arr.length });
      models.set(d.name, arr);
    }
  }
}

/** 顶层实例（用于展平入口） */
export function topInstances(mod: ModuleSet): InstanceLine[] {
  return mod.topLines.filter((d): d is InstanceLine => d.kind === 'instance');
}

export { stableId };
