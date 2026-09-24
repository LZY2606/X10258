/** 语义等价：结构同构（允许 alpha-rename 与对称端口置换）+ 参数值比较。
 *  多解不吞并：同一等价类内保留全部合法候选。 */
import type { FlatDevice, FlatNetlist } from './flatten.js';
import type { DomainEvent } from './events.js';
import { EV } from './events.js';

/** 每类器件的端口对称类：同类内端口可置换。 */
const PORT_CLASSES: Record<string, number[]> = {
  R: [0, 0], L: [0, 0], C: [0, 0],
  M: [0, 1, 0, 2],        // D/S 对称，G、B 独立
  D: [0, 1], V: [0, 1], I: [0, 1],
  E: [0, 1, 2, 3], G: [0, 1, 2, 3], J: [0, 1, 2], Q: [0, 1, 2],
};
const OPAQUE_CLASS = [0]; // 未知元件：全部端口视为同一对称类（保守）

function portClass(dev: FlatDevice, idx: number): number {
  const cls = dev.opaque ? OPAQUE_CLASS : PORT_CLASSES[dev.type];
  if (!cls) return idx;
  return cls[Math.min(idx, cls.length - 1)]!;
}

function normNum(v: number): string {
  return Math.abs(v) < 1e-30 ? '0' : v.toPrecision(12);
}

function paramSignature(dev: FlatDevice): string {
  const parts: string[] = [];
  if (dev.value) parts.push(`@=${dev.value.value !== null ? normNum(dev.value.value) : 'RAW:' + dev.value.raw}`);
  for (const k of Object.keys(dev.params).sort()) {
    const p = dev.params[k]!;
    parts.push(`${k}=${p.value !== null ? normNum(p.value) : 'RAW:' + p.raw}`);
  }
  return parts.join(';');
}

function deviceSeed(dev: FlatDevice): string {
  const model = dev.model ? `${dev.model.name}|${dev.model.modelType}|${dev.model.version ?? '-'}` : '-';
  return `${dev.type}|${dev.opaque ? 'opaque' : model}|${paramSignature(dev)}`;
}

export interface MappingEntry {
  a: string;
  b: string;
  candidatesA: string[];   // a 的全部合法对应（含 b）
  candidatesB: string[];
  basis: string;           // 判定依据（颜色签名）
}

export interface EquivResult {
  equivalent: boolean;
  deviceMapping: MappingEntry[];
  netMapping: MappingEntry[];
  paramDiffs: ParamDiff[];
  minimalDiffs: MinimalDiff[];
  events: DomainEvent[];
}

export interface ParamDiff {
  deviceA: string; deviceB: string; param: string;
  valueA: number | null; valueB: number | null;
  rawA: string; rawB: string;
  provenanceA: unknown; provenanceB: unknown;
}

export interface MinimalDiff {
  id: string;
  reason: string;
  devicesA: string[]; devicesB: string[];
  netsA: string[]; netsB: string[];
}

interface Side { idx: 0 | 1; flat: FlatNetlist; }

export function compareNetlists(flatA: FlatNetlist, flatB: FlatNetlist): EquivResult {
  const events: DomainEvent[] = [];
  const sides: Side[] = [{ idx: 0, flat: flatA }, { idx: 1, flat: flatB }];

  // —— WL 颜色精化（器件↔网 二部图）——
  const devColor = new Map<string, string>();
  const netColor = new Map<string, string>();
  for (const s of sides) {
    for (const d of s.flat.devices) devColor.set(key(s.idx, d.id), deviceSeed(d));
    for (const n of s.flat.nets) netColor.set(key(s.idx, n), `deg:${s.flat.devices.filter(d => d.nodes.includes(n)).length}`);
  }
  for (let iter = 0; iter < 64; iter++) {
    let changed = false;
    const newNet = new Map<string, string>();
    for (const s of sides) {
      for (const n of s.flat.nets) {
        const incident = s.flat.devices
          .flatMap(d => d.nodes.map((nn, pi) => ({ d, nn, pi })))
          .filter(x => x.nn === n)
          .map(x => `${devColor.get(key(s.idx, x.d.id))}#${portClass(x.d, x.pi)}`)
          .sort();
        const c = `N(${incident.join(',')})`;
        newNet.set(key(s.idx, n), c);
        if (c !== netColor.get(key(s.idx, n))) changed = true;
      }
    }
    const newDev = new Map<string, string>();
    for (const s of sides) {
      for (const d of s.flat.devices) {
        const byClass = new Map<number, string[]>();
        d.nodes.forEach((n, pi) => {
          const c = portClass(d, pi);
          const arr = byClass.get(c) ?? [];
          arr.push(newNet.get(key(s.idx, n))!);
          byClass.set(c, arr);
        });
        const sig = [...byClass.entries()].sort((x, y) => x[0] - y[0])
          .map(([c, arr]) => `${c}:{${arr.sort().join(',')}}`).join('|');
        const col = `${deviceSeed(d)}=>${sig}`;
        newDev.set(key(s.idx, d.id), col);
        if (col !== devColor.get(key(s.idx, d.id))) changed = true;
      }
    }
    devColor.clear(); newDev.forEach((v, k) => devColor.set(k, v));
    netColor.clear(); newNet.forEach((v, k) => netColor.set(k, v));
    if (!changed) break;
  }

  // —— 按颜色配对；类内多成员 => 保留全部候选 ——
  function pairUp(kind: 'dev' | 'net'): MappingEntry[] {
    const colorOf = kind === 'dev' ? devColor : netColor;
    const idsOf = (s: Side) => kind === 'dev' ? s.flat.devices.map(d => d.id) : s.flat.nets;
    const groupsA = groupBy(idsOf(sides[0]!), id => colorOf.get(key(0, id))!);
    const groupsB = groupBy(idsOf(sides[1]!), id => colorOf.get(key(1, id))!);
    const entries: MappingEntry[] = [];
    const allColors = new Set([...groupsA.keys(), ...groupsB.keys()]);
    for (const color of [...allColors].sort()) {
      const as = (groupsA.get(color) ?? []).sort();
      const bs = (groupsB.get(color) ?? []).sort();
      if (as.length !== bs.length) {
        events.push({
          kind: EV.TOPO_DIFF,
          summary: `拓扑差异: 颜色类成员数不一致 A=${as.length} B=${bs.length}`,
          detail: { kind, color: color.slice(0, 200), membersA: as, membersB: bs },
        });
      }
      const n = Math.max(as.length, bs.length);
      for (let i = 0; i < n; i++) {
        const a = as[Math.min(i, as.length - 1)];
        const b = bs[Math.min(i, bs.length - 1)];
        if (a === undefined || b === undefined) continue;
        entries.push({ a, b, candidatesA: as, candidatesB: bs, basis: color.slice(0, 300) });
        if (as.length > 1 || bs.length > 1) {
          events.push({
            kind: EV.MULTI_CANDIDATE,
            summary: `多解对应保留: ${kind} ${a} ↔ ${b}（候选 ${as.length}×${bs.length}）`,
            detail: { kind, a, candidatesA: as, candidatesB: bs },
          });
        }
      }
    }
    return entries;
  }

  const deviceMapping = pairUp('dev');
  const netMapping = pairUp('net');

  // —— alpha-rename 事件：结构对应但原名不同 ——
  const devByIdA = new Map(flatA.devices.map(d => [d.id, d] as const));
  const devByIdB = new Map(flatB.devices.map(d => [d.id, d] as const));
  for (const m of deviceMapping) {
    const da = devByIdA.get(m.a); const db = devByIdB.get(m.b);
    if (da && db && da.origName !== db.origName) {
      events.push({
        kind: EV.ALPHA_RENAME,
        summary: `alpha-rename: ${da.origName} ↔ ${db.origName}（结构对应，名称不约束）`,
        detail: { a: m.a, b: m.b, nameA: da.origName, nameB: db.origName, rule: 'names-are-alpha-renamable' },
      });
    }
    // 对称端口置换检测
    if (da && db && !da.opaque) {
      const cls = PORT_CLASSES[da.type];
      if (cls) {
        const netOfB = new Map(netMapping.map(x => [x.b, x.a] as const));
        const perm: number[] = [];
        let isPerm = false;
        for (let pi = 0; pi < da.nodes.length; pi++) {
          const target = netOfB.get(db.nodes[pi]!);
          const idx = da.nodes.findIndex((n, pj) => n === target && cls[pj] === cls[pi]);
          perm.push(idx);
          if (idx !== pi && idx >= 0) isPerm = true;
        }
        if (isPerm) {
          events.push({
            kind: EV.EQUIV_PERMUTATION,
            summary: `对称器件置换: ${da.origName} 端口经对称类置换后对应 ${db.origName}`,
            detail: { a: m.a, b: m.b, portClasses: cls, permutation: perm, rule: 'port-symmetry-classes' },
          });
        }
      }
    }
  }

  // —— 参数比较：值规范化后比较；作用域与表达式来源保留，不压平 ——
  const paramDiffs: ParamDiff[] = [];
  for (const m of deviceMapping) {
    const da = devByIdA.get(m.a); const db = devByIdB.get(m.b);
    if (!da || !db) continue;
    const keys = new Set([...Object.keys(da.params), ...Object.keys(db.params)]);
    if (da.value || db.value) keys.add('@value');
    for (const k of [...keys].sort()) {
      const pa = k === '@value' ? da.value : da.params[k];
      const pb = k === '@value' ? db.value : db.params[k];
      const name = k === '@value' ? '(value)' : k;
      if (!pa || !pb) {
        paramDiffs.push({
          deviceA: m.a, deviceB: m.b, param: name,
          valueA: pa?.value ?? null, valueB: pb?.value ?? null,
          rawA: pa?.raw ?? '(absent)', rawB: pb?.raw ?? '(absent)',
          provenanceA: pa?.provenance ?? null, provenanceB: pb?.provenance ?? null,
        });
        continue;
      }
      const bothNum = pa.value !== null && pb.value !== null;
      if (bothNum && Math.abs(pa.value! - pb.value!) <= 1e-12 * Math.max(1, Math.abs(pa.value!), Math.abs(pb.value!))) {
        if (pa.raw !== pb.raw) {
          events.push({
            kind: EV.EXPR_SAME_VALUE,
            summary: `表达式不同但值相同: ${name} ${pa.raw} ↔ ${pb.raw}（依赖与作用域保留，不压平）`,
            detail: { deviceA: m.a, deviceB: m.b, param: name, rawA: pa.raw, rawB: pb.raw, value: pa.value, rule: 'value-equal-expression-preserved' },
          });
        }
        continue;
      }
      paramDiffs.push({
        deviceA: m.a, deviceB: m.b, param: name,
        valueA: pa.value, valueB: pb.value, rawA: pa.raw, rawB: pb.raw,
        provenanceA: pa.provenance, provenanceB: pb.provenance,
      });
    }
  }
  for (const d of paramDiffs) {
    events.push({
      kind: EV.PARAM_DIFF,
      summary: `参数差异: ${d.deviceA} ↔ ${d.deviceB} 的 ${d.param}: ${d.rawA} ≠ ${d.rawB}`,
      detail: { ...d },
    });
  }

  // —— 最小不等价子图：围绕差异点的最小连通分量 ——
  const minimalDiffs = computeMinimalDiffs(flatA, flatB, deviceMapping, paramDiffs, events);

  const topoDiffs = events.filter(e => e.kind === EV.TOPO_DIFF).length;
  const equivalent = paramDiffs.length === 0 && topoDiffs === 0;
  return { equivalent, deviceMapping, netMapping, paramDiffs, minimalDiffs, events };
}

function computeMinimalDiffs(
  flatA: FlatNetlist, flatB: FlatNetlist,
  deviceMapping: MappingEntry[],
  paramDiffs: ParamDiff[],
  events: DomainEvent[],
): MinimalDiff[] {
  const diffs: MinimalDiff[] = [];
  // 每个参数差异 => 一个最小子图（器件 + 其直接网）
  paramDiffs.forEach((pd, i) => {
    const da = flatA.devices.find(d => d.id === pd.deviceA);
    const db = flatB.devices.find(d => d.id === pd.deviceB);
    diffs.push({
      id: `mindiff:param:${i}`,
      reason: `参数 ${pd.param} 不等: ${pd.rawA} ≠ ${pd.rawB}`,
      devicesA: [pd.deviceA], devicesB: [pd.deviceB],
      netsA: da?.nodes ?? [], netsB: db?.nodes ?? [],
    });
  });
  // 拓扑差异 => 以未配对颜色类成员为种子的邻域
  const topoEvents = events.filter(e => e.kind === EV.TOPO_DIFF);
  topoEvents.forEach((te, i) => {
    const membersA = (te.detail.membersA as string[]) ?? [];
    const membersB = (te.detail.membersB as string[]) ?? [];
    const seedDevsA = membersA.filter(m => m.startsWith('dev:'));
    const seedDevsB = membersB.filter(m => m.startsWith('dev:'));
    const netsOf = (flat: FlatNetlist, ids: string[]) =>
      [...new Set(flat.devices.filter(d => ids.includes(d.id)).flatMap(d => d.nodes))];
    diffs.push({
      id: `mindiff:topo:${i}`,
      reason: `拓扑差异: ${te.summary}`,
      devicesA: seedDevsA, devicesB: seedDevsB,
      netsA: [...netsOf(flatA, seedDevsA), ...membersA.filter(m => m.startsWith('net:'))],
      netsB: [...netsOf(flatB, seedDevsB), ...membersB.filter(m => m.startsWith('net:'))],
    });
  });
  diffs.forEach(d => {
    events.push({
      kind: EV.MIN_DIFF,
      summary: `最小不等价子图 ${d.id}: ${d.reason}`,
      detail: { ...d },
    });
  });
  return diffs;
}

function key(side: 0 | 1, id: string): string { return `${side}:${id}`; }

function groupBy<T>(items: T[], f: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = f(it);
    const arr = m.get(k) ?? [];
    arr.push(it);
    m.set(k, arr);
  }
  return m;
}
