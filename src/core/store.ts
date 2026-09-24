import { DatabaseSync } from 'node:sqlite';
import type { DomainEvent, VersionRow } from './types';

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
    CREATE TABLE IF NOT EXISTS events(
      id TEXT PRIMARY KEY,
      seq INTEGER UNIQUE NOT NULL,
      branch TEXT NOT NULL,
      kind TEXT NOT NULL,
      actor TEXT NOT NULL,
      base_version TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS versions(
      id TEXT PRIMARY KEY,
      seq INTEGER UNIQUE NOT NULL,
      event_id TEXT,
      status TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      report TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pointer(name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conflicts(
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      expected_base TEXT,
      actual_base TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      resolution_event_id TEXT,
      created_at TEXT NOT NULL
    );`,
  },
  {
    version: 2,
    sql: `ALTER TABLE events ADD COLUMN adopted INTEGER NOT NULL DEFAULT 1;`,
  },
];

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.migrate();
    this.recover();
  }

  private migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const rows = this.db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
    const applied = new Set(rows.map(r => r.version));
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(m.sql);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?,?)')
          .run(m.version, new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  // 写入中断恢复：building 版本一律作废，指针只可能指向完整版本
  private recover() {
    this.db.exec(`UPDATE versions SET status='aborted' WHERE status='building'`);
  }

  currentVersion(): string | null {
    const row = this.db.prepare(`SELECT value FROM pointer WHERE name='current'`).get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  nextSeq(table: 'events' | 'versions'): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq),0)+1 AS s FROM ${table}`).get() as { s: number };
    return row.s;
  }

  // 追加事件：base_version 与当前指针不一致 -> 记录冲突，事件进入新分支（双方都保留）
  appendEvent(e: Omit<DomainEvent, 'id' | 'seq' | 'createdAt'>): { event: DomainEvent; conflictId: string | null } {
    const seq = this.nextSeq('events');
    const id = `evt:${String(seq).padStart(6, '0')}`;
    const createdAt = new Date().toISOString();
    const current = this.currentVersion();
    let conflictId: string | null = null;
    this.db.exec('BEGIN');
    try {
      this.db.prepare(
        'INSERT INTO events(id,seq,branch,kind,actor,base_version,payload,created_at) VALUES(?,?,?,?,?,?,?,?)'
      ).run(id, seq, e.branch, e.kind, e.actor, e.baseVersion, JSON.stringify(e.payload), createdAt);
      if (e.baseVersion !== null && current !== null && e.baseVersion !== current) {
        conflictId = `conf:${id}`;
        this.db.prepare(
          'INSERT INTO conflicts(id,event_id,expected_base,actual_base,status,created_at) VALUES(?,?,?,?,?,?)'
        ).run(conflictId, id, e.baseVersion, current, 'open', createdAt);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { event: { ...e, id, seq, createdAt }, conflictId };
  }

  // 版本提交：先完整写入 building 版本，再原子切换指针
  commitVersion(eventId: string | null, snapshot: unknown, report: unknown): VersionRow {
    const seq = this.nextSeq('versions');
    const id = `ver:${String(seq).padStart(6, '0')}`;
    const createdAt = new Date().toISOString();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(
        'INSERT INTO versions(id,seq,event_id,status,snapshot,report,created_at) VALUES(?,?,?,?,?,?,?)'
      ).run(id, seq, eventId, 'building', JSON.stringify(snapshot), JSON.stringify(report), createdAt);
      this.db.prepare(`UPDATE versions SET status='complete' WHERE id=?`).run(id);
      this.db.prepare(
        `INSERT INTO pointer(name,value) VALUES('current',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`
      ).run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getVersion(id)!;
  }

  getVersion(id: string): VersionRow | null {
    const r = this.db.prepare('SELECT * FROM versions WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string, seq: r.seq as number, eventId: r.event_id as string | null,
      status: r.status as VersionRow['status'], snapshot: r.snapshot as string,
      report: r.report as string, createdAt: r.created_at as string,
    };
  }

  listVersions(): VersionRow[] {
    const rows = this.db.prepare('SELECT * FROM versions ORDER BY seq').all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string, seq: r.seq as number, eventId: r.event_id as string | null,
      status: r.status as VersionRow['status'], snapshot: r.snapshot as string,
      report: r.report as string, createdAt: r.created_at as string,
    }));
  }

  listEvents(branch?: string): DomainEvent[] {
    const rows = (branch
      ? this.db.prepare('SELECT * FROM events WHERE branch=? ORDER BY seq').all(branch)
      : this.db.prepare('SELECT * FROM events ORDER BY seq').all()) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string, seq: r.seq as number, branch: r.branch as string,
      kind: r.kind as string, actor: r.actor as string,
      baseVersion: r.base_version as string | null,
      payload: JSON.parse(r.payload as string),
      createdAt: r.created_at as string,
    }));
  }

  listConflicts(): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM conflicts ORDER BY created_at').all() as Record<string, unknown>[];
  }

  resolveConflict(conflictId: string, resolutionEventId: string) {
    this.db.prepare(`UPDATE conflicts SET status='resolved', resolution_event_id=? WHERE id=?`)
      .run(resolutionEventId, conflictId);
  }

  exportAll(): string {
    return JSON.stringify({
      format: 'netlist-double-chamber/v1',
      events: this.listEvents(),
      versions: this.listVersions().filter(v => v.status === 'complete'),
      current: this.currentVersion(),
    }, null, 2);
  }

  // 导入：身份、顺序、来源关系原样恢复
  importAll(json: string) {
    const data = JSON.parse(json);
    if (data.format !== 'netlist-double-chamber/v1') throw new Error('unknown export format');
    this.db.exec('BEGIN');
    try {
      for (const e of data.events as DomainEvent[]) {
        this.db.prepare(
          'INSERT OR REPLACE INTO events(id,seq,branch,kind,actor,base_version,payload,created_at) VALUES(?,?,?,?,?,?,?,?)'
        ).run(e.id, e.seq, e.branch, e.kind, e.actor, e.baseVersion, JSON.stringify(e.payload), e.createdAt);
      }
      for (const v of data.versions as VersionRow[]) {
        this.db.prepare(
          'INSERT OR REPLACE INTO versions(id,seq,event_id,status,snapshot,report,created_at) VALUES(?,?,?,?,?,?,?)'
        ).run(v.id, v.seq, v.eventId, v.status, v.snapshot, v.report, v.createdAt);
      }
      if (data.current) {
        this.db.prepare(
          `INSERT INTO pointer(name,value) VALUES('current',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`
        ).run(data.current);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close() { this.db.close(); }
}
