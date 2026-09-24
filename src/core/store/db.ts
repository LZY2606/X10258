import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 2;

const MIGRATIONS: Record<number, string[]> = {
  // 0 -> 1：初始结构
  1: [
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS versions (
       id TEXT PRIMARY KEY, parent_id TEXT, seq INTEGER NOT NULL, committed_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS events (
       id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, kind TEXT NOT NULL,
       actor TEXT NOT NULL, base_version TEXT, version_id TEXT NOT NULL,
       payload TEXT NOT NULL, ts TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS pointers (name TEXT PRIMARY KEY, version_id TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS derived (
       id TEXT PRIMARY KEY, name TEXT NOT NULL, version_id TEXT NOT NULL,
       inputs TEXT NOT NULL, payload TEXT NOT NULL, reason TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS conflicts (
       id TEXT PRIMARY KEY, base_version TEXT NOT NULL, candidates TEXT NOT NULL,
       resolved INTEGER NOT NULL DEFAULT 0, resolution TEXT)`,
    `CREATE TABLE IF NOT EXISTS files (
       case_id TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL,
       content TEXT NOT NULL, PRIMARY KEY (case_id, path))`
  ],
  // 1 -> 2：derived 增加状态列（旧版本迁移路径）
  2: [
    `ALTER TABLE derived ADD COLUMN status TEXT NOT NULL DEFAULT 'valid'`
  ]
};

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  const has = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`).get();
  let version = 0;
  if (has) {
    const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string } | undefined;
    version = row ? Number(row.value) : 0;
  }
  for (let v = version + 1; v <= SCHEMA_VERSION; v++) {
    const steps = MIGRATIONS[v];
    if (!steps) continue;
    db.exec('BEGIN');
    try {
      for (const sql of steps) db.exec(sql);
      db.prepare(`INSERT INTO meta(key,value) VALUES('schema_version',?)
                  ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(v));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
