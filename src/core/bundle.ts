// 导入层：装载一组源文件，解析 include（含循环检测），形成 SourceBundle。
// 文件通过 VirtualFs 提供（测试仅用仓库内 fixture；运行时读 case-pack/用户上传）。
import { posixPath } from './ids.js';
import { makeSourceFile } from './source.js';
import { parseFile } from './parser.js';
import type {
  Diagnostic, RawStatement, SourceBundle, SourceFile
} from './types.js';

export interface VirtualFs {
  /** 读取相对路径原文；不存在返回 null。 */
  read(relPath: string): string | null;
  exists(relPath: string): boolean;
}

export function memoryFs(files: Record<string, string>): VirtualFs {
  const norm: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) norm[posixPath(k)] = v;
  return {
    read: (p) => norm[posixPath(p)] ?? null,
    exists: (p) => posixPath(p) in norm
  };
}

function resolveInclude(fromPath: string, target: string): string {
  const base = posixPath(fromPath).split('/').slice(0, -1).join('/');
  let t = posixPath(target);
  const variants = [
    t,
    base ? `${base}/${t}` : t,
    `models/${t}`, base ? `${base}/models/${t}` : `models/${t}`
  ];
  // 归一化 ./ 与 ../
  return variants.map(normalize).find((v) => v) ?? normalize(t);
}

function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

export function importBundle(
  id: string, rootPath: string, fs: VirtualFs
): SourceBundle {
  const diagnostics: Diagnostic[] = [];
  const files: SourceFile[] = [];
  const statements: RawStatement[] = [];
  const includeEdges: SourceBundle['includeEdges'] = [];
  const visited = new Set<string>();
  const stack: string[] = [];
  let cycle: string[] | null = null;

  const load = (relPathRaw: string) => {
    const relPath = normalize(relPathRaw);
    if (cycle) return;
    if (stack.includes(relPath)) {
      cycle = [...stack.slice(stack.indexOf(relPath)), relPath];
      diagnostics.push({
        level: 'error', code: 'include-cycle',
        message: `检测到循环 include：${cycle.join(' -> ')}；环上重复文件不再二次展开`,
        sourceFileId: undefined
      });
      return;
    }
    if (visited.has(relPath)) return;
    const raw = fs.read(relPath);
    if (raw === null) {
      diagnostics.push({
        level: 'error', code: 'include-missing',
        message: `include 目标不存在：${relPath}（保留原始 include 语句）`
      });
      return;
    }
    visited.add(relPath);
    stack.push(relPath);
    const sf = makeSourceFile(id, relPath, raw);
    files.push(sf);
    const { statements: stmts } = parseFile(sf);
    for (const st of stmts) {
      statements.push(st);
      if (st.type === 'include') {
        const resolved = resolveInclude(relPath, st.inc.targetPath);
        const exists = fs.exists(resolved);
        st.inc.resolvedPath = exists ? resolved : null;
        includeEdges.push({ from: sf.id, to: fileIdOf(id, resolved), incId: st.inc.id });
        if (exists) load(resolved);
        else diagnostics.push({
          level: 'error', code: 'include-missing',
          message: `无法解析 include：${st.inc.targetPath}（来自 ${relPath}）`,
          sourceFileId: sf.id, physicalLine: st.inc.lineId ? undefined : undefined
        });
      }
    }
    stack.pop();
  };

  load(rootPath);
  // 保持文件按“首次加载顺序”，语句按加载顺序（已是 append 顺序）
  return { id, rootPath: normalize(rootPath), files, statements, includeEdges, diagnostics, includeCycle: cycle };
}

function fileIdOf(bundle: string, rel: string) {
  return `src:${bundle}:${normalize(rel)}`;
}

/** 重名子电路/模型诊断，以及加载顺序报告（不改写定义）。 */
export function registryDiagnostics(bundle: SourceBundle): Diagnostic[] {
  const diags: Diagnostic[] = [...bundle.diagnostics];
  const subs = new Map<string, number>();
  const models = new Map<string, number>();
  for (const st of bundle.statements) {
    if (st.type === 'subckt') {
      const k = st.sub.name.toUpperCase();
      subs.set(k, (subs.get(k) ?? 0) + 1);
    } else if (st.type === 'model') {
      const k = `${st.model.name.toUpperCase()}|${st.model.modelType.toUpperCase()}`;
      models.set(k, (models.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of subs) if (n > 1) diags.push({
    level: 'warning', code: 'subckt-shadow',
    message: `子电路 ${k} 有 ${n} 个同名定义（重名）；展平采用 include 顺序中最后定义，其余作为候选保留`
  });
  for (const [k, n] of models) if (n > 1) diags.push({
    level: 'warning', code: 'model-version',
    message: `model ${k} 有 ${n} 个版本定义；默认采用最后加载版本，其余版本保留可切换`
  });
  return diags;
}
