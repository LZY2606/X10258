import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 存储约定：
 * - objects：不可变内容对象（raw 文件、派生快照、报告），按内容 id 去重；
 * - events：追加日志（机器可读），每个事件属于一个 branch，seq 在 branch 内单调；
 * - branches：分支指针（指向某 branch 上最新事件 seq）；
 * - kv：当前指针/设置；version_pointers 保证“只有完整成功才切换当前指针”。
 */

export const SCHEMA_VERSION = 3;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS objects (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      content_json TEXT NOT NULL,
      content_sha TEXT NOT NULL,
      created_event_seq INTEGER NOT NULL,
      created_branch TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS branches (
      name TEXT PRIMARY KEY,
      head_seq INTEGER NOT NULL DEFAULT 0,
      base_event_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT NOT NULL,
      branch TEXT NOT NULL,
      seq INTEGER NOT NULL,
      parent_event_id TEXT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL,
      rule_version TEXT,
      adopted INTEGER NOT NULL DEFAULT 1,
      superseded_by TEXT,
      PRIMARY KEY (branch, seq)
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      decision_event_id TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      adopted INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS version_pointers (
      name TEXT PRIMARY KEY,
      current_event_id TEXT,
      pending_event_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_id ON events(id);
    CREATE INDEX IF NOT EXISTS idx_events_parent ON events(parent_event_id);
    CREATE INDEX IF NOT EXISTS idx_candidates_decision ON candidates(decision_event_id);
  `);
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
  const current = row ? Number(row.value) : 0;
  if (current < SCHEMA_VERSION) {
    applyMigrations(db, current);
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
  }
}

/**
 * 旧版本迁移：保留历史数据、可重复执行。
 * v1 -> v2：events 增加 adopted/superseded_by；
 * v2 -> v3：candidates 表 + version_pointers 表。
 */
function applyMigrations(db: DatabaseSync, from: number) {
  if (from < 2) {
    const cols = db.prepare("PRAGMA table_info(events)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "adopted")) {
      db.exec("ALTER TABLE events ADD COLUMN adopted INTEGER NOT NULL DEFAULT 1;");
    }
    if (!cols.some((c) => c.name === "superseded_by")) {
      db.exec("ALTER TABLE events ADD COLUMN superseded_by TEXT;");
    }
  }
  if (from < 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY,
        decision_event_id TEXT NOT NULL,
        candidate_json TEXT NOT NULL,
        adopted INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS version_pointers (
        name TEXT PRIMARY KEY,
        current_event_id TEXT,
        pending_event_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_decision ON candidates(decision_event_id);
    `);
  }
}
