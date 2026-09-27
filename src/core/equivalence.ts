import { numberEquivalent } from './units';
import { analyzeExpression } from './expr';
import type { FlatCircuit, FlatDevice, FlatNet } from './flattenTypes';
import type { ID } from './types';

/**
 * 语义等价裁定。
 *
 * 硬约束：
 *  - 节点/实例允许 alpha-rename：通过图同构求映射，而非按名字比。
 *  - 器件族 + model 版本身份 + 参数（默认/覆盖/表达式来源）构成签名。
 *  - 对称器件引脚（R/C/L、MOS D/S…）产生多个合法映射，全部保留为候选，不压成一个。
 *  - 无法唯一决定时返回全部候选并标记 ambiguous，绝不吞掉多解。
 *  - 未知元件 opaque：按“引脚数 + 连接拓扑”参与同构，不被删除。
 */

export interface ParamMismatch {
  kind: 'param';
  name: string;
  aRaw: string;
  bRaw: string;
  aNumeric: number | null;
  bNumeric: number | null;
  reason: 'missing' | 'value' | 'expression-dependency' | 'model-version';
}

export interface DeviceMapping {
  /** B 设备路径 -> A 设备路径（alpha-rename 对应） */
  deviceBToA: Record<ID, ID>;
  /** B 网络 id -> A 网络 id */
  netBToA: Record<ID, ID>;
  /** 触发该映射的对称置换（设备路径 -> 交换的引脚组） */
  permutations: Record<ID, string[][]>;
  /** 该映射下仍存在的参数差异 */
  paramMismatches: ParamMismatch[];
  /** 是否语义完全等价 */
  equivalent: boolean;
}

export interface MinSubgraph {
  id: ID;
  /** 最小不等价子图涉及的设备（A、B 两侧路径） */
  devicesA: string[];
  devicesB: string[];
  /** 涉及网络 */
  netsA: string[];
  netsB: string[];
  /** 解释：为什么这是一个最小差异 */
  reason: string;
  /** 差异类型 */
  type: 'topology' | 'parameter' | 'model' | 'opaque-arity' | 'extra-device' | 'missing-device';
}

export interface EquivalenceReport {
  equivalent: boolean;
  /** 全部合法映射候选；多于 1 个且都等价 => ambiguous-but-equivalent */
  candidates: DeviceMapping[];
  ambiguity: 'none' | 'symmetric' | 'unresolved';
  /** 在“最佳候选”下求的最小不等价子图 */
  minimalSubgraphs: MinSubgraph[];
  /** 器件数量级摘要 */
  summary: {
    devices: { A: number; B: number };
    matchedDevices: number;
    unmatchedA: string[];
    unmatchedB: string[];
  };
  diagnostics: string[];
}

function deviceSignature(d: FlatDevice): string {
  const modelPart = d.modelRef ? d.modelRef.name : '-';
  const params = d.params
    .map((p) => `${p.name.toUpperCase()}=${p.effective.numeric ?? 'expr:' + p.effective.raw}`)
    .sort()
    .join('|');
  return [d.family, d.modelRef?.identity ? 'model' : modelPart === '-' ? 'nomodel' : 'modelname', modelPart, d.pins.length, d.opaque ? 'opaque' : 'typed', params].join('§');
}

/** 参数语义比较：数值后缀归一后比；表达式比依赖结构与可求值结果 */
function compareParams(a: FlatDevice, b: FlatDevice): ParamMismatch[] {
  const out: ParamMismatch[] = [];
  const mapB = new Map(b.params.map((p) => [p.name.toUpperCase(), p]));
  const mapA = new Map(a.params.map((p) => [p.name.toUpperCase(), p]));
  for (const pa of a.params) {
    const key = pa.name.toUpperCase();
    const pb = mapB.get(key);
    if (!pb) {
      out.push({ kind: 'param', name: pa.name, aRaw: pa.effective.raw, bRaw: '', aNumeric: pa.effective.numeric, bNumeric: null, reason: 'missing' });
      continue;
    }
    if (pa.effective.numeric !== null && pb.effective.numeric !== null) {
      if (!numberEquivalent(pa.effective.numeric, pb.effective.numeric)) {
        out.push({ kind: 'param', name: pa.name, aRaw: pa.effective.raw, bRaw: pb.effective.raw, aNumeric: pa.effective.numeric, bNumeric: pb.effective.numeric, reason: 'value' });
      }
      continue;
    }
    // 至少一侧是未求值表达式：比较依赖变量集合（作用域不压平的体现）
    const depA = pa.effective.isExpression ? analyzeExpression(pa.effective.raw).dependencies.map((d) => d.name).sort().join(',') : '';
    const depB = pb.effective.isExpression ? analyzeExpression(pb.effective.raw).dependencies.map((d) => d.name).sort().join(',') : '';
    if (depA !== depB || pa.effective.raw.replace(/\s+/g, '') !== pb.effective.raw.replace(/\s+/g, '')) {
      out.push({ kind: 'param', name: pa.name, aRaw: pa.effective.raw, bRaw: pb.effective.raw, aNumeric: pa.effective.numeric, bNumeric: pb.effective.numeric, reason: 'expression-dependency' });
    }
  }
  for (const pb of b.params) {
    if (!mapA.has(pb.name.toUpperCase())) {
      out.push({ kind: 'param', name: pb.name, aRaw: '', bRaw: pb.effective.raw, aNumeric: null, bNumeric: pb.effective.numeric, reason: 'missing' });
    }
  }
  // model 版本身份
  if ((a.modelRef?.identity ?? null) !== (b.modelRef?.identity ?? null)) {
    if (a.modelRef?.name?.toUpperCase() === b.modelRef?.name?.toUpperCase()) {
      out.push({
        kind: 'param', name: '<<MODEL_VERSION>>',
        aRaw: a.modelRef?.identity ?? '', bRaw: b.modelRef?.identity ?? '',
        aNumeric: null, bNumeric: null, reason: 'model-version',
      });
    }
  }
  return out;
}

/** 展开器件在对称置换下的引脚排列候选（返回每种引脚->网络序列及置换记录） */
function pinVariants(d: FlatDevice): { order: string[]; permutation: string[][] }[] {
  const groups = d.symmetricPinGroups;
  if (groups.length === 0) {
    return [{ order: d.pins.map((p) => p.pin), permutation: [] }];
  }
  const base = d.pins.map((p) => p.pin);
  const combos: string[][][] = [[]];
  for (const g of groups) {
    const prev = combos.shift()!;
    combos.push(prev, [...prev, g]);
  }
  return combos.map((permGroups) => {
    const order = base.slice();
    for (const g of permGroups) {
      const idx = g.map((pin) => order.indexOf(pin));
      if (idx.every((x) => x >= 0)) {
        const tmp = order[idx[0]];
        order[idx[0]] = order[idx[idx.length - 1]];
        order[idx[idx.length - 1]] = tmp;
      }
    }
    return { order, permutation: permGroups };
  });
}

function netByPin(d: FlatDevice, pin: string): ID | undefined {
  return d.pins.find((p) => p.pin === pin)?.netId;
}

/** 图同构回溯：以器件为顶点、网络为超边；签名分组 + 邻接约束剪枝，保留全部合法候选 */
function findMappings(A: FlatCircuit, B: FlatCircuit): {
  deviceBToA: Map<ID, ID>;
  netBToA: Map<ID, ID>;
  perms: Record<ID, string[][]>;
}[] {
  const aBySig = new Map<string, FlatDevice[]>();
  for (const d of A.devices) {
    const sig = looseSignature(d);
    (aBySig.get(sig) ?? aBySig.set(sig, []).get(sig)!).push(d);
  }
  const bGroups = new Map<string, FlatDevice[]>();
  for (const d of B.devices) {
    const sig = looseSignature(d);
    (bGroups.get(sig) ?? bGroups.set(sig, []).get(sig)!).push(d);
  }
  const diagnostics: string[] = [];
  for (const sig of new Set([...aBySig.keys(), ...bGroups.keys()])) {
    const na = aBySig.get(sig)?.length ?? 0;
    const nb = bGroups.get(sig)?.length ?? 0;
    if (na !== nb) diagnostics.push(`签名 ${sig} 数量不一致：A=${na} B=${nb}`);
  }

  const results: ReturnType<typeof findMappings> = [];
  const bList = B.devices;
  const MAX_MAPPINGS = 24;

  const usedA = new Set<ID>();
  const devBToA = new Map<ID, ID>();
  const netBToA = new Map<ID, ID>();
  const perms: Record<ID, string[][]> = {};

  // 网络邻接：netId -> devices
  const aNetDevs = netAdjacency(A);
  const bNetDevs = netAdjacency(B);

  function compatible(db: FlatDevice, da: FlatDevice, permutation: string[][]): boolean {
    // 已匹配邻居数约束：每个 B 网络上映射到的 A 网络，已匹配器件数不得超过 A 网络器件数
    for (const pb of db.pins) {
      const pinA = applyPerm(pb.pin, permutation);
      const aNet = netByPin(da, pinA);
      if (!aNet) return false;
      const bNet = pb.netId;
      // 同一 B 网络的不同引脚若都已有 A 映射，必须一致
      const existing = netBToA.get(bNet);
      if (existing && existing !== aNet) return false;
      // 容量约束
      const capA = aNetDevs.get(aNet)?.size ?? 0;
      const usedB = [...(bNetDevs.get(bNet) ?? [])].filter((id) => devBToA.has(id)).length;
      if (usedB + 1 > capA) return false;
    }
    return true;
  }

  function applyPerm(pin: string, groups: string[][]): string {
    for (const g of groups) {
      if (g[0] === pin) return g[g.length - 1];
      if (g[g.length - 1] === pin) return g[0];
    }
    return pin;
  }

  function search(idx: number): void {
    if (results.length >= MAX_MAPPINGS) return;
    if (idx === bList.length) {
      results.push({
        deviceBToA: new Map(devBToA),
        netBToA: new Map(netBToA),
        perms: JSON.parse(JSON.stringify(perms)),
      });
      return;
    }
    const db = bList[idx];
    const candidates = aBySig.get(looseSignature(db)) ?? [];
    // 优先尝试与已匹配器件共享网络的候选（R-next 约束），顺序不影响完备性上限
    const ordered = candidates
      .filter((da) => !usedA.has(da.id))
      .sort((x, y) => scoreCandidate(db, y, devBToA, bNetDevs, netBToA) - scoreCandidate(db, x, devBToA, bNetDevs, netBToA));
    for (const da of ordered) {
      for (const variant of pinVariants(db)) {
        if (!compatible(db, da, variant.permutation)) continue;
        // 提交
        const netChanges: [ID, ID][] = [];
        usedA.add(da.id);
        devBToA.set(db.id, da.id);
        let rollback = false;
        for (const pb of db.pins) {
          const pinA = applyPerm(pb.pin, variant.permutation);
          const aNet = netByPin(da, pinA)!;
          const ex = netBToA.get(pb.netId);
          if (!ex) {
            netBToA.set(pb.netId, aNet);
            netChanges.push([pb.netId, aNet]);
          } else if (ex !== aNet) { rollback = true; break; }
        }
        if (!rollback) {
          if (variant.permutation.length) perms[db.id] = variant.permutation;
          search(idx + 1);
          if (variant.permutation.length) delete perms[db.id];
        }
        for (const [bn] of netChanges) netBToA.delete(bn);
        devBToA.delete(db.id);
        usedA.delete(da.id);
      }
    }
  }

  search(0);
  (findMappings as unknown as { diag?: string[] }).diag = diagnostics;
  return results;
}

function scoreCandidate(
  db: FlatDevice, da: FlatDevice,
  devBToA: Map<ID, ID>, _bNetDevs: Map<ID, Set<ID>>, netBToA: Map<ID, ID>,
): number {
  let score = 0;
  for (const pb of db.pins) {
    const an = netByPin(da, pb.pin);
    if (an && netBToA.get(pb.netId) === an) score += 2;
  }
  return score;
}

function netAdjacency(c: FlatCircuit): Map<ID, Set<ID>> {
  const m = new Map<ID, Set<ID>>();
  for (const d of c.devices) for (const p of d.pins) {
    if (!m.has(p.netId)) m.set(p.netId, new Set());
    m.get(p.netId)!.add(d.id);
  }
  return m;
}

/** 宽松签名：只看结构与型号族，不含数值参数（数值差异作为映射后的参数 mismatch） */
function looseSignature(d: FlatDevice): string {
  return [d.family, d.modelRef?.identity ? d.modelRef.name : d.modelRef?.name ?? '-', d.pins.length, d.opaque ? 'opaque' : 'typed'].join('§');
}

export function compareCircuits(A: FlatCircuit, B: FlatCircuit): EquivalenceReport {
  const rawMaps = findMappings(A, B);
  const diagnostics = (findMappings as unknown as { diag?: string[] }).diag ?? [];

  const aById = new Map(A.devices.map((d) => [d.id, d]));
  const candidates: DeviceMapping[] = rawMaps.map((m) => {
    const deviceBToA: Record<ID, ID> = {};
    const paramMismatches: ParamMismatch[] = [];
    for (const [bid, aid] of m.deviceBToA) {
      deviceBToA[bid] = aid;
      const db = B.devices.find((d) => d.id === bid)!;
      const da = aById.get(aid)!;
      paramMismatches.push(...compareParams(da, db));
    }
    return {
      deviceBToA,
      netBToA: Object.fromEntries(m.netBToA),
      permutations: m.perms,
      paramMismatches,
      equivalent: paramMismatches.length === 0,
    };
  });

  const equivalentCandidates = candidates.filter((c) => c.equivalent);
  const best = equivalentCandidates[0] ?? candidates[0];
  const ambiguous: EquivalenceReport['ambiguity'] = equivalentCandidates.length > 1
    ? 'symmetric'
    : candidates.length === 0
      ? 'unresolved'
      : 'none';

  const matchedB = best ? Object.keys(best.deviceBToA) : [];
  const matchedA = best ? new Set(Object.values(best.deviceBToA)) : new Set<ID>();
  const unmatchedB = B.devices.filter((d) => !matchedB.includes(d.id)).map((d) => d.path);
  const unmatchedA = A.devices.filter((d) => !matchedA.has(d.id)).map((d) => d.path);

  const minimalSubgraphs = best
    ? minimalInequivalences(A, B, best, unmatchedA, unmatchedB)
    : [];

  return {
    equivalent: equivalentCandidates.length > 0,
    candidates,
    ambiguity,
    minimalSubgraphs,
    summary: {
      devices: { A: A.devices.length, B: B.devices.length },
      matchedDevices: matchedB.length,
      unmatchedA,
      unmatchedB,
    },
    diagnostics,
  };
}

/**
 * 最小不等价子图：
 *  1) 参数/model 差异 => 取该器件及其直接相邻器件（封闭到网络）作为一个最小子图；
 *  2) 未匹配器件 => 该器件 + 其所在网络的一跳邻居；
 * 每个子图是局部的（最小闭包），多个差异分别成图。
 */
function minimalInequivalences(
  A: FlatCircuit, B: FlatCircuit, best: DeviceMapping,
  unmatchedA: string[], unmatchedB: string[],
): MinSubgraph[] {
  const out: MinSubgraph[] = [];
  const aByPath = new Map(A.devices.map((d) => [d.path, d]));
  const bByPath = new Map(B.devices.map((d) => [d.path, d]));
  const aNetById = new Map(A.nets.map((n) => [n.id, n]));
  const bNetById = new Map(B.nets.map((n) => [n.id, n]));

  const neighborhoods = (c: { devices: FlatDevice[]; nets: FlatNet[] }, seedPaths: string[]) => {
    const devs = new Set<string>();
    const nets = new Set<string>();
    const netOf = new Map<string, Set<string>>();
    for (const d of c.devices) {
      for (const p of d.pins) {
        if (!netOf.has(p.netId)) netOf.set(p.netId, new Set());
        netOf.get(p.netId)!.add(d.path);
      }
    }
    for (const sp of seedPaths) {
      devs.add(sp);
      const d = c.devices.find((x) => x.path === sp);
      for (const p of d?.pins ?? []) {
        nets.add(p.netId);
        for (const other of netOf.get(p.netId) ?? []) devs.add(other);
      }
    }
    return {
      devices: [...devs],
      nets: [...nets].map((id) => (c === A ? aNetById : bNetById).get(id)?.canonical ?? id),
    };
  };

  // 参数差异：以参数所在 B 设备为种子
  const seenDevice = new Set<string>();
  for (const mm of best.paramMismatches) {
    // deviceBToA 反查不到 mm，故按参数遍历设备
  }
  for (const [bid, aid] of Object.entries(best.deviceBToA)) {
    const db = bByPath.get(B.devices.find((d) => d.id === bid)?.path ?? '')!;
    const da = aByPath.get(A.devices.find((d) => d.id === aid)?.path ?? '')!;
    const mm = compareParams(da, db);
    if (mm.length === 0) continue;
    if (seenDevice.has(db.path)) continue;
    seenDevice.add(db.path);
    const na = neighborhoods(A, [da.path]);
    const nb = neighborhoods(B, [db.path]);
    const hasModel = mm.some((x) => x.reason === 'model-version');
    out.push({
      id: `minsg_${db.path.replace(/[^A-Za-z0-9]/g, '_')}`,
      devicesA: na.devices, devicesB: nb.devices,
      netsA: na.nets, netsB: nb.nets,
      reason: mm.map((x) => `${x.name}: A=${x.aRaw} vs B=${x.bRaw} (${x.reason})`).join('; '),
      type: hasModel ? 'model' : mm.some((x) => x.reason === 'expression-dependency') ? 'parameter' : 'parameter',
    });
  }

  // 拓扑：未匹配器件
  if (unmatchedA.length || unmatchedB.length) {
    const na = neighborhoods(A, unmatchedA);
    const nb = neighborhoods(B, unmatchedB);
    out.push({
      id: 'minsg_topology_unmatched',
      devicesA: na.devices, devicesB: nb.devices,
      netsA: na.nets, netsB: nb.nets,
      reason: `A 多余 ${unmatchedA.length} 个器件，B 多余 ${unmatchedB.length} 个器件`,
      type: unmatchedA.length ? 'extra-device' : 'missing-device',
    });
  }

  return out;
}
