import type {
  EquivNote, EquivResult, FlatDevice, FlatNetlist,
  MinimalDiff, NodeCorrespondence,
} from './types';

// 对称器件：允许置换的引脚组（索引）
const SYMMETRIC: Record<string, number[][]> = {
  R: [[0, 1]], C: [[0, 1]], L: [[0, 1]], D: [], I: [], V: [],
  M: [[0, 2]], // D <-> S 可置换（对称器件置换）
};

const MAX_SOLUTIONS = 8;

interface DevSig { dev: FlatDevice; sig: string; valueKey: string }

function paramKey(d: FlatDevice): string {
  return d.params
    .map(p => `${p.name}=${p.norm.value === undefined ? `RAW:${p.raw}` : p.norm.value}`)
    .sort().join('|');
}

function signature(d: FlatDevice): string {
  return `${d.kind}|${d.model ?? ''}|${paramKey(d)}|pins:${d.pins.length}`;
}

function permsFor(dev: FlatDevice): number[][] {
  const groups = SYMMETRIC[dev.kind] ?? [];
  let perms: number[][] = [dev.pins.map((_, i) => i)];
  for (const g of groups) {
    const next: number[][] = [];
    for (const p of perms) {
      next.push(p);
      const swapped = [...p];
      for (let i = 0; i + 1 < g.length; i += 2) {
        const t = swapped[g[i]]; swapped[g[i]] = swapped[g[i + 1]]; swapped[g[i + 1]] = t;
      }
      next.push(swapped);
    }
    perms = next;
  }
  return perms;
}

export interface EquivOptions { maxSolutions?: number }

// 图匹配：网与实例可 alpha-rename；参数作用域/依赖差异记为 note，不压平。
export function compareNetlists(a: FlatNetlist, b: FlatNetlist, opts: EquivOptions = {}): EquivResult {
  const maxSolutions = opts.maxSolutions ?? MAX_SOLUTIONS;
  const notes: EquivNote[] = [];
  const devsA = a.devices.filter(d => d.kind !== 'X');
  const devsB = b.devices.filter(d => d.kind !== 'X');
  const opaqueKept = [...devsA, ...devsB].filter(d => d.opaque).map(d => d.id);
  if (opaqueKept.length > 0) {
    notes.push({ kind: 'opaque-kept', message: `未知元件保留 opaque 连接: ${opaqueKept.join(', ')}`, objects: opaqueKept });
  }

  // 作用域/依赖差异：值相等但表达式依赖不同 -> 记录，不吞掉
  const bBySigLoose = new Map<string, FlatDevice[]>();
  for (const d of devsB) {
    const k = `${d.kind}|${d.model ?? ''}`;
    const l = bBySigLoose.get(k) ?? []; l.push(d); bBySigLoose.set(k, l);
  }
  for (const da of devsA) {
    for (const db of bBySigLoose.get(`${da.kind}|${da.model ?? ''}`) ?? []) {
      for (const pa of da.params) {
        const pb = db.params.find(p => p.name === pa.name);
        if (!pb) continue;
        const sameValue = pa.norm.value !== undefined && pa.norm.value === pb.norm.value;
        const depDiff = pa.deps.join(',') !== pb.deps.join(',');
        const originDiff = pa.provenance.origin !== pb.provenance.origin;
        if (sameValue && (depDiff || originDiff)) {
          notes.push({
            kind: 'scope-dependency',
            message: `参数 ${pa.name} 数值相等但作用域/依赖不同（${pa.provenance.origin} vs ${pb.provenance.origin}; deps [${pa.deps}] vs [${pb.deps}]），不可压平`,
            objects: [da.id, db.id],
          });
        }
      }
    }
  }

  // 签名分桶
  const bucketsB = new Map<string, FlatDevice[]>();
  for (const d of devsB) {
    const k = signature(d);
    const l = bucketsB.get(k) ?? []; l.push(d); bucketsB.set(k, l);
  }

  const netMapAB = new Map<string, string>();
  const netMapBA = new Map<string, string>();
  const usedB = new Set<string>();
  const solutions: NodeCorrespondence[][] = [];
  const order = [...devsA].sort((x, y) => signature(x).localeCompare(signature(y)));

  const search = (idx: number, mapping: Map<string, string>) => {
    if (solutions.length >= maxSolutions) return;
    if (idx === order.length) {
      const corr: NodeCorrespondence[] = [...mapping.entries()]
        .map(([na, nb]) => ({ a: na, b: nb, confidence: 'exact' as const }));
      solutions.push(corr);
      return;
    }
    const da = order[idx];
    const candidates = (bucketsB.get(signature(da)) ?? []).filter(d => !usedB.has(d.id));
    for (const db of candidates) {
      for (const perm of permsFor(db)) {
        // 检查引脚映射一致性
        const added: [string, string][] = [];
        let ok = true;
        for (let i = 0; i < da.pins.length; i++) {
          const na = da.pins[i];
          const nb = db.pins[perm[i]];
          const cur = netMapAB.get(na);
          if (cur !== undefined && cur !== nb) { ok = false; break; }
          const curB = netMapBA.get(nb);
          if (curB !== undefined && curB !== na) { ok = false; break; }
          if (cur === undefined) { added.push([na, nb]); }
        }
        if (!ok) continue;
        for (const [na, nb] of added) { netMapAB.set(na, nb); netMapBA.set(nb, na); }
        usedB.add(db.id);
        search(idx + 1, netMapAB);
        usedB.delete(db.id);
        for (const [na, nb] of added) { netMapAB.delete(na); netMapBA.delete(nb); }
        if (solutions.length >= maxSolutions) return;
      }
    }
  };
  search(0, netMapAB);

  const matchedCount = (sol: NodeCorrespondence[]) => sol.length;

  if (solutions.length > 0) {
    const anyPerm = devsA.some(d => (SYMMETRIC[d.kind] ?? []).length > 0);
    if (anyPerm) notes.push({ kind: 'symmetric-permutation', message: '对称器件引脚置换已允许（如 M 的 D/S）', objects: [] });
    const renamed = solutions[0].filter(c => c.a !== c.b);
    if (renamed.length > 0) {
      notes.push({ kind: 'alpha-rename', message: `节点经 alpha-rename 对应: ${renamed.slice(0, 6).map(c => `${c.a}~${c.b}`).join(', ')}${renamed.length > 6 ? ' …' : ''}`, objects: renamed.flatMap(c => [c.a, c.b]) });
    }
    const unitNorm = [...devsA, ...devsB].some(d => d.params.some(p => p.norm.suffix));
    if (unitNorm) notes.push({ kind: 'unit-normalized', message: '单位后缀在派生层规范化后比较，原始表示未改写', objects: [] });
    return {
      status: solutions.length > 1 ? 'ambiguous' : 'equivalent',
      solutions, minimalDiffs: [], opaqueKept, notes,
    };
  }

  // 不等价：贪心最大匹配 + 最小差异子图（可多个）
  const greedyMatchedA = new Set<string>();
  const greedyMatchedB = new Set<string>();
  const unmatchedA: FlatDevice[] = [];
  const poolB = new Map<string, FlatDevice[]>();
  for (const d of devsB) {
    const k = signature(d);
    const l = poolB.get(k) ?? []; l.push(d); poolB.set(k, l);
  }
  for (const da of devsA) {
    const cand = (poolB.get(signature(da)) ?? []).find(d => !greedyMatchedB.has(d.id));
    if (cand) { greedyMatchedA.add(da.id); greedyMatchedB.add(cand.id); }
    else unmatchedA.push(da);
  }
  const unmatchedB = devsB.filter(d => !greedyMatchedB.has(d.id));

  // 结构失配（签名相同但连接不同）也纳入差异
  const diffs: MinimalDiff[] = [];
  const diffNets = new Set<string>();
  const seedDevices = [...unmatchedA, ...unmatchedB];
  if (seedDevices.length === 0) {
    // 签名全匹配但连接失败：取失配网邻域
    const netsA = new Set(devsA.map(d => d.pins.join(',')));
    const onlyA = devsA.filter(d => !netsA.has(d.pins.join(',')) || true);
    seedDevices.push(...onlyA.slice(0, 2));
  }
  let diffSeq = 0;
  const covered = new Set<string>();
  for (const seed of seedDevices) {
    if (covered.has(seed.id)) continue;
    // 连通闭包（限制在失配邻域内，保持最小）
    const compDevsA: string[] = [];
    const compDevsB: string[] = [];
    const compNets = new Set<string>();
    const queue = [seed];
    const seen = new Set<string>();
    const allDevs = new Map([...devsA, ...devsB].map(d => [d.id, d]));
    while (queue.length > 0) {
      const cur = queue.pop()!;
      if (seen.has(cur.id)) continue;
      seen.add(cur.id);
      covered.add(cur.id);
      (devsA.includes(cur) ? compDevsA : compDevsB).push(cur.id);
      for (const n of cur.pins) {
        compNets.add(n);
        for (const other of allDevs.values()) {
          if (!seen.has(other.id) && other.pins.includes(n) &&
              (unmatchedA.includes(other) || unmatchedB.includes(other))) {
            queue.push(other);
          }
        }
      }
    }
    diffs.push({
      id: `diff:${++diffSeq}`,
      devicesA: compDevsA, devicesB: compDevsB,
      nets: [...compNets],
      reason: `签名或连接失配的最小连通子图（${compDevsA.length + compDevsB.length} 个器件）`,
    });
  }
  for (const d of seedDevices) d.pins.forEach(n => diffNets.add(n));

  return {
    status: 'not-equivalent',
    solutions: [], minimalDiffs: diffs, opaqueKept, notes,
  };
}
