import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { afterEach, test } from "node:test";
import { getStore, closeStore } from "../lib/store.ts";
import { getIntelligenceStore, closeIntelligenceStore } from "../lib/intelligence-store.ts";
import { runAnalysis, AnalysisServiceError } from "../lib/analysis-service.ts";
import type { AnalysisResult } from "../lib/analysis-types.ts";

function setup() {
  const root = resolve(".test-data");
  mkdirSync(root, { recursive: true });
  process.env.SIGNAL_DB_PATH = join(mkdtempSync(join(root, "analysis-service-")), "signal.db");
  const store = getStore();
  const source = store.create({ title: "Weekly dashboard email", description: "Every Monday I copy the same dashboard into an email." });
  return { store, source };
}
afterEach(() => { closeIntelligenceStore(); closeStore(); });
const config = () => ({ available: true, model: "controlled-test-fixture" });
const result = (): AnalysisResult => ({
  problem: "Reduce manual reporting work.", problemEvidence: "Every Monday I copy the same dashboard into an email.",
  theme: "Reporting", unknowns: ["Who receives the report?"], suggestions: [],
});

test("a missing provider key does not lose the saved request or invent analysis", async () => {
  const { store, source } = setup();
  let called = false;
  await assert.rejects(runAnalysis(source.id, false, {
    config: () => ({ available: false, model: "unconfigured" }),
    analyze: async () => { called = true; return result(); },
  }), (error: unknown) => error instanceof AnalysisServiceError && error.status === 503);
  assert.equal(called, false);
  assert.equal(store.list().length, 1);
  assert.equal(getIntelligenceStore().get(source.id).analysis, null);
});

test("concurrent analysis calls share a durable run, then reuse the completed result", async () => {
  const { source } = setup();
  let release!: (value: AnalysisResult) => void;
  let calls = 0;
  const waiting = new Promise<AnalysisResult>(resolve => { release = resolve; });
  const analyze = async () => { calls++; return waiting; };
  const first = runAnalysis(source.id, false, { config, analyze });
  const second = await runAnalysis(source.id, false, { config, analyze });
  assert.equal(second.status, 202);
  assert.equal(second.intelligence.analysis?.status, "running");
  release(result());
  const completed = await first;
  assert.equal(completed.status, 200);
  assert.equal(completed.intelligence.analysis?.status, "completed");
  assert.equal(calls, 1);
  await runAnalysis(source.id, false, { config, analyze });
  assert.equal(calls, 1);
  await runAnalysis(source.id, true, { config, analyze });
  assert.equal(calls, 2);
});

test("provider failures are sanitized, recorded, and recover through an explicit retry", async () => {
  const { source, store } = setup();
  await assert.rejects(runAnalysis(source.id, false, { config, analyze: async () => {
    throw new Error("Do not expose private provider internals");
  } }), AnalysisServiceError);
  const failed = getIntelligenceStore().get(source.id).analysis;
  assert.equal(failed?.status, "failed");
  assert.ok(!failed?.error?.includes("private provider internals"));
  assert.equal(store.list()[0].title, source.title);
  assert.equal((await runAnalysis(source.id, false, { config, analyze: async () => result() })).intelligence.analysis?.status, "completed");
});

test("only bounded candidate text is sent and invalid evidence is never saved as completed", async () => {
  const { source, store } = setup();
  for (let i = 0; i < 23; i++) store.create({ title: `Candidate ${i}`, description: "x".repeat(2000) });
  await assert.rejects(runAnalysis(source.id, false, { config, analyze: async (sentSource, candidates) => {
    assert.equal(sentSource.id, source.id);
    assert.deepEqual(Object.keys(sentSource).sort(), ["description", "id", "title"]);
    assert.equal(candidates.length, 20);
    assert.ok(candidates.every(item => item.description.length === 1500 && item.id !== source.id));
    return { ...result(), problemEvidence: "Invented evidence" };
  } }), AnalysisServiceError);
  const analysis = getIntelligenceStore().get(source.id).analysis;
  assert.equal(analysis?.status, "failed");
  assert.equal(analysis?.result, null);
  assert.equal(analysis?.candidateCount, 20);
});
