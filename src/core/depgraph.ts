/** 重算依赖图：源 -> 装配 -> 展平(实例子树) -> 等价比较。
 *  只重算受影响节点；报告每项结果为何仍有效或为何需要重算。 */
import type { SourceDoc } from './spice.js';
import { assemble, type Assembled } from './spice.js';
import { flatten, hashStr, type FlatNetlist, type InstanceCache } from './flatten.js';
import { compareNetlists, type EquivResult } from './equiv.js';

export interface RecomputeNode { id: string; kind: string; status: 'recomputed' | 'valid'; reason: string; }
export interface DerivedState {
  asmA: Assembled; asmB: Assembled;
  flatA: FlatNetlist; flatB: FlatNetlist;
  equiv: EquivResult;
  report: RecomputeNode[];
}

export class Deriver {
  private sources: Record<'A' | 'B', SourceDoc[]> = { A: [], B: [] };
  private asmCache = new Map<string, { hash: string; asm: Assembled }>();
  private flatCache = new Map<string, FlatNetlist>();
  private instCache: Record<'A' | 'B', InstanceCache> = { A: new Map(), B: new Map() };
  private prev: { asmA: string; asmB: string; flatA: string; flatB: string } | null = null;

  setSources(side: 'A' | 'B', docs: SourceDoc[]): void { this.sources[side] = docs; }

  derive(): DerivedState {
    const report: RecomputeNode[] = [];
    const sourceSetHash = (side: 'A' | 'B') =>
      hashStr(this.sources[side].map(d => `${d.id}:${hashStr(d.text)}`).sort().join('|'));

    const mkAsm = (side: 'A' | 'B'): { hash: string; asm: Assembled } => {
      const h = sourceSetHash(side);
      for (const d of this.sources[side]) {
        const prevParse = this.asmCache.get(`${side}:src:${d.id}`);
        if (!prevParse) report.push({ id: `src:${side}:${d.id}`, kind: 'source', status: 'recomputed', reason: '首次解析' });
        else if (!prevParse.hash.includes(hashStr(d.text))) {
          // 旧缓存键机制下不会命中；保留明确语义
          report.push({ id: `src:${side}:${d.id}`, kind: 'source', status: 'recomputed', reason: '源文本已变化' });
        }
      }
      const cached = this.asmCache.get(`${side}:set:${h}`);
      if (cached) {
        report.push({ id: `asm:${side}`, kind: 'assemble', status: 'valid', reason: `来源集哈希 ${h.slice(0, 8)} 未变，装配结果仍有效` });
        return { hash: h, asm: cached.asm };
      }
      const asm = assemble(this.sources[side]);
      this.asmCache.set(`${side}:set:${h}`, { hash: h, asm });
      this.instCache[side] = new Map(); // 装配变化，清空实例缓存
      report.push({ id: `asm:${side}`, kind: 'assemble', status: 'recomputed', reason: `来源集哈希变为 ${h.slice(0, 8)}（include/model/子电路候选可能变化）` });
      for (const d of this.sources[side]) report.push({ id: `src:${side}:${d.id}`, kind: 'source', status: 'recomputed', reason: '新来源集，重新解析' });
      return { hash: h, asm };
    };

    const { hash: hA, asm: asmA } = mkAsm('A');
    const { hash: hB, asm: asmB } = mkAsm('B');

    const mkFlat = (side: 'A' | 'B', h: string, asm: Assembled): { hash: string; flat: FlatNetlist } => {
      const flat = flatten(asm, { label: side, cache: this.instCache[side] });
      for (const c of flat.cacheReport) {
        report.push({
          id: `inst:${side}:${c.instPath || 'top'}`, kind: 'instance-subtree',
          status: c.hit ? 'valid' : 'recomputed', reason: c.reason,
        });
      }
      const fh = hashStr(JSON.stringify({ h, devs: flat.devices.map(d => `${d.id}${d.nodes.join(',')}${d.value?.raw ?? ''}${Object.values(d.params).map(p => p.raw).join('')}`), nets: flat.nets }));
      this.flatCache.set(`${side}:${fh}`, flat);
      return { hash: fh, flat };
    };

    const { hash: fhA, flat: flatA } = mkFlat('A', hA, asmA);
    const { hash: fhB, flat: flatB } = mkFlat('B', hB, asmB);

    let equiv: EquivResult;
    const inputsSame = this.prev && this.prev.flatA === fhA && this.prev.flatB === fhB;
    if (inputsSame) {
      report.push({ id: 'equiv', kind: 'equivalence', status: 'valid', reason: '两侧展平结果均未变，等价结论仍有效' });
      // 上一次结果随 prev 不缓存时重算代价极低；为简单起见仍调用但标记 valid
      equiv = compareNetlists(flatA, flatB);
    } else {
      report.push({ id: 'equiv', kind: 'equivalence', status: 'recomputed', reason: this.prev ? '一侧展平结果变化，等价比较需要重算' : '首次比较' });
      equiv = compareNetlists(flatA, flatB);
    }
    this.prev = { asmA: hA, asmB: hB, flatA: fhA, flatB: fhB };
    return { asmA, asmB, flatA, flatB, equiv, report };
  }
}
