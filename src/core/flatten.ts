// 层次展开：节点/实例可 alpha-rename；参数作用域、默认值与表达式依赖不压平；
// 未知元件保留 opaque 连接而不删除。
import type { Diagnostic, Statement } from './parser.js';
import type { AssembledNetlist, SubcktDef } from './netlist.js';
import { exprDependencies, parseValue } from './units.js';

export interface ScopeFrame {
  level: 'instance' | 'subckt' | 'global';
  ref: string; // 例如 subckt:INV@… 或实例路径
  raw: string;
  stmtId: string;
}

export interface ParamBinding {
  name: string;
  rawExpr: string; // 原始表达式，永不改写
  normalized?: number; // 派生层规范化；不可转换时缺省
  diagnostic?: string;
  source: ScopeFrame; // 该绑定写在哪里
  deps: { name: string; resolvedIn?: ScopeFrame; normalized?: number }[];
}

export interface FlatValue {
  raw: string;
  normalized?: number;
  diagnostic?: string;
}

export interface FlatInstance {
  id: string; // 层次路径，如 X1/MP1
  displayName: string;
  kind: string;
  model?: string;
  nodes: string[]; // 展平节点 id
  params: ParamBinding[];
  values: FlatValue[];
  provenance: { stmtId: string; fileId: string; line: number; path: string[] };
  opaque: boolean;
  candidates?: { id: string; chosen: boolean }[]; // 子电路重名等产生的多候选
}

export interface FlatNetlist {
  side: string;
  instances: FlatInstance[];
  nets: { id: string; pins: string[] }[];
  diagnostics: Diagnostic[];
}

interface Frame {
  prefix: string; // 实例路径前缀，如 "X1/"
  nodeMap: Map<string, string>; // 局部节点 → 展平节点
  scopes: { level: ScopeFrame['level']; ref: string; stmtId: string; params: Record<string, string> }[];
}

const GLOBAL_NODES = new Set(['0', 'GND', 'GND!']);

function evalExpr(expr: string, resolve: (name: string) => number | undefined): number | undefined {
  let e = expr.trim();
  if (e.startsWith('{') && e.endsWith('}')) e = e.slice(1, -1);
  // 仅允许数字、标识符、运算符与常见函数
  if (!/^[0-9A-Za-z_.,+\-*/()'\s]*$/.test(e)) return undefined;
  const replaced = e.replace(/[A-Za-z_][A-Za-z0-9_.]*/g, (id) => {
    if (/^(exp|log|sqrt|abs|sin|cos|tan|min|max|pow)$/i.test(id)) return `Math.${id.toLowerCase()}`;
    const v = resolve(id);
    if (v === undefined) throw new Unresolved(id);
    return `(${v})`;
  });
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('Math', `"use strict"; return (${replaced});`);
    const out = fn(Math);
    return typeof out === 'number' && Number.isFinite(out) ? out : undefined;
  } catch (err) {
    if (err instanceof Unresolved) throw err;
    return undefined;
  }
}
class Unresolved extends Error { constructor(public id: string) { super(id); } }

export function flattenNetlist(nl: AssembledNetlist, opts?: { preferSubckt?: (name: string, candidates: SubcktDef[]) => SubcktDef }): FlatNetlist {
  const diagnostics: Diagnostic[] = [];
  const instances: FlatInstance[] = [];
  const bodyStmtIds = new Set<string>();
  for (const defs of nl.subckts.values()) for (const d of defs) for (const s of d.body) bodyStmtIds.add(s.id);

  const resolveParam = (frame: Frame, name: string): { frame?: ScopeFrame; normalized?: number } => {
    for (let i = frame.scopes.length - 1; i >= 0; i--) {
      const sc = frame.scopes[i];
      if (name in sc.params) {
        const raw = sc.params[name];
        const scopeFrame: ScopeFrame = { level: sc.level, ref: sc.ref, raw, stmtId: sc.stmtId };
        const pv = parseValue(raw);
        if (pv.ok) return { frame: scopeFrame, normalized: pv.normalized };
        // 表达式：继续解析其依赖
        try {
          const val = evalExpr(raw, (dep) => {
            const r = resolveParam(frame, dep);
            if (r.normalized === undefined) throw new Unresolved(dep);
            return r.normalized;
          });
          return { frame: scopeFrame, normalized: val };
        } catch { return { frame: scopeFrame, normalized: undefined }; }
      }
    }
    return {};
  };

  const bindParam = (frame: Frame, name: string, rawExpr: string, source: ScopeFrame): ParamBinding => {
    const deps = exprDependencies(rawExpr).map((dep) => {
      const r = resolveParam(frame, dep);
      return { name: dep, resolvedIn: r.frame, normalized: r.normalized };
    });
    const pv = parseValue(rawExpr);
    let normalized: number | undefined;
    let diagnostic: string | undefined;
    if (pv.ok) {
      normalized = pv.normalized;
      diagnostic = pv.diagnostic;
    } else {
      try {
        normalized = evalExpr(rawExpr, (dep) => {
          const hit = deps.find((d) => d.name === dep);
          if (hit?.normalized === undefined) throw new Unresolved(dep);
          return hit.normalized;
        });
        if (normalized === undefined) diagnostic = `表达式 "${rawExpr}" 无法规范化，保留原始表示`;
      } catch (err) {
        diagnostic = err instanceof Unresolved
          ? `依赖 "${err.id}" 无法解析，表达式 "${rawExpr}" 留在原位置`
          : `表达式 "${rawExpr}" 无法规范化，保留原始表示`;
      }
    }
    return { name, rawExpr, normalized, diagnostic, source, deps };
  };

  const mapNode = (frame: Frame, node: string): string => {
    if (GLOBAL_NODES.has(node.toUpperCase())) return '0';
    const mapped = frame.nodeMap.get(node);
    if (mapped) return mapped;
    return frame.prefix + node;
  };

  const expandElement = (frame: Frame, stmt: Statement, path: string[]) => {
    const id = frame.prefix + (stmt.name ?? stmt.id);
    const srcFrame = (raw: string): ScopeFrame => ({ level: 'subckt', ref: stmt.id, raw, stmtId: stmt.id });
    if (stmt.kind === 'unknown') {
      // 未知元件：全部位置 token 视为 opaque 连接，不删除
      const nodes = (stmt.nodes ?? []).concat(stmt.positional ?? []);
      instances.push({
        id, displayName: stmt.name ?? id, kind: stmt.elemKind ?? '?', nodes: nodes.map((n) => mapNode(frame, n)),
        params: Object.entries(stmt.params ?? {}).map(([k, v]) => bindParam(frame, k, v, srcFrame(v))),
        values: [], provenance: { stmtId: stmt.id, fileId: stmt.fileId, line: stmt.startLine, path },
        opaque: true,
      });
      return;
    }
    if (stmt.elemKind === 'X') {
      const subcktName = stmt.modelRef ?? '';
      const candidates = nl.subckts.get(subcktName) ?? [];
      if (candidates.length === 0) {
        diagnostics.push({ id: `diag:unresolved:${id}`, severity: 'warning', message: `子电路 "${subcktName}" 无定义（实例 ${id}）：保留 opaque 连接`, fileId: stmt.fileId, line: stmt.startLine, raw: stmt.raw });
        instances.push({
          id, displayName: stmt.name ?? id, kind: 'X', model: subcktName,
          nodes: (stmt.nodes ?? []).map((n) => mapNode(frame, n)),
          params: Object.entries(stmt.params ?? {}).map(([k, v]) => bindParam(frame, k, v, srcFrame(v))),
          values: [], provenance: { stmtId: stmt.id, fileId: stmt.fileId, line: stmt.startLine, path }, opaque: true,
        });
        return;
      }
      const def = opts?.preferSubckt?.(subcktName, candidates) ?? candidates[0];
      const actuals = stmt.nodes ?? [];
      const childMap = new Map<string, string>();
      def.nodes.forEach((formal, i) => {
        const actual = actuals[i];
        if (actual !== undefined) childMap.set(formal, mapNode(frame, actual));
      });
      const childPrefix = id + '/';
      const child: Frame = {
        prefix: childPrefix,
        nodeMap: childMap,
        scopes: [
          ...frame.scopes,
          { level: 'subckt', ref: def.id, stmtId: def.stmtId, params: def.defaults },
          { level: 'instance', ref: id, stmtId: stmt.id, params: stmt.params ?? {} },
        ],
      };
      instances.push({
        id, displayName: stmt.name ?? id, kind: 'X', model: `${subcktName} (${def.id})`,
        nodes: actuals.map((n) => mapNode(frame, n)),
        params: Object.entries(stmt.params ?? {}).map(([k, v]) => bindParam(frame, k, v, srcFrame(v))),
        values: [], provenance: { stmtId: stmt.id, fileId: stmt.fileId, line: stmt.startLine, path },
        opaque: false,
        candidates: candidates.map((c, i) => ({ id: c.id, chosen: c.id === def.id || (candidates.length > 0 && i === 0 && !opts?.preferSubckt) })),
      });
      for (const bodyStmt of def.body) {
        if (bodyStmt.kind === 'element' || bodyStmt.kind === 'unknown') expandElement(child, bodyStmt, [...path, id]);
      }
      return;
    }
    // 普通元件
    const values: FlatValue[] = (stmt.positional ?? []).map((t) => {
      const pv = parseValue(t);
      if (pv.ok) return { raw: t, normalized: pv.normalized, diagnostic: pv.diagnostic };
      const binding = bindParam(frame, `$value`, t, srcFrame(t));
      return { raw: t, normalized: binding.normalized, diagnostic: pv.diagnostic ?? binding.diagnostic };
    });
    instances.push({
      id, displayName: stmt.name ?? id, kind: stmt.elemKind ?? '?', model: stmt.modelRef,
      nodes: (stmt.nodes ?? []).map((n) => mapNode(frame, n)),
      params: Object.entries(stmt.params ?? {}).map(([k, v]) => bindParam(frame, k, v, srcFrame(v))),
      values,
      provenance: { stmtId: stmt.id, fileId: stmt.fileId, line: stmt.startLine, path },
      opaque: false,
    });
  };

  const topFrame: Frame = {
    prefix: '',
    nodeMap: new Map(),
    scopes: [{ level: 'global', ref: `${nl.side}:globals`, stmtId: `${nl.side}:globals`, params: nl.globals }],
  };
  for (const { stmt } of nl.statements) {
    if (bodyStmtIds.has(stmt.id)) continue;
    if (stmt.kind === 'element' || stmt.kind === 'unknown') expandElement(topFrame, stmt, []);
  }

  // 汇总 nets
  const nets = new Map<string, string[]>();
  for (const inst of instances) {
    inst.nodes.forEach((node, i) => {
      const pins = nets.get(node) ?? [];
      pins.push(`${inst.id}#${i}`);
      nets.set(node, pins);
    });
  }
  return {
    side: nl.side,
    instances,
    nets: [...nets.entries()].map(([id, pins]) => ({ id, pins })).sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics: [...nl.diagnostics, ...diagnostics],
  };
}
