import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../lib/store.ts";
import { openIntelligenceStore, StaleReviewError } from "../lib/intelligence-store.ts";
import type { AnalysisResult } from "../lib/analysis-types.ts";

const settings = { model: "test-model", promptVersion: "test-v1", candidateCount: 2 };

function fixture() {
  const root = resolve(".test-data");
  mkdirSync(root, { recursive: true });
  const path = join(mkdtempSync(join(root, "intelligence-")), "signal.db");
  const base = openStore(path);
  const requests = [
    base.create({ title: "Weekly reports", description: "Email my dashboard every Monday." }),
    base.create({ title: "Scheduled dashboard emails", description: "Send the dashboard to our team weekly." }),
    base.create({ title: "Saved filters", description: "Remember my customer filters." }),
  ];
  base.setSupport(requests[0].id, "test-supporter", true);
  base.close();
  let time = Date.parse("2026-11-11T22:00:00Z");
  const clock = { now: () => time };
  return {
    path, requests, clock,
    advance: (amount: number) => { time += amount; },
    store: openIntelligenceStore(path, clock),
  };
}

function result(relatedRequestId?: string): AnalysisResult {
  return {
    problem: "The team needs a recurring dashboard update without copying it manually.",
    problemEvidence: "Email my dashboard every Monday.",
    theme: "Scheduled reporting",
    unknowns: ["Which recipients should receive the report?"],
    suggestions: relatedRequestId ? [{
      requestId: relatedRequestId,
      relationship: "related",
      reason: "Both describe sending dashboard information on a schedule.",
      sourceEvidence: "Email my dashboard every Monday.",
      targetEvidence: "Send the dashboard to our team weekly.",
    }] : [],
  };
}

test("claims deduplicate across connections, enforce concurrency, cache results, and retain old runs", () => {
  const { store, path, requests, clock } = fixture();
  const other = openIntelligenceStore(path, clock);
  try {
    const first = store.begin(requests[0].id, settings);
    assert.equal(first.kind, "started");
    assert.equal(first.analysis?.status, "running");
    const duplicate = other.begin(requests[0].id, { ...settings, force: true });
    assert.equal(duplicate.kind, "running");
    assert.equal(duplicate.analysis?.id, first.analysis!.id);
    assert.equal(other.begin(requests[1].id, settings).kind, "started");
    assert.equal(store.begin(requests[2].id, settings).kind, "busy");
    assert.equal(store.finish(first.analysis!.id, result(), 23), true);
    const cached = other.begin(requests[0].id, settings);
    assert.equal(cached.kind, "cached");
    assert.equal(cached.analysis?.id, first.analysis!.id);
    assert.deepEqual(cached.analysis?.result, result());
    const rerun = store.begin(requests[0].id, { ...settings, force: true });
    assert.equal(rerun.kind, "started");
    assert.notEqual(rerun.analysis?.id, first.analysis!.id);

    const inspect = new DatabaseSync(path);
    assert.equal((inspect.prepare("SELECT COUNT(*) AS total FROM analysis_runs").get() as { total: number }).total, 3);
    inspect.close();
    const base = openStore(path);
    assert.equal(base.list().length, 3);
    assert.equal(base.list().find(item => item.id === requests[0].id)?.supportCount, 1);
    base.close();
  } finally {
    store.close();
    other.close();
  }
});

test("expired leases become failures and late responses cannot overwrite a fresh attempt", () => {
  const { store, requests, advance } = fixture();
  try {
    const first = store.begin(requests[0].id, settings).analysis!;
    advance(75_001);
    const expired = store.overview()[requests[0].id].analysis!;
    assert.equal(expired.status, "failed");
    assert.match(expired.error!, /interrupted/);
    assert.equal(expired.durationMs, 75_001);
    assert.equal(store.finish(first.id, result(), 75_001), false);
    assert.equal(store.fail(first.id, "Late failure", 75_001), false);
    const retry = store.begin(requests[0].id, settings);
    assert.equal(retry.kind, "started");
    assert.notEqual(retry.analysis!.id, first.id);
    assert.equal(store.finish(retry.analysis!.id, result(), 12), true);
    assert.equal(store.finish(first.id, result(), 75_010), false);
    assert.equal(store.get(requests[0].id).analysis!.id, retry.analysis!.id);
  } finally {
    store.close();
  }
});

test("provider failures are persisted, retryable and cannot later become completed", () => {
  const { store, requests } = fixture();
  try {
    const first = store.begin(requests[0].id, settings).analysis!;
    assert.equal(store.fail(first.id, "The provider timed out. Please try again.", 45_000), true);
    assert.equal(store.get(requests[0].id).analysis!.error, "The provider timed out. Please try again.");
    assert.equal(store.finish(first.id, result(), 45_010), false);
    assert.equal(store.begin(requests[0].id, settings).kind, "started");
  } finally {
    store.close();
  }
});

test("human decisions are symmetric, idempotent, durable, and survive reanalysis", () => {
  const { store, path, requests, clock, advance } = fixture();
  const source = requests[0].id;
  const related = requests[1].id;
  const first = store.begin(source, settings).analysis!;
  store.finish(first.id, result(related), 100);
  const input = { analysisId: first.id, relatedRequestId: related, decision: "accepted" as const };
  const accepted = store.review(source, input, "reviewer-a")!;
  assert.equal(accepted.reviews[0].decision, "accepted");
  assert.equal(accepted.reviews[0].relationship, "related");
  assert.equal(store.get(related).analysis, null);
  assert.equal(store.get(related).reviews[0].relatedRequestId, source);
  assert.equal(store.overview()[related].reviews[0].decision, "accepted");
  store.review(source, input, "reviewer-a");
  const inspect = new DatabaseSync(path);
  const countEvents = () => (inspect.prepare("SELECT COUNT(*) AS total FROM request_review_events").get() as { total: number }).total;
  assert.equal(countEvents(), 1);

  advance(10);
  const rerun = store.begin(source, { ...settings, force: true }).analysis!;
  assert.equal(store.get(source).reviews[0].analysisId, first.id);
  store.finish(rerun.id, result(related), 90);
  assert.equal(store.get(source).reviews[0].decision, "accepted");
  assert.throws(() => store.review(source, { ...input, decision: "rejected" }, "reviewer-a"), StaleReviewError);
  assert.equal(countEvents(), 1);
  store.review(source, { ...input, analysisId: rerun.id, decision: "rejected" }, "reviewer-b");
  assert.equal(countEvents(), 2);
  assert.equal(store.get(related).reviews[0].decision, "rejected");
  assert.equal(store.get(related).reviews[0].analysisId, rerun.id);
  inspect.close();
  store.close();

  const reopened = openIntelligenceStore(path, clock);
  assert.equal(reopened.get(source).reviews[0].decision, "rejected");
  assert.equal(reopened.get(related).reviews[0].decision, "rejected");
  assert.equal(reopened.get(source).analysis!.status, "completed");
  reopened.close();
});

test("reviews require a current completed suggestion, never an arbitrary request pair", () => {
  const { store, requests } = fixture();
  try {
    const first = store.begin(requests[0].id, settings).analysis!;
    const input = { analysisId: first.id, relatedRequestId: requests[1].id, decision: "accepted" as const };
    assert.throws(() => store.review(requests[0].id, input, "reviewer"), StaleReviewError);
    store.finish(first.id, result(requests[1].id), 20);
    assert.throws(() => store.review(requests[0].id, { ...input, relatedRequestId: requests[2].id }, "reviewer"), StaleReviewError);
    assert.throws(() => store.review(requests[0].id, { ...input, analysisId: randomUUID() }, "reviewer"), StaleReviewError);
    assert.equal(store.review(randomUUID(), input, "reviewer"), null);
    assert.deepEqual(store.get(requests[0].id).reviews, []);
  } finally {
    store.close();
  }
});

test("an accepted link can be dismissed from either side after reanalysis omits it", () => {
  const { store, path, requests, advance } = fixture();
  try {
    const source = requests[0].id;
    const related = requests[1].id;
    const original = store.begin(source, settings).analysis!;
    store.finish(original.id, result(related), 10);
    store.review(source, {
      analysisId: original.id, relatedRequestId: related, decision: "accepted",
    }, "reviewer-a");

    advance(10);
    const rerun = store.begin(source, { ...settings, force: true }).analysis!;
    store.finish(rerun.id, result(), 10);
    assert.equal(store.get(source).analysis!.result!.suggestions.length, 0);
    assert.equal(store.get(source).reviews[0].decision, "accepted");
    assert.throws(() => store.dismissLink(related, source, rerun.id, "reviewer-b"), StaleReviewError);
    assert.throws(() => store.dismissLink(source, requests[2].id, original.id, "reviewer-b"), StaleReviewError);
    assert.equal(store.dismissLink(randomUUID(), source, original.id, "reviewer-b"), null);

    const dismissed = store.dismissLink(related, source, original.id, "reviewer-b")!;
    assert.equal(dismissed.reviews[0].decision, "rejected");
    assert.equal(dismissed.reviews[0].analysisId, original.id);
    assert.equal(dismissed.reviews[0].relationship, "related");
    assert.equal(store.get(source).reviews[0].decision, "rejected");
    store.dismissLink(source, related, original.id, "reviewer-b");
    const inspect = new DatabaseSync(path);
    const events = inspect.prepare("SELECT decision, analysis_id AS analysisId FROM request_review_events ORDER BY rowid")
      .all();
    assert.deepEqual(events.map(row => ({ ...row })), [
      { decision: "accepted", analysisId: original.id },
      { decision: "rejected", analysisId: original.id },
    ]);
    inspect.close();
  } finally {
    store.close();
  }
});

test("the hourly budget limits new runs while cached reads remain available", () => {
  const { store, requests, advance } = fixture();
  try {
    for (let index = 0; index < 20; index++) {
      const claim = store.begin(requests[0].id, { ...settings, force: true });
      assert.equal(claim.kind, "started");
      store.finish(claim.analysis!.id, result(), 1);
      advance(1);
    }
    assert.equal(store.begin(requests[0].id, settings).kind, "cached");
    assert.equal(store.begin(requests[0].id, { ...settings, force: true }).kind, "busy");
    assert.equal(store.begin(requests[1].id, settings).kind, "busy");
    advance(3_600_001);
    assert.equal(store.begin(requests[0].id, { ...settings, force: true }).kind, "started");
  } finally {
    store.close();
  }
});
