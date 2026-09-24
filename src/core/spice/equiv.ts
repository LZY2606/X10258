import { contentId } from '../ids';
import type { FlatInstance, FlatNetlist } from './types';

export interface CandidatePair { left: string; right: string; }

export interface NodeCorrespondence {
  leftNode: string;
  rightNode: string | null;      // null = 未匹配
  status: 'matched' | 'ambiguous' | 'unmatched';
  candidates: string[];          // 多解时保留全部合法候选
}

export interface InstanceCorrespondence {
  leftPath: string;
  rightPath: string | null;
  status: 'matched' | 'ambiguous' | 'unmatched';
  candidates: string[];
}

export interface MinimalDiff {
  id: string;
  kind: 'PARAM_VALUE' | 'EXTRA_INSTANCE' | 'MISSING_INSTANCE' | 'CONNECTIVITY' | 'OPAQUE_UNDECIDED';
  summary: string;
  instances: string[];           // 涉及实例路径（left/right 前缀标注）
  nodes: string[];
  subgraph: { instances: FlatInstance[]; nodes: string[] };  // 最小不等价子图
  prov: { file: string; line: number }[];
}

export interface EquivResult {
  id: string;
  leftId: string;
  rightId: string;
  status: 'equivalent' | 'not-equivalent' | 'undetermined';
  nodeMap: NodeCorrespondence[];
  instanceMap: InstanceCorrespondence[];
  diffs: MinimalDiff[];
  symmetricGroups: string[][];   // 被允许置换的对称器件组
  explanation: string[];
}

/** 对称端口：R/C/L 两端可换；MOS 的 D/S 可换（置换只影响匹配，不改写原文）。 */
function symmetricPortGroups(inst: FlatInstance): number[][] {
  const n = inst.nodes.length;
  if (inst.kind === 'M' && n >= 4) return [[0, 2]];
  if (['R', 'C', 'L', 'D', 'V', 'I'].includes(inst.kind) && n === 2) return [[0, 1]];
  return [];
}

function paramSignature(inst: FlatInstance): string {
  const parts = inst.effectiveParams
    .filter(p => p.scope !== 'global') // 全局参数两侧同源，不进入签名
    .map(p => {
      const v = p.value;
      const norm = v.normalized !== undefined ? `=${v.normalized}` : `~${v.raw}`;
      return `${p.name.toLowerCase()}${norm}`;
    })
    .sort();
  const model = inst.modelName ? `|m:${inst.modelName.toLowerCase()}` : '';
  return `${inst.kind}${model}|${parts.join(',')}`;
}

interface Side { tag: 'L' | 'R'; flat: FlatNetlist; }

/** WL 颜色精化：在两侧并集上运行，颜色可跨侧比较。 */
function refine(left: FlatNetlist, right: FlatNetlist) {
  const instColor = new Map<string, string>();
  const nodeColor = new Map<string, string>();
  const key = (side: string, id: string) => `${side}:${id}`;

  const sides: Side[] = [{ tag: 'L', flat: left }, { tag: 'R', flat: right }];
  for (const s of sides) {
    for (const inst of s.flat.instances) {
      instColor.set(key(s.tag, inst.path), `${inst.kind}|${paramSignature(inst)}|deg${inst.nodes.length}${inst.opaque ? '|opaque' : ''}`);
    }
    for (const n of s.flat.nodes) {
      const deg = s.flat.instances.filter(i => i.nodes.includes(n)).length;
      nodeColor.set(key(s.tag, n), `deg${deg}`);
    }
  }
  for (let round = 0; round < 32; round++) {
    const nextInst = new Map<string, string>();
    const nextNode = new Map<string, string>();
    let changed = false;
    for (const s of sides) {
      for (const inst of s.flat.instances) {
        const groups = symmetricPortGroups(inst);
        const portLabels: string[] = inst.nodes.map((n, idx) => {
          const g = groups.find(g => g.includes(idx));
          const role = g ? `sym${groups.indexOf(g)}` : `p${idx}`;
          return `${role}@${nodeColor.get(key(s.tag, n))}`;
        });
        // 对称端口内部排序，使置换等价
        for (const g of groups) {
          const seg = g.map(i => portLabels[i]).sort();
          g.forEach((idx, k) => { portLabels[idx] = seg[k]; });
        }
        const c = contentId('c', instColor.get(key(s.tag, inst.path))!, ...portLabels);
        nextInst.set(key(s.tag, inst.path), c);
        if (c !== instColor.get(key(s.tag, inst.path))) changed = true;
      }
      for (const n of s.flat.nodes) {
        const attached = s.flat.instances
          .filter(i => i.nodes.includes(n))
          .map(i => instColor.get(key(s.tag, i.path))!)
          .sort();
        const c = contentId('c', 'node', ...attached);
        nextNode.set(key(s.tag, n), c);
        if (c !== nodeColor.get(key(s.tag, n))) changed = true;
      }
    }
    instColor.clear(); nextInst.forEach((v, k) => instColor.set(k, v));
    nodeColor.clear(); nextNode.forEach((v, k) => nodeColor.set(k, v));
    if (!changed) break;
  }
  return { instColor, nodeColor, key };
}

function groupByColor(ids: string[], colorOf: (id: string) => string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const id of ids) {
    const c = colorOf(id);
    const list = m.get(c) ?? [];
    list.push(id);
    m.set(c, list);
  }
  return m;
}

export function compareNetlists(left: FlatNetlist, right: FlatNetlist): EquivResult {
  const { instColor, nodeColor, key } = refine(left, right);
  const explanation: string[] = [];
  const diffs: MinimalDiff[] = [];
  const nodeMap: NodeCorrespondence[] = [];
  const instanceMap: InstanceCorrespondence[] = [];
  const symmetricGroups: string[][] = [];

  // ---- 实例匹配（按颜色类；类内多解全部保留）----
  const leftInstColors = groupByColor(left.instances.map(i => i.path), p => instColor.get(key('L', p))!);
  const rightInstColors = groupByColor(right.instances.map(i => i.path), p => instColor.get(key('R', p))!);
  const matchedInst = new Map<string, string>();
  const unmatchedLeft: string[] = [];
  const unmatchedRight: string[] = [];

  for (const [color, lPaths] of leftInstColors) {
    const rPaths = rightInstColors.get(color) ?? [];
    if (lPaths.length === 1 && rPaths.length === 1) {
      matchedInst.set(lPaths[0], rPaths[0]);
      instanceMap.push({ leftPath: lPaths[0], rightPath: rPaths[0], status: 'matched', candidates: [rPaths[0]] });
    } else if (lPaths.length === rPaths.length && lPaths.length > 1) {
      // 对称/重复结构：保留全部合法候选
      for (const lp of lPaths) {
        instanceMap.push({ leftPath: lp, rightPath: null, status: 'ambiguous', candidates: [...rPaths] });
        symmetricGroups.push([lp, ...rPaths]);
      }
      for (const lp of lPaths) matchedInst.set(lp, rPaths[0]); // 代表映射，候选不丢失
      explanation.push(`对称/重复结构：${lPaths.length} 个左实例与 ${rPaths.length} 个右实例互为合法候选，全部保留`);
    } else {
      unmatchedLeft.push(...lPaths);
      unmatchedRight.push(...rPaths);
    }
  }
  for (const [color, rPaths] of rightInstColors) {
    if (!leftInstColors.has(color)) unmatchedRight.push(...rPaths);
  }

  // ---- 节点匹配 ----
  const leftNodeColors = groupByColor(left.nodes, n => nodeColor.get(key('L', n))!);
  const rightNodeColors = groupByColor(right.nodes, n => nodeColor.get(key('R', n))!);
  for (const [color, lNodes] of leftNodeColors) {
    const rNodes = rightNodeColors.get(color) ?? [];
    if (lNodes.length === 1 && rNodes.length === 1) {
      nodeMap.push({ leftNode: lNodes[0], rightNode: rNodes[0], status: 'matched', candidates: [rNodes[0]] });
    } else if (lPathsLen(lNodes) === rNodes.length && lNodes.length > 1) {
      for (const ln of lNodes) nodeMap.push({ leftNode: ln, rightNode: null, status: 'ambiguous', candidates: [...rNodes] });
    } else {
      for (const ln of lNodes) nodeMap.push({ leftNode: ln, rightNode: null, status: 'unmatched', candidates: [] });
      for (const rn of rNodes) void rn;
    }
  }

  // ---- 未匹配实例配对：邻居重叠最大者优先，识别“仅参数不同” ----
  const rightByPath = new Map(right.instances.map(i => [i.path, i]));
  const leftByPath = new Map(left.instances.map(i => [i.path, i]));
  const usedRight = new Set<string>();
  const pairs: [string, string][] = [];
  for (const lp of unmatchedLeft) {
    const li = leftByPath.get(lp)!;
    let best: string | null = null;
    let bestScore = 0;
    for (const rp of unmatchedRight) {
      if (usedRight.has(rp)) continue;
      const ri = rightByPath.get(rp)!;
      if (ri.kind !== li.kind) continue;
      const lNbrs = new Set(li.nodes.map(n => nodeColor.get(key('L', n))));
      const score = ri.nodes.filter(n => lNbrs.has(nodeColor.get(key('R', n)))).length;
      if (score > bestScore) { bestScore = score; best = rp; }
    }
    if (best && bestScore > 0) { pairs.push([lp, best]); usedRight.add(best); }
  }

  for (const [lp, rp] of pairs) {
    const li = leftByPath.get(lp)!;
    const ri = rightByPath.get(rp)!;
    const lSig = paramSignature(li), rSig = paramSignature(ri);
    if (li.opaque || ri.opaque) {
      diffs.push({
        id: contentId('diff', 'opaque', lp, rp),
        kind: 'OPAQUE_UNDECIDED',
        summary: `未知元件 ${lp} ↔ ${rp}：opaque 连接保留，无法唯一裁定，候选全部保留`,
        instances: [`L:${lp}`, `R:${rp}`],
        nodes: [...li.nodes, ...ri.nodes],
        subgraph: { instances: [li, ri], nodes: [...new Set([...li.nodes, ...ri.nodes])] },
        prov: [li.prov, ri.prov].map(p => ({ file: p.file, line: p.line }))
      });
    } else if (lSig !== rSig) {
      diffs.push({
        id: contentId('diff', 'param', lp, rp),
        kind: 'PARAM_VALUE',
        summary: `参数差异 ${lp} ↔ ${rp}：${lSig} ≠ ${rSig}`,
        instances: [`L:${lp}`, `R:${rp}`],
        nodes: [...new Set([...li.nodes, ...ri.nodes])],
        subgraph: { instances: [li, ri], nodes: [...new Set([...li.nodes, ...ri.nodes])] },
        prov: [li.prov, ri.prov].map(p => ({ file: p.file, line: p.line }))
      });
    } else {
      diffs.push({
        id: contentId('diff', 'conn', lp, rp),
        kind: 'CONNECTIVITY',
        summary: `连接差异 ${lp} ↔ ${rp}`,
        instances: [`L:${lp}`, `R:${rp}`],
        nodes: [...new Set([...li.nodes, ...ri.nodes])],
        subgraph: { instances: [li, ri], nodes: [...new Set([...li.nodes, ...ri.nodes])] },
        prov: [li.prov, ri.prov].map(p => ({ file: p.file, line: p.line }))
      });
    }
  }

  const stillLeft = unmatchedLeft.filter(p => !pairs.some(([l]) => l === p));
  const stillRight = unmatchedRight.filter(p => !usedRight.has(p));
  for (const lp of stillLeft) {
    const li = leftByPath.get(lp)!;
    diffs.push({
      id: contentId('diff', 'missing', lp), kind: 'MISSING_INSTANCE',
      summary: `右侧缺失实例 ${lp}`,
      instances: [`L:${lp}`], nodes: li.nodes,
      subgraph: { instances: [li], nodes: li.nodes },
      prov: [{ file: li.prov.file, line: li.prov.line }]
    });
  }
  for (const rp of stillRight) {
    const ri = rightByPath.get(rp)!;
    diffs.push({
      id: contentId('diff', 'extra', rp), kind: 'EXTRA_INSTANCE',
      summary: `右侧多出实例 ${rp}`,
      instances: [`R:${rp}`], nodes: ri.nodes,
      subgraph: { instances: [ri], nodes: ri.nodes },
      prov: [{ file: ri.prov.file, line: ri.prov.line }]
    });
  }

  const hasOpaque = diffs.some(d => d.kind === 'OPAQUE_UNDECIDED');
  const status: EquivResult['status'] =
    diffs.length === 0 ? 'equivalent' : hasOpaque ? 'undetermined' : 'not-equivalent';
  explanation.push(
    status === 'equivalent' ? '连接、参数与器件语义在 alpha-rename 下等价'
    : status === 'undetermined' ? '存在未知元件，无法唯一裁定；全部合法候选已保留'
    : `发现 ${diffs.length} 处最小不等价子图`
  );

  return {
    id: contentId('equiv', left.id, right.id),
    leftId: left.id, rightId: right.id,
    status, nodeMap, instanceMap, diffs, symmetricGroups, explanation
  };
}

function lPathsLen(a: string[]): number { return a.length; }
