import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeSource } from './parser';
import type { Engine } from './engine';

export interface CaseStep {
  id: string;
  narration: string;
  action: 'import' | 'mutate' | 'adjust-param' | 'decide' | 'concurrent' | 'branch';
  actor?: string;
  kind?: string;
  sourceId?: string;
  variant?: string;
  counterexample?: string;
  name?: string;
  stmtLine?: number;
  param?: string;
  newExpr?: string;
  targetEventIdRef?: string;
  chosenBranch?: string;
  pair?: { actor: string; kind: string; payload: Record<string, unknown>; branch?: string }[];
}

export interface CaseDef {
  id: string;
  title: string;
  tops: [string, string];
  files: string[];
  steps: CaseStep[];
}

export interface StepTrace {
  stepId: string;
  narration: string;
  eventIds: string[];
  versionId: string;
  conflictId?: string | null;
  equivStatus?: string;
  recomputed: string[];
  kept: string[];
}

export function loadCase(dir: string): CaseDef {
  return JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')) as CaseDef;
}

// 执行案例：每一步都是真实引擎事件，可重放、可反查
export function runCase(engine: Engine, dir: string): StepTrace[] {
  const def = loadCase(dir);
  const traces: StepTrace[] = [];
  const eventByRef = new Map<string, string>();

  for (const step of def.steps) {
    const trace: StepTrace = {
      stepId: step.id, narration: step.narration, eventIds: [],
      versionId: '', recomputed: [], kept: [],
    };
    const finish = (r: { event: { id: string }; versionId: string; report: { artifact: string; action: string }[]; conflictId?: string | null }) => {
      trace.eventIds.push(r.event.id);
      trace.versionId = r.versionId || trace.versionId;
      trace.conflictId = r.conflictId;
      trace.recomputed = r.report.filter(x => x.action === 'recomputed').map(x => x.artifact);
      trace.kept = r.report.filter(x => x.action === 'kept').map(x => x.artifact);
      const snap = engine.currentSnapshot().snapshot;
      trace.equivStatus = snap.equiv?.status;
    };

    switch (step.action) {
      case 'import': {
        const sources = def.files.map(f => {
          const text = readFileSync(join(dir, 'fixtures', f), 'utf8');
          return makeSource(`src:${f.replace(/\W+/g, '_')}`, f, text);
        });
        finish(engine.apply('import.sources', { sources, tops: def.tops.map(t => `src:${t.replace(/\W+/g, '_')}`) }, step.actor ?? 'importer'));
        break;
      }
      case 'mutate': {
        const text = readFileSync(join(dir, 'fixtures', step.variant!), 'utf8');
        finish(engine.apply('mutate.source', {
          sourceId: step.sourceId, newText: text,
          counterexample: !!step.counterexample,
          mutationKind: step.counterexample, name: step.name,
        }, step.actor ?? 'reviewer'));
        break;
      }
      case 'adjust-param': {
        finish(engine.apply('review.adjust-param', {
          sourceId: step.sourceId, stmtLine: step.stmtLine,
          param: step.param, newExpr: step.newExpr,
        }, step.actor ?? 'reviewer'));
        break;
      }
      case 'decide': {
        const payload: Record<string, unknown> = { ...(step as unknown as Record<string, unknown>) };
        if (step.targetEventIdRef) payload.targetEventId = eventByRef.get(step.targetEventIdRef);
        finish(engine.apply(step.kind!, payload, step.actor ?? 'reviewer'));
        break;
      }
      case 'concurrent': {
        // 两位使用者从同一版本编辑 -> 必现可解决冲突
        const base = engine['store'].currentVersion();
        const [first, second] = step.pair!;
        const r1 = engine.apply(first.kind, { ...first.payload, __baseVersion: base }, first.actor, first.branch);
        trace.eventIds.push(r1.event.id);
        const r2 = engine.apply(second.kind, { ...second.payload, __baseVersion: base }, second.actor, second.branch ?? `branch:${second.actor}`);
        trace.eventIds.push(r2.event.id);
        trace.conflictId = r2.conflictId;
        if (r2.conflictId) {
          const resolved = engine.resolveConflict(r2.conflictId, r1.event.id, 'reviewer-lead');
          trace.eventIds.push(resolved.id);
        }
        trace.versionId = engine['store'].currentVersion() ?? '';
        const snap = engine.currentSnapshot().snapshot;
        trace.equivStatus = snap.equiv?.status;
        break;
      }
      case 'branch': {
        finish(engine.apply('branch.choose', { chosenBranch: step.chosenBranch }, step.actor ?? 'reviewer'));
        break;
      }
    }
    if (trace.eventIds.length > 0) eventByRef.set(step.id, trace.eventIds[trace.eventIds.length - 1]);
    traces.push(trace);
  }
  return traces;
}
