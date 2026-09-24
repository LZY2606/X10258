// 语义等价引擎：
//  - 节点与实例可 alpha-rename：用 (网络)-(元件) 二部多重图同构枚举，
//    保留全部合法映射候选；无法唯一决定时 determinate=false，多解不被吞掉
//  - 参数作用域结果按 (key, 归一化 SI 值或未解析原文) 比对，带来源链
//  - model 版本必须一致（activeVersionId 对不上即 finding）
//  - unknown 元件按 opaqueSignature 匹配，连接保留、绝不删除
//  - 非同构时给出多个最小不等价子图（按签名差异的闭包局部化）
import { shortId, stableHash } from './hash.js';
import { parseSpiceNumber } from './units.js';
import type {
  ComponentMapping, EquivFinding, EquivalenceResult, FlatComponent,
  FlattenedNetlist, MinimalDiff, NodeMapping,
} from '../shared/types.js';

export const RULE_VERSION = 'rules-1.0.0';
const MAX_MAPPINGS = 24;

interface Graph {
  flat: FlattenedNetlist;
  compById: Map<string, FlatComponent>;
  nodeDegree: Map<string, number>;
  compLabel: Map<string, string>;
  adjCompNode: Map<string, string[]>;
  adjNodeComp: Map<string, string[]>;
  nodeColor: Map<string, string>;
  compColor: Map<string, string>;
}

function fmtNum(x: number): string {
  return Number.isFinite(x) ? String(Math.round(x * 1e12) / 1e12) : String(x);
}

function paramValueKey(c: FlatComponent): string {
  return c.params
    .map((p) => {
      const v = p.evaluated && typeof p.value === 'number'
        ? fmtNum(p.value)
        : String(p.value);
      return `${p.key}=${v}`;
    })
    .sort()
    .join(';');
}

function compSignature(c: FlatComponent): string {
  if (c.unknown) {
    return `opaque:${c.opaqueSignature ?? '?'}:${paramValueKey(c)}`;
  }
  const modelKey = c.model
    ? `${c.model.name}|${c.model.activeVersionId ?? 'none'}`
    : '';
  return [c.kind, c.terminals.length, modelKey, paramValueKey(c)].join('|');
}

function buildGraph(flat: FlattenedNetlist): Graph {
  const compById = new Map(flat.components.map((c) => [c.id, c]));
  const adjCompNode = new Map<string, string[]>();
  const adjNodeComp = new Map<string, string[]>();
  const nodeDegree = new Map<string, number>();
  const compLabel = new Map<string, string>();

  for (const c of flat.components) {
    const nodeIds = c.terminals.map((t) => t.nodeId);
    adjCompNode.set(c.id, nodeIds);
    compLabel.set(c.id, compSignature(c));
    for (const nid of nodeIds) {
      const arr = adjNodeComp.get(nid) ?? [];
      arr.push(c.id);
      adjNodeComp.set(nid, arr);
      nodeDegree.set(nid, (nodeDegree.get(nid) ?? 0) + 1);
    }
  }
  for (const nd of flat.nodes) if (!nodeDegree.has(nd.id)) nodeDegree.set(nd.id, 0);

  // 初始颜色：元件=签名，节点=度数
  const compColor = new Map<string, string>();
  const nodeColor = new Map<string, string>();
  for (const c of flat.components) compColor.set(c.id, stableHash(compLabel.get(c.id)!));
  for (const nd of flat.nodes) nodeColor.set(nd.id, `d${nodeDegree.get(nd.id) ?? 0}`);

  // WL 细化若干轮（二部交替）
  for (let round = 0; round < flat.components.length + flat.nodes.length + 2 && round < 24; round++) {
    const nextComp = new Map<string, string>();
    for (const c of flat.components) {
      const neigh = (adjCompNode.get(c.id) ?? [])
        .map((nid) => nodeColor.get(nid)!)
        .sort();
      nextComp.set(c.id, stableHash(`C|${compLabel.get(c.id)}|${neigh.join(',')}`));
    }
    const nextNode = new Map<string, string>();
    for (const nd of flat.nodes) {
      const neigh = (adjNodeComp.get(nd.id) ?? [])
        .map((cid) => nextComp.get(cid) ?? compColor.get(cid)!)
        .sort();
      nextNode.set(nd.id, stableHash(`N|${nodeColor.get(nd.id)}|${neigh.join(',')}`));
    }
    let changed = false;
    for (const c of flat.components) if (nextComp.get(c.id) !== compColor.get(c.id)) changed = true;
    for (const nd of flat.nodes) if (nextNode.get(nd.id) !== nodeColor.get(nd.id)) changed = true;
    compColor.clear();
    nextComp.forEach((v, k) => compColor.set(k, v));
    nodeColor.clear();
    nextNode.forEach((v, k) => nodeColor.set(k, v));
    if (!changed) break;
  }

  return { flat, compById, nodeDegree, compLabel, adjCompNode, adjNodeComp, nodeColor, compColor };
}

// --- 同构枚举（元件→元件，连带节点绑定），允许对称端置换 ---
function terminalCompatible(a: FlatComponent, b: FlatComponent): boolean {
  if (a.terminals.length !== b.terminals.length) return false;
  if (a.kind !== b.kind && !(a.unknown && b.unknown)) return false;
  return true;
}

function symmetricPermutations(c: FlatComponent): number[][] {
  // R/C/L 两端元件对称；D 源极不对称；Q/M 按命名语义不做自由置换。
  // unknown：若同名端（原文完全一致）可交换，否则仅恒等——保守保留 opaque。
  if (c.kind === 'R' || c.kind === 'C' || c.kind === 'L') {
    const k = c.terminals.length;
    if (k === 2) return [[0, 1], [1, 0]];
  }
  return [c.terminals.map((_, i) => i)];
}

interface IsoSearch {
  gA: Graph;
  gB: Graph;
  results: { comps: Map<string, string>; nodes: Map<string, string>; perms: Map<string, number[]> }[];
}

function enumerateIsomorphisms(gA: Graph, gB: Graph) {
  const s: IsoSearch = { gA, gB, results: [] };
  const compMap = new Map<string, string>();
  const nodeMap = new Map<string, string>();
  const usedB = new Set<string>();
  const perms = new Map<string, number[]>();

  const compsA = [...gA.flat.components].sort((x, y) => {
    const ca = gA.compColor.get(x.id)!;
    const cb = gA.compColor.get(y.id)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    return (gA.adjCompNode.get(x.id)!.length - gA.adjCompNode.get(y.id)!.length);
  });

  const compatible = (a: FlatComponent, b: FlatComponent): boolean => {
    if (gA.compColor.get(a.id) !== gB.compColor.get(b.id)) {
      // 颜色不同只在非同构时有意义；同构搜索仍需签名一致
      if (compSignature(a) !== compSignature(b)) return false;
    }
    return terminalCompatible(a, b);
  };

  const backtrack = (idx: number) => {
    if (s.results.length >= MAX_MAPPINGS) return;
    if (idx === compsA.length) {
      // 未连接节点（孤立网络）按颜色配对补全
      const nodeCopy = new Map(nodeMap);
      for (const na of gA.flat.nodes) {
        if (nodeCopy.has(na.id)) continue;
        const cand = gB.flat.nodes.find((nb) =>
          !nodeCopyBHas(nodeCopy, nb.id) && gA.nodeColor.get(na.id) === gB.nodeColor.get(nb.id));
        if (cand) nodeCopy.set(na.id, cand.id);
      }
      s.results.push({
        comps: new Map(compMap),
        nodes: nodeCopy,
        perms: new Map(perms),
      });
      return;
    }
    const a = compsA[idx]!;
    let progressed = false;
    for (const b of gB.flat.components) {
      if (usedB.has(b.id)) continue;
      if (!compatible(a, b)) continue;
      const permsA = symmetricPermutations(a);
      for (const perm of permsA) {
        const trialNodes = new Map(nodeMap);
        let ok = true;
        for (let ti = 0; ti < a.terminals.length; ti++) {
          const nA = a.terminals[perm[ti]!]!.nodeId;
          const nB = b.terminals[ti]!.nodeId;
          const prev = trialNodes.get(nA);
          if (prev !== undefined && prev !== nB) { ok = false; break; }
          if (prev === undefined && [...trialNodes.values()].includes(nB)) { ok = false; break; }
          trialNodes.set(nA, nB);
        }
        if (!ok) continue;
        // 已绑定元件邻接一致性
        if (!consistentNeighbors(gA, gB, a, b, trialNodes)) continue;
        compMap.set(a.id, b.id);
        usedB.add(b.id);
        perms.set(a.id, perm);
        for (const [k, v] of trialNodes) if (!nodeMap.has(k)) nodeMap.set(k, v);
        progressed = true;
        backtrack(idx + 1);
        compMap.delete(a.id);
        usedB.delete(b.id);
        perms.delete(a.id);
        for (const k of trialNodes.keys()) nodeMap.delete(k);
        if (s.results.length >= MAX_MAPPINGS) return;
      }
    }
    if (!progressed && compsA[idx]) {
      // 无法放置：非同构，记录部分映射后直接返回
      return;
    }
  };

  backtrack(0);
  return s.results;
}

function nodeCopyBHas(m: Map<string, string>, bId: string): boolean {
  for (const v of m.values()) if (v === bId) return true;
  return false;
}

function consistentNeighbors(
  gA: Graph, gB: Graph,
  a: FlatComponent, b: FlatComponent,
  nodeMap: Map<string, string>,
): boolean {
  // 若 a 的某邻接节点已绑定，检查 b 是否有同色元件邻接
  const aNeighbors = new Set((gA.adjCompNode.get(a.id) ?? []).map((n) => nodeMap.get(n)));
  const bNeighbors = new Set(gB.adjCompNode.get(b.id) ?? []);
  for (const n of aNeighbors) {
    if (n === undefined) continue;
    if (!bNeighbors.has(n)) return false;
  }
  return true;
}

function paramMap(c: FlatComponent): Map<string, FlatComponent['params'][number]> {
  return new Map(c.params.map((p) => [p.key, p]));
}

function diffParameters(a: FlatComponent, b: FlatComponent): string[] {
  const diffs: string[] = [];
  const ma = paramMap(a);
  const mb = paramMap(b);
  const keys = new Set([...ma.keys(), ...mb.keys()]);
  for (const key of keys) {
    const pa = ma.get(key);
    const pb = mb.get(key);
    if (!pa || !pb) {
      diffs.push(`参数 ${key} 只存在于一侧（作用域默认值未被压平，仍按来源呈现）`);
      continue;
    }
    const va = pa.evaluated && typeof pa.value === 'number' ? fmtNum(pa.value) : String(pa.value);
    const vb = pb.evaluated && typeof pb.value === 'number' ? fmtNum(pb.value) : String(pb.value);
    if (va !== vb) {
      diffs.push(`参数 ${key}: A=${pa.raw}(${va}) vs B=${pb.raw}(${vb})`);
    }
  }
  return diffs;
}

function computeMinimalDiffs(gA: Graph, gB: Graph, matched: Map<string, string> | null): MinimalDiff[] {
  const diffs: MinimalDiff[] = [];
  const seen = new Set<string>();

  const pushDiff = (ids: string[], reason: string) => {
    const key = [...ids].sort().join('|') + '|' + reason;
    if (seen.has(key)) return;
    seen.add(key);
    diffs.push({
      id: shortId('diff', key),
      componentIds: ids.filter((x) => x.startsWith('c::')),
      nodeIds: ids.filter((x) => x.startsWith('n::')),
      reason,
      size: ids.length,
    });
  };

  if (!matched) {
    // 按颜色聚类报告所有无法配对的元件与邻接网络（多个最小差异）
    const colorGroupsB = new Map<string, string[]>();
    for (const c of gB.flat.components) {
      const col = gB.compColor.get(c.id)!;
      const arr = colorGroupsB.get(col) ?? [];
      arr.push(c.id);
      colorGroupsB.set(col, arr);
    }
    for (const c of gA.flat.components) {
      const col = gA.compColor.get(c.id)!;
      const pool = colorGroupsB.get(col);
      if (!pool || pool.length === 0) {
        const closure = localClosure(gA, [c.id]);
        pushDiff(closure, `元件 ${c.name}(${c.kind}) 在另一侧无同签名对应：${gA.compLabel.get(c.id)}`);
      } else {
        pool.pop();
      }
    }
    for (const pool of colorGroupsB.values()) {
      for (const cid of pool) {
        const c = gB.compById.get(cid)!;
        pushDiff(localClosure(gB, [cid]), `元件 ${c.name}(${c.kind}) 在另一侧无同签名对应`);
      }
    }
    // 度数颜色不同的网络
    const bNodeColors = new Map<string, number>();
    for (const nd of gB.flat.nodes) {
      const col = gB.nodeColor.get(nd.id)!;
      bNodeColors.set(col, (bNodeColors.get(col) ?? 0) + 1);
    }
    for (const nd of gA.flat.nodes) {
      const col = gA.nodeColor.get(nd.id)!;
      const left = bNodeColors.get(col) ?? 0;
      if (left === 0) {
        pushDiff([nd.id], `网络 ${nd.name} 邻接签名在另一侧不存在`);
      } else {
        bNodeColors.set(col, left - 1);
      }
    }
    return diffs.sort((x, y) => x.size - y.size);
  }

  // 已同构：差异只来自参数/model 版本（签名里已含），此处覆盖未解析单位等语义 finding
  for (const [caId, cbId] of matched) {
    const ca = gA.compById.get(caId)!;
    const cb = gB.compById.get(cbId)!;
    const pd = diffParameters(ca, cb);
    if (pd.length) {
      pushDiff(localClosure(gA, [caId]), pd.join('；'));
    }
    if (ca.model?.activeVersionId && cb.model?.activeVersionId &&
        ca.model.name.toUpperCase() === cb.model.name.toUpperCase() &&
        ca.model.activeVersionId !== cb.model.activeVersionId) {
      pushDiff([caId, cbId], `model ${ca.model.name} 激活版本不一致`);
    }
  }
  return diffs.sort((x, y) => x.size - y.size);
}

function localClosure(g: Graph, seeds: string[]): string[] {
  // 一个元件 + 其直接邻接网络，构成最小局部差异
  const out = new Set<string>(seeds);
  for (const id of seeds) {
    for (const nid of g.adjCompNode.get(id) ?? []) out.add(nid);
  }
  return [...out];
}
