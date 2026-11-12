import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateRequest, type FeatureRequest } from "./requests.ts";

export function openStore(filename: string) {
  if (filename !== ":memory:") mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS feature_requests (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
      description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 1 AND 4000),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS feature_requests_created_at
      ON feature_requests(created_at DESC);
    CREATE TABLE IF NOT EXISTS request_support (
      request_id TEXT NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
      supporter_id TEXT NOT NULL CHECK(length(supporter_id) > 0),
      created_at TEXT NOT NULL,
      PRIMARY KEY (request_id, supporter_id)
    ) STRICT;
  `);
  const insert = db.prepare(`
    INSERT INTO feature_requests (id, title, description, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const columns = `
    SELECT r.id, r.title, r.description, r.created_at AS createdAt,
      (SELECT COUNT(*) FROM request_support s WHERE s.request_id = r.id) AS supportCount,
      EXISTS(SELECT 1 FROM request_support s
        WHERE s.request_id = r.id AND s.supporter_id = ?) AS supportedByViewer
    FROM feature_requests r
  `;
  const select = db.prepare(`${columns} ORDER BY r.created_at DESC, r.rowid DESC`);
  const selectOne = db.prepare(`${columns} WHERE r.id = ?`);
  const addSupport = db.prepare(`
    INSERT INTO request_support (request_id, supporter_id, created_at) VALUES (?, ?, ?)
    ON CONFLICT(request_id, supporter_id) DO NOTHING
  `);
  const removeSupport = db.prepare("DELETE FROM request_support WHERE request_id = ? AND supporter_id = ?");

  type StoredRow = Omit<FeatureRequest, "supportedByViewer"> & { supportedByViewer: number };
  const present = (row: StoredRow): FeatureRequest => ({ ...row, supportedByViewer: Boolean(row.supportedByViewer) });
  function find(id: string, supporterId: string | null): FeatureRequest | null {
    const row = selectOne.get(supporterId ?? "", id) as StoredRow | undefined;
    return row ? present(row) : null;
  }

  return {
    list(supporterId: string | null = null): FeatureRequest[] {
      return (select.all(supporterId ?? "") as StoredRow[]).map(present);
    },
    create(input: unknown): FeatureRequest {
      const { title, description } = validateRequest(input);
      const request = {
        id: randomUUID(), title, description, createdAt: new Date().toISOString(),
        supportCount: 0, supportedByViewer: false,
      };
      // Bound parameters keep request text separate from SQL instructions.
      insert.run(request.id, request.title, request.description, request.createdAt);
      return request;
    },
    setSupport(id: string, supporterId: string, supported: boolean): FeatureRequest | null {
      // The unique key enforces one support per identity, including concurrent
      // requests. Explicit add/remove operations are safe to retry.
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!find(id, supporterId)) {
          db.exec("COMMIT");
          return null;
        }
        if (supported) addSupport.run(id, supporterId, new Date().toISOString());
        else removeSupport.run(id, supporterId);
        const request = find(id, supporterId);
        db.exec("COMMIT");
        return request;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close() { db.close(); },
  };
}

type Store = ReturnType<typeof openStore>;
const STORE_VERSION = 2;
const localState = globalThis as typeof globalThis & {
  signalStore?: { path: string; store: Store; version: number };
};

export function getStore(): Store {
  // The database is created at runtime; never bundle local data into a build.
  const path = resolve(/* turbopackIgnore: true */ process.env.SIGNAL_DB_PATH || "data/signal.db");
  // Reopen on code/schema upgrades as well as path changes: development hot
  // reload can otherwise retain a connection with the previous store methods.
  if (localState.signalStore?.path !== path || localState.signalStore.version !== STORE_VERSION) {
    localState.signalStore?.store.close();
    localState.signalStore = { path, store: openStore(path), version: STORE_VERSION };
  }
  return localState.signalStore.store;
}

export function closeStore() {
  localState.signalStore?.store.close();
  delete localState.signalStore;
}
