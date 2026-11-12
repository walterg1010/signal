import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { openStore } from "../lib/store.ts";

test("persists requests across a fresh Node process and treats SQL-like text as data", () => {
  const root = resolve(".test-data");
  mkdirSync(root, { recursive: true });
  const path = join(mkdtempSync(join(root, "store-")), "signal.db");
  const store = openStore(path);
  assert.deepEqual(store.list(), []);
  const first = store.create({ title: "Export reports", description: "Keep line breaks\n\nAnd customer context." });
  const second = store.create({ title: "Robert'); DROP TABLE feature_requests;--", description: "Text stays text." });
  assert.deepEqual(store.list().map(r => r.id), [second.id, first.id]);
  assert.throws(() => store.create({ title: " ", description: " " }));
  assert.equal(store.list().length, 2);
  store.close();

  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    "import { openStore } from './lib/store.ts'; const store = openStore(process.argv[1]); console.log(JSON.stringify(store.list())); store.close();", path],
    { encoding: "utf8", cwd: process.cwd() });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [second, first]);
});
