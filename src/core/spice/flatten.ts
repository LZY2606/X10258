import { contentId } from '../ids';
import type {
  Diagnostic, FlatInstance, FlatNetlist, NetlistDoc, ParamAssign,
  ScopedParam, SubcktDef
} from './types';

interface Scope {
  path: string;
  kind: ScopedParam['scope'];
  params: Map<string, ParamAssign>;
  parent: Scope | null;
}

function scopeLookup(scope: Scope, name: string): { assign: ParamAssign; scope: Scope } | null {
  let cur: Scope | null = scope;
  const key = name.toLowerCase();
  while (cur) {
    const hit = cur.params.get(key);
    if (hit) return { assign: hit, scope: cur };
    cur = cur.parent;
  }
  return null;
}

function toMap(list: ParamAssign[]): Map<string, ParamAssign> {
  const m = new Map<string, ParamAssign>();
  for (const p of list) m.set(p.name.toLowerCase(), p);
  return m;
}

/**
 * 层次展平。
 * 语义：节点和实例可 alpha-rename（层次路径化）；
 * 参数作用域、默认值与表达式依赖不可压平 —— 每个有效参数记录来源作用域；
 * 未知元件保留 opaque 连接而不删除。
 */
export function flattenNetlist(doc: NetlistDoc): FlatNetlist {
  const diagnostics: Diagnostic[] = [...doc.diagnostics];
  const instances: FlatInstance[] = [];

  const subcktsByName = new Map<string, SubcktDef[]>();
  for (const s of doc.subckts) {
    const list = subcktsByName.get(s.name) ?? [];
    list.push(s);
    subcktsByName.set(s.name, list);
  }

  const globalScope: Scope = { path: '<global>', kind: 'global', params: toMap(doc.globals), parent: null };

  const resolveParams = (
    elParams: ParamAssign[], def: SubcktDef | null, instScope: Scope
  ): ScopedParam[] => {
    const out: ScopedParam[] = [];
    const seen = new Set<string>();
    const push = (name: string, assign: ParamAssign, scope: Scope, resolved: boolean) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        name, value: assign.value, scope: scope.kind, scopePath: scope.path, resolved
      });
    };
    // 优先级：实例 > 子电路默认 > 子电路局部 > 全局（只记录来源，不压平表达式）
    for (const p of elParams) push(p.name, p, instScope, true);
    if (def) {
      const localScope: Scope = { path: instScope.path + ':local', kind: 'subckt-local', params: toMap(def.params), parent: globalScope };
      const defScope: Scope = { path: instScope.path + ':defaults', kind: 'subckt-default', params: toMap(def.defaults), parent: localScope };
      for (const p of def.defaults) if (!seen.has(p.name.toLowerCase())) push(p.name, p, defScope, true);
      for (const p of def.params) if (!seen.has(p.name.toLowerCase())) push(p.name, p, localScope, true);
    }
    for (const p of doc.globals) if (!seen.has(p.name.toLowerCase())) push(p.name, p, globalScope, true);
    // 表达式依赖解析状态（不代入求值，只标注能否在作用域链内解析）
    for (const sp of out) {
      if (sp.value.kind === 'expr' || sp.value.kind === 'identifier') {
        sp.resolved = sp.value.dependsOn.every(d => out.some(o => o.name.toLowerCase() === d.toLowerCase()));
        if (!sp.resolved) {
          diagnostics.push({
            id: contentId('diag', 'unresolved-dep', instScope.path, sp.name),
            severity: 'warn', code: 'PARAM_DEP_UNRESOLVED',
            message: `参数 ${sp.name} 的依赖 [${sp.value.dependsOn.join(', ')}] 未全部在作用域链内解析，保留原表达式`,
            related: []
          });
        }
      }
    }
    return out;
  };

  const emitLeaf = (
    el: import('./types').Element, path: string, nodeMap: Map<string, string>,
    def: SubcktDef | null, parentScope: Scope
  ) => {
    const instScope: Scope = { path, kind: 'instance', params: toMap(el.params), parent: parentScope };
    const nodes = el.nodes.map(n => nodeMap.get(n) ?? `${path}/${n}`);
    instances.push({
      id: contentId('inst', doc.id, path),
      path, kind: el.kind, letter: el.letter,
      modelName: el.modelName, subcktName: el.subcktName,
      nodes, effectiveParams: resolveParams(el.params, def, instScope),
      opaque: el.opaque ?? false,
      sourceElementId: el.id, prov: el.prov
    });
  };

  const expand = (
    elements: import('./types').Element[], prefix: string,
    nodeMap: Map<string, string>, parentScope: Scope, stack: string[]
  ) => {
    for (const el of elements) {
      const path = prefix ? `${prefix}/${el.name.toLowerCase()}` : el.name.toLowerCase();
      if (el.kind === 'X') {
        const candidates = subcktsByName.get(el.subcktName ?? '') ?? [];
        if (candidates.length === 0) {
          diagnostics.push({
            id: contentId('diag', 'missing-subckt', path),
            severity: 'error', code: 'SUBCKT_MISSING',
            message: `实例 ${path} 引用的子电路 ${el.subcktName} 未定义，保留为 opaque 实例`,
            prov: el.prov, related: [el.id]
          });
          emitLeaf({ ...el, kind: 'UNKNOWN', opaque: true }, path, nodeMap, null, parentScope);
          continue;
        }
        const def = candidates[0];
        if (candidates.length > 1) {
          diagnostics.push({
            id: contentId('diag', 'ambiguous-subckt', path),
            severity: 'warn', code: 'SUBCKT_AMBIGUOUS_BIND',
            message: `实例 ${path} 绑定到重名子电路 ${def.name}（来源 ${def.sourceFile}）；候选 ${candidates.map(c => c.sourceFile).join(', ')} 均保留`,
            prov: el.prov, related: candidates.map(c => c.id)
          });
        }
        if (stack.includes(def.id)) {
          diagnostics.push({
            id: contentId('diag', 'recursion', path),
            severity: 'error', code: 'SUBCKT_RECURSION',
            message: `子电路递归实例化: ${path}，停止展开`,
            prov: el.prov, related: [def.id]
          });
          continue;
        }
        // 节点映射：形式端口 -> 实际节点（alpha-rename）；内部节点 -> 层次路径
        const childMap = new Map<string, string>();
        def.ports.forEach((port, i) => {
          const actual = el.nodes[i];
          childMap.set(port, actual ? (nodeMap.get(actual) ?? actual) : `${path}/<open:${port}>`);
        });
        const instScope: Scope = { path, kind: 'instance', params: toMap(el.params), parent: parentScope };
        expand(def.elements, path, childMap, instScope, [...stack, def.id]);
        // 子电路内部的 model 引用不改变连接；叶子参数在 emitLeaf 处理
        void 0;
      } else {
        emitLeaf(el, path, nodeMap, null, parentScope);
      }
    }
  };

  const topMap = new Map<string, string>();
  expand(doc.topElements, '', topMap, globalScope, []);

  const nodeSet = new Set<string>();
  for (const inst of instances) for (const n of inst.nodes) nodeSet.add(n);

  return {
    id: contentId('flat', doc.id, String(instances.length)),
    docId: doc.id,
    instances,
    nodes: [...nodeSet].sort(),
    diagnostics,
    stats: {
      instances: instances.length,
      nodes: nodeSet.size,
      opaque: instances.filter(i => i.opaque).length
    }
  };
}
