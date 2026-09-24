// 网表装配：include 解析（含循环检测）、子电路注册（重名保留全部候选）、model 版本来源。
import { parseFile, type Diagnostic, type SourceFile, type Statement } from './parser.js';

export interface SubcktDef {
  id: string; // subckt:名称@来源语句
  name: string;
  nodes: string[];
  defaults: Record<string, string>;
  body: Statement[];
  stmtId: string;
  fileId: string;
  line: number;
  includeChain: string[]; // include 来源链
}

export interface ModelDef {
  id: string;
  name: string;
  type: string;
  params: Record<string, string>; // 原始表达式，不改写
  stmtId: string;
  fileId: string;
  line: number;
  includeChain: string[];
}

export interface AssembledNetlist {
  side: string;
  files: SourceFile[];
  statements: { stmt: Statement; includeChain: string[] }[];
  subckts: Map<string, SubcktDef[]>; // 重名 → 多候选
  models: Map<string, ModelDef>;
  globals: Record<string, string>; // .param 原文
  diagnostics: Diagnostic[];
  includeCycles: string[][];
}

export interface AssembleInput {
  side: string;
  topPath: string;
  files: SourceFile[]; // 全部可用文件
}

export function assembleNetlist(input: AssembleInput): AssembledNetlist {
  const byPath = new Map(input.files.map((f) => [f.path, f]));
  const diagnostics: Diagnostic[] = [];
  const includeCycles: string[][] = [];
  const ordered: { file: SourceFile; includeChain: string[] }[] = [];
  const visited = new Set<string>();

  const visit = (path: string, chain: string[]) => {
    const file = byPath.get(path);
    if (!file) {
      diagnostics.push({ id: `diag:missing:${path}`, severity: 'error', message: `include 来源缺失：${path}`, raw: path });
      return;
    }
    if (chain.includes(path)) {
      const cycle = [...chain.slice(chain.indexOf(path)), path];
      includeCycles.push(cycle);
      diagnostics.push({ id: `diag:cycle:${cycle.join('>')}`, severity: 'warning', message: `循环 include：${cycle.join(' → ')}，停止递归展开，已保留原文`, fileId: file.id });
      return;
    }
    if (visited.has(path)) return;
    visited.add(path);
    const myChain = [...chain, path];
    ordered.push({ file, includeChain: myChain });
    const { statements, diagnostics: pdiags } = parseFile(file);
    diagnostics.push(...pdiags);
    for (const s of statements) {
      if ((s.kind === 'include' || s.kind === 'lib') && s.includePath) {
        visit(s.includePath, myChain);
      }
    }
  };
  visit(input.topPath, []);

  const statements: AssembledNetlist['statements'] = [];
  const subckts = new Map<string, SubcktDef[]>();
  const models = new Map<string, ModelDef>();
  const globals: Record<string, string> = {};

  for (const { file, includeChain } of ordered) {
    const { statements: stmts } = parseFile(file);
    let cur: SubcktDef | null = null;
    for (const stmt of stmts) {
      statements.push({ stmt, includeChain });
      if (stmt.kind === 'subckt' && stmt.subcktName) {
        cur = {
          id: `subckt:${stmt.subcktName}@${stmt.id}`,
          name: stmt.subcktName,
          nodes: stmt.subcktNodes ?? [],
          defaults: stmt.subcktDefaults ?? {},
          body: [],
          stmtId: stmt.id,
          fileId: file.id,
          line: stmt.startLine,
          includeChain,
        };
        const list = subckts.get(stmt.subcktName) ?? [];
        list.push(cur);
        subckts.set(stmt.subcktName, list);
        if (list.length > 1) {
          diagnostics.push({
            id: `diag:subckt-collision:${stmt.subcktName}`,
            severity: 'warning',
            message: `子电路重名 "${stmt.subcktName}"：${list.map((d) => `${d.fileId}#L${d.line}`).join(' 与 ')}；全部候选保留，默认按 include 顺序取第一`,
            fileId: file.id,
            line: stmt.startLine,
            raw: stmt.raw,
          });
        }
      } else if (stmt.kind === 'ends') {
        cur = null;
      } else if (cur && (stmt.kind === 'element' || stmt.kind === 'unknown' || stmt.kind === 'param')) {
        cur.body.push(stmt);
      } else if (!cur && stmt.kind === 'model' && stmt.modelName) {
        const def: ModelDef = {
          id: `model:${stmt.modelName}@${stmt.id}`,
          name: stmt.modelName,
          type: stmt.modelType ?? '',
          params: stmt.modelParams ?? {},
          stmtId: stmt.id,
          fileId: file.id,
          line: stmt.startLine,
          includeChain,
        };
        if (models.has(def.name)) {
          diagnostics.push({
            id: `diag:model-version:${def.name}@${stmt.id}`,
            severity: 'info',
            message: `model "${def.name}" 存在多个版本：${models.get(def.name)!.stmtId} 与 ${stmt.id}；后者覆盖前者，两个版本均保留`,
            fileId: file.id,
            line: stmt.startLine,
            raw: stmt.raw,
          });
        }
        models.set(def.name, def);
      } else if (!cur && stmt.kind === 'param' && stmt.paramDefs) {
        Object.assign(globals, stmt.paramDefs);
      }
    }
  }

  return {
    side: input.side,
    files: ordered.map((o) => o.file),
    statements,
    subckts,
    models,
    globals,
    diagnostics,
    includeCycles,
  };
}
