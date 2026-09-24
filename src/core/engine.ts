import { createHash } from 'node:crypto';
import type {
  Diagnostic, DomainEvent, EquivResult, FlatNetlist, SourceFile,
} from './types';
import { makeSource } from './parser';
import { buildRegistry, flattenNetlist } from './flatten';
import { compareNetlists } from './equiv';
import { Store } from './store';

export interface ArtifactInfo {
  id: string;
  dependsOn: string[];
  hash: string;
}

export interface RecomputeEntry {
  artifact: string;
  action: 'kept' | 'recomputed';
  reason: string;
}

export interface ArchiveEntry {
  id: string;
  name: string;
  mutationKind: string;
  sourceId: string;
  beforeSha: string | null;
  afterSha: string;
  adopted: boolean;
  resultStatus: string;
  affectedArtifacts: string[];
  diagnostics: string[];
  eventId: string;
}

export interface Snapshot {
  sources: SourceFile[];
  tops: [string, string];
  artifacts: ArtifactInfo[];
  flatA: FlatNetlist | null;
  flatB: FlatNetlist | null;
  equiv: EquivResult | null;
  judgments: Record<string, unknown>[];
  anomalies: Diagnostic[];
  archive: ArchiveEntry[];
  decisions: DomainEvent[];
  branch: string;
  branches: string[];
}

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);

interface WorkState {
  sources: Map<string, SourceFile>;
  tops: [string, string];
  decisions: DomainEvent[];
  rejectedEventIds: Set<string>;
  mutations: { eventId: string; kind: string; sourceId: string; beforeSha: string | null; afterSha: string; name: string }[];
}

export class Engine {
  store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  activeBranch(): string {
    const row = this.store.db.prepare(`SELECT value FROM pointer WHERE name='branch'`).get() as { value: string } | undefined;
    return row?.value ?? 'main';
  }

  private setBranch(b: string) {
    this.store.db.prepare(
      `INSERT INTO pointer(name,value) VALUES('branch',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`
    ).run(b);
  }

  // 重放已采纳事件，重建工作状态（身份与顺序来自事件日志）
  private replay(): WorkState {
    const branch = this.activeBranch();
    const events = this.store.listEvents().filter(e =>
      e.branch === branch || e.kind === 'import.sources');
    const state: WorkState = {
      sources: new Map(), tops: ['', ''], decisions: [],
      rejectedEventIds: new Set(), mutations: [],
    };
    for (const e of events) {
      switch (e.kind) {
        case 'import.sources': {
          const p = e.payload as { sources: SourceFile[]; tops: [string, string] };
          for (const s of p.sources) state.sources.set(s.id, s);
          state.tops = p.tops;
          break;
        }
        case 'mutate.source': {
          const p = e.payload as {
            sourceId: string; newText: string; counterexample?: boolean;
            mutationKind?: string; name?: string; rejectedBy?: string;
          };
          const old = state.sources.get(p.sourceId);
          const ns = makeSource(p.sourceId, old?.path ?? p.sourceId, p.newText);
          state.sources.set(p.sourceId, ns);
          if (p.counterexample) {
            state.mutations.push({
              eventId: e.id, kind: p.mutationKind ?? 'unknown',
              sourceId: p.sourceId, beforeSha: old?.sha ?? null,
              afterSha: ns.sha, name: p.name ?? p.mutationKind ?? e.id,
            });
          }
          break;
        }
        case 'review.adjust-param': {
          const p = e.payload as { sourceId: string; stmtLine: number; param: string; newExpr: string };
          const src = state.sources.get(p.sourceId);
          if (src) {
            const lines = src.text.split('\n');
            const i = p.stmtLine - 1;
            if (lines[i] !== undefined) {
              const re = new RegExp(`(${p.param}\\s*=\\s*)(\\{[^}]*\\}|\\S+)`);
              lines[i] = lines[i].replace(re, `$1${p.newExpr}`);
              state.sources.set(p.sourceId, makeSource(src.id, src.path, lines.join('\n')));
            }
          }
          state.decisions.push(e);
          break;
        }
        case 'review.reject': {
          const p = e.payload as { targetEventId?: string };
          if (p.targetEventId) state.rejectedEventIds.add(p.targetEventId);
          state.decisions.push(e);
          break;
        }
        case 'review.accept':
        case 'branch.choose':
          state.decisions.push(e);
          break;
      }
    }
    return state;
  }

  // 依赖图传播：只重算受影响 artifact，其余保留并说明原因
  private compute(state: WorkState, prevArtifacts: ArtifactInfo[]): {
    snapshot: Omit<Snapshot, 'branch' | 'branches'>;
    artifacts: ArtifactInfo[];
    report: RecomputeEntry[];
  } {
    const prevMap = new Map(prevArtifacts.map(a => [a.id, a]));
    const report: RecomputeEntry[] = [];
    const artifacts: ArtifactInfo[] = [];
    const sources = [...state.sources.values()];

    const parseHashes = new Map<string, string>();
    for (const s of sources) {
      const id = `parse:${s.id}`;
      const h = hash(s.sha);
      parseHashes.set(s.id, h);
      const prev = prevMap.get(id);
      if (prev && prev.hash === h) {
        report.push({ artifact: id, action: 'kept', reason: `来源 ${s.path} 内容未变化（sha 前缀 ${h}）` });
      } else {
        report.push({ artifact: id, action: 'recomputed', reason: prev ? `来源 ${s.path} 内容变化` : `新来源 ${s.path}` });
      }
      artifacts.push({ id, dependsOn: [`src:${s.id}`], hash: h });
    }

    const registryHash = hash([...parseHashes.entries()].sort().map(([k, v]) => `${k}:${v}`).join('|'));
    const registryPrev = prevMap.get('registry');
    const registryChanged = !registryPrev || registryPrev.hash !== registryHash;
    report.push({
      artifact: 'registry',
      action: registryChanged ? 'recomputed' : 'kept',
      reason: registryChanged ? 'parse 集合哈希变化，重建子电路/model 注册表' : 'parse 集合未变化，注册表仍有效',
    });
    artifacts.push({ id: 'registry', dependsOn: [...parseHashes.keys()].map(k => `parse:${k}`), hash: registryHash });

    const { registry, parsed } = buildRegistry(sources, state.tops.filter(Boolean));

    const flats: (FlatNetlist | null)[] = [];
    const flatHashes: string[] = [];
    for (const top of state.tops) {
      if (!top) { flats.push(null); flatHashes.push(''); continue; }
      const id = `flat:${top}`;
      const flat = flattenNetlist(top, sources, registry, parsed);
      const h = hash(registryHash + JSON.stringify(flat.devices.map(d => [d.id, d.kind, d.pins, d.params.map(p => [p.name, p.raw])])));
      flatHashes.push(h);
      const prev = prevMap.get(id);
      report.push({
        artifact: id,
        action: prev && prev.hash === h ? 'kept' : 'recomputed',
        reason: prev && prev.hash === h ? '展平结果哈希一致，仍有效' : '注册表或来源变化，重新展平',
      });
      artifacts.push({ id, dependsOn: ['registry'], hash: h });
      flats.push(flat);
    }

    let equiv: EquivResult | null = null;
    if (flats[0] && flats[1]) {
      const id = 'equiv';
      const h = hash(flatHashes[0] + '|' + flatHashes[1]);
      const prev = prevMap.get(id);
      const kept = prev && prev.hash === h;
      equiv = compareNetlists(flats[0]!, flats[1]!);
      report.push({
        artifact: id, action: kept ? 'kept' : 'recomputed',
        reason: kept ? '两侧展平结果未变化，等价结论仍有效' : '展平结果变化，重新比较',
      });
      artifacts.push({ id, dependsOn: [`flat:${state.tops[0]}`, `flat:${state.tops[1]}`], hash: h });
    }

    // 机器可读取的判断事件（依据）
    const judgments: Record<string, unknown>[] = [];
    if (equiv) {
      for (const note of equiv.notes) {
        judgments.push({
          kind: `judge.${note.kind}`, basis: note.message, objects: note.objects,
          rule: note.kind === 'alpha-rename' ? 'nodes/instances alpha-renamable'
            : note.kind === 'scope-dependency' ? 'param scope/defaults/expression deps not flattenable'
            : note.kind === 'opaque-kept' ? 'unknown elements kept as opaque connections'
            : note.kind,
        });
      }
      if (equiv.status === 'ambiguous') {
        judgments.push({ kind: 'judge.ambiguous', basis: `存在 ${equiv.solutions.length} 个合法候选，全部保留`, candidates: equiv.solutions.length });
      }
      for (const d of equiv.minimalDiffs) {
        judgments.push({ kind: 'judge.minimal-diff', basis: d.reason, diff: d });
      }
    }

    const anomalies: Diagnostic[] = [
      ...(flats[0]?.diagnostics ?? []), ...(flats[1]?.diagnostics ?? []),
    ];

    // 反例档案：基线 + 每次单源变异的结果（采纳与未采纳都保留）
    const archive: ArchiveEntry[] = [];
    const importEvent = this.store.listEvents().find(e => e.kind === 'import.sources');
    if (importEvent) {
      archive.push({
        id: 'archive:baseline', name: '基线（原文本/续接/实例/表达式/model 版本/include 来源/单位后缀均不改写）',
        mutationKind: 'baseline', sourceId: '-', beforeSha: null, afterSha: '-',
        adopted: true, resultStatus: equiv?.status ?? 'unknown',
        affectedArtifacts: [], diagnostics: [], eventId: importEvent.id,
      });
    }
    for (const m of state.mutations) {
      archive.push({
        id: `archive:${m.eventId}`, name: m.name, mutationKind: m.kind,
        sourceId: m.sourceId, beforeSha: m.beforeSha, afterSha: m.afterSha,
        adopted: !state.rejectedEventIds.has(m.eventId),
        resultStatus: equiv?.status ?? 'unknown',
        affectedArtifacts: report.filter(r => r.action === 'recomputed').map(r => r.artifact),
        diagnostics: anomalies.filter(d => d.at.sourceId === m.sourceId).map(d => d.id),
        eventId: m.eventId,
      });
    }

    return {
      snapshot: {
        sources, tops: state.tops, artifacts,
        flatA: flats[0], flatB: flats[1], equiv, judgments,
        anomalies, archive, decisions: state.decisions,
      },
      artifacts, report,
    };
  }

  currentSnapshot(): { snapshot: Snapshot; versionId: string | null } {
    const vid = this.store.currentVersion();
    if (vid) {
      const v = this.store.getVersion(vid);
      if (v && v.status === 'complete') {
        return { snapshot: JSON.parse(v.snapshot) as Snapshot, versionId: vid };
      }
    }
    return { snapshot: this.emptySnapshot(), versionId: null };
  }

  snapshotAt(versionId: string): Snapshot | null {
    const v = this.store.getVersion(versionId);
    if (!v || v.status !== 'complete') return null;
    return JSON.parse(v.snapshot) as Snapshot;
  }

  private emptySnapshot(): Snapshot {
    return {
      sources: [], tops: ['', ''], artifacts: [], flatA: null, flatB: null,
      equiv: null, judgments: [], anomalies: [], archive: [], decisions: [],
      branch: this.activeBranch(), branches: this.branches(),
    };
  }

  branches(): string[] {
    const rows = this.store.db.prepare('SELECT DISTINCT branch FROM events ORDER BY branch').all() as { branch: string }[];
    return rows.map(r => r.branch);
  }

  apply(kind: string, payload: Record<string, unknown>, actor: string, branch?: string): {
    event: DomainEvent; conflictId: string | null; versionId: string; report: RecomputeEntry[];
  } {
    const targetBranch = branch ?? this.activeBranch();
    if (kind === 'branch.choose') {
      this.setBranch((payload as { chosenBranch: string }).chosenBranch);
    }
    // 调用方可携带自己看到的基线版本（乐观并发）；缺省取当前指针
    const baseVersion = (payload.__baseVersion as string | undefined) ?? this.store.currentVersion();
    const { event, conflictId } = this.store.appendEvent({
      branch: targetBranch, kind, actor, baseVersion, payload,
    });
    // 判断类事件不触发重算
    if (kind.startsWith('judge.')) {
      return { event, conflictId, versionId: baseVersion ?? '', report: [] };
    }
    // 并发冲突：事件保留为候选分支，不覆盖当前指针，等待裁定
    if (conflictId) {
      return { event, conflictId, versionId: baseVersion ?? '', report: [] };
    }
    const state = this.replay();
    const prev = this.store.currentVersion();
    const prevArtifacts = prev ? (JSON.parse(this.store.getVersion(prev)!.snapshot) as Snapshot).artifacts : [];
    const { snapshot, report } = this.compute(state, prevArtifacts);
    const full: Snapshot = { ...snapshot, branch: this.activeBranch(), branches: this.branches() };
    const version = this.store.commitVersion(event.id, full, report);
    // 判断依据落成机器可读取事件（不触发新版本）
    for (const j of full.judgments) {
      this.store.appendEvent({
        branch: this.activeBranch(), kind: String(j.kind ?? 'judge.note'),
        actor: 'engine', baseVersion: version.id,
        payload: { ...j, versionId: version.id },
      });
    }
    return { event, conflictId, versionId: version.id, report };
  }

  resolveConflict(conflictId: string, chosenEventId: string, actor: string) {
    // 采纳候选分支：切换活动分支并重放（未选候选保留在日志中）
    const chosen = this.store.listEvents().find(e => e.id === chosenEventId);
    if (chosen && chosen.branch !== this.activeBranch()) {
      this.setBranch(chosen.branch);
    }
    const { event } = this.apply('conflict.resolve', { conflictId, chosenEventId }, actor);
    this.store.resolveConflict(conflictId, event.id);
    return event;
  }
}
