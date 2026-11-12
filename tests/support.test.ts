import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../lib/store.ts";

const execute = promisify(execFile);

function databasePath() {
  const root = resolve(".test-data");
  mkdirSync(root, { recursive: true });
  return join(mkdtempSync(join(root, "support-")), "signal.db");
}

test("support is unique per identity, removable, and durable across connections", () => {
  const path = databasePath();
  const store = openStore(path);
  const item = store.create({ title: "Saved filters", description: "Keep frequently used filters." });
  const alice = randomUUID();
  const bob = randomUUID();

  assert.equal(store.setSupport(item.id, alice, true)?.supportCount, 1);
  assert.equal(store.setSupport(item.id, alice, true)?.supportCount, 1);
  assert.equal(store.setSupport(item.id, bob, true)?.supportCount, 2);
  assert.equal(store.list(alice)[0].supportedByViewer, true);
  assert.equal(store.list(randomUUID())[0].supportedByViewer, false);
  store.close();

  const reopened = openStore(path);
  assert.equal(reopened.list(alice)[0].supportCount, 2);
  assert.equal(reopened.list(alice)[0].supportedByViewer, true);
  assert.equal(reopened.setSupport(item.id, alice, false)?.supportCount, 1);
  assert.equal(reopened.setSupport(item.id, alice, false)?.supportCount, 1);
  assert.equal(reopened.list(alice)[0].supportedByViewer, false);
  assert.equal(reopened.list(bob)[0].supportedByViewer, true);
  assert.equal(reopened.setSupport(randomUUID(), alice, true), null);
  assert.equal(reopened.list()[0].supportCount, 1);
  reopened.close();
});

test("simultaneous processes cannot add duplicate support for the same identity", async () => {
  const path = databasePath();
  const store = openStore(path);
  const item = store.create({ title: "Weekly report", description: "Email the report." });
  const viewer = randomUUID();
  store.close();

  const code = "import {openStore} from './lib/store.ts'; const s=openStore(process.argv[1]); s.setSupport(process.argv[2],process.argv[3],true); s.close();";
  await Promise.all(Array.from({ length: 4 }, () => execute(process.execPath,
    ["--input-type=module", "-e", code, path, item.id, viewer], { cwd: process.cwd() })));
  const reopened = openStore(path);
  assert.equal(reopened.list(viewer)[0].supportCount, 1);
  assert.equal(reopened.list(viewer)[0].supportedByViewer, true);
  reopened.close();
});

test("adding the support table preserves requests in a database from the first milestone", () => {
  const path = databasePath();
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE feature_requests (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL
  ) STRICT;`);
  const id = randomUUID();
  old.prepare("INSERT INTO feature_requests VALUES (?, ?, ?, ?)")
    .run(id, "Existing request", "Keep this data.", "2026-11-11T12:00:00Z");
  old.close();

  const migrated = openStore(path);
  assert.equal(migrated.list()[0].title, "Existing request");
  assert.equal(migrated.list()[0].supportCount, 0);
  assert.equal(migrated.setSupport(id, randomUUID(), true)?.supportCount, 1);
  migrated.close();
});
