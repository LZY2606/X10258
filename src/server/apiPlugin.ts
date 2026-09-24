import type { Plugin } from 'vite';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../core/store';
import { Engine } from '../core/engine';
import { runCase, loadCase } from '../core/casepack';

const DATA_DIR = join(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'app.db');
const CASE_DIR = join(process.cwd(), 'cases', 'netlist-double-chamber');

let engine: Engine | null = null;

function getEngine(fresh = false): Engine {
  if (fresh && engine) { engine.store.close(); engine = null; }
  if (!engine) {
    mkdirSync(DATA_DIR, { recursive: true });
    engine = new Engine(new Store(DB_PATH));
  }
  return engine;
}

function resetEngine(): Engine {
  if (engine) { engine.store.close(); engine = null; }
  for (const suffix of ['', '-wal', '-shm']) {
    const p = DB_PATH + suffix;
    if (existsSync(p)) rmSync(p);
  }
  return getEngine();
}

async function readBody(req: NodeJS.ReadableStream): Promise<string> {
  let data = '';
  for await (const chunk of req) data += chunk;
  return data;
}

export function apiPlugin(): Plugin {
  return {
    name: 'netlist-double-chamber-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        const url = new URL(req.url, 'http://localhost');
        const path = url.pathname;
        const send = (obj: unknown, code = 200) => {
          res.statusCode = code;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(obj));
        };
        try {
          const eng = getEngine();
          if (req.method === 'GET' && path === '/api/state') {
            const { snapshot, versionId } = eng.currentSnapshot();
            send({
              versionId, snapshot,
              conflicts: eng.store.listConflicts(),
              events: eng.store.listEvents(),
              versions: eng.store.listVersions().map(v => ({
                id: v.id, seq: v.seq, eventId: v.eventId, status: v.status, createdAt: v.createdAt,
              })),
            });
          } else if (req.method === 'GET' && path.startsWith('/api/versions/')) {
            const id = path.split('/').pop()!;
            const snap = eng.snapshotAt(id);
            if (!snap) return send({ error: 'version not found or incomplete' }, 404);
            send({ versionId: id, snapshot: snap });
          } else if (req.method === 'GET' && path === '/api/case') {
            send({ def: loadCase(CASE_DIR) });
          } else if (req.method === 'POST' && path === '/api/sample') {
            const eng2 = resetEngine();
            const trace = runCase(eng2, CASE_DIR);
            send({ trace, versionId: eng2.store.currentVersion() });
          } else if (req.method === 'POST' && path === '/api/reset') {
            resetEngine();
            send({ ok: true });
          } else if (req.method === 'POST' && path === '/api/apply') {
            const body = JSON.parse(await readBody(req));
            const { kind, payload, actor, branch } = body;
            const result = eng.apply(kind, payload ?? {}, actor ?? 'web-user', branch);
            send(result);
          } else if (req.method === 'GET' && path === '/api/export') {
            send({ export: eng.store.exportAll() });
          } else if (req.method === 'POST' && path === '/api/import') {
            const body = JSON.parse(await readBody(req));
            const eng2 = resetEngine();
            eng2.store.importAll(body.export);
            send({ ok: true, versionId: eng2.store.currentVersion() });
          } else if (req.method === 'POST' && path === '/api/resolve-conflict') {
            const body = JSON.parse(await readBody(req));
            const ev = eng.resolveConflict(body.conflictId, body.chosenEventId, body.actor ?? 'web-user');
            send({ event: ev });
          } else {
            send({ error: 'not found' }, 404);
          }
        } catch (err) {
          send({ error: String(err) }, 500);
        }
      });
    },
  };
}
