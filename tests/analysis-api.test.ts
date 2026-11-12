import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { test, after } from "node:test";
import { getStore, closeStore } from "../lib/store.ts";
import { getIntelligenceStore, closeIntelligenceStore } from "../lib/intelligence-store.ts";
import { GET } from "../app/api/analysis/route.ts";
import { POST } from "../app/api/requests/[id]/analysis/route.ts";
import { PUT } from "../app/api/requests/[id]/review/route.ts";
import { DELETE } from "../app/api/requests/[id]/links/[relatedId]/route.ts";
import type { AnalysisResult } from "../lib/analysis-types.ts";

const root = resolve(".test-data");
mkdirSync(root, { recursive: true });
process.env.SIGNAL_DB_PATH = join(mkdtempSync(join(root, "analysis-api-")), "signal.db");
process.env.OPENAI_API_KEY = "";
after(() => { closeIntelligenceStore(); closeStore(); });
const source = getStore().create({ title: "Scheduled reports", description: "Send a dashboard by email every Monday." });
const related = getStore().create({ title: "Weekly email", description: "Email the dashboard on a schedule." });
const context = { params: Promise.resolve({ id: source.id }) };
const cookie = `signal_supporter=${randomUUID()}`;

function request(path: string, method: string, body: unknown, headers = {}) {
  return new Request(`http://localhost:3000/api/requests/${source.id}/${path}`, {
    method, headers: { cookie, "Content-Type": "application/json", origin: "http://localhost:3000", ...headers },
    body: JSON.stringify(body),
  });
}

test("overview reports unavailable without exposing secrets; analysis fails safely when unconfigured", async () => {
  const overview = GET();
  assert.equal(overview.status, 200);
  const payload = await overview.json();
  assert.equal(payload.available, false);
  assert.deepEqual(Object.keys(payload).sort(), ["available", "byRequest", "model", "promptVersion"]);
  assert.equal((await POST(request("analysis", "POST", {}), context)).status, 503);
  assert.equal(getStore().list().length, 2);
  assert.equal(getIntelligenceStore().get(source.id).analysis, null);
});

test("analysis and reviews enforce local origin, identity and bounded JSON", async () => {
  assert.equal((await POST(request("analysis", "POST", {}, { origin: "https://other.example" }), context)).status, 403);
  assert.equal((await POST(request("analysis", "POST", {}, { cookie: "" }), context)).status, 400);
  assert.equal((await POST(request("analysis", "POST", { force: "yes" }), context)).status, 400);
  assert.equal((await POST(request("analysis", "POST", { extra: "x".repeat(2200) }), context)).status, 413);
  assert.equal((await PUT(request("review", "PUT", {}, { origin: "https://other.example" }), context)).status, 403);
  assert.equal((await PUT(request("review", "PUT", { decision: "merge" }), context)).status, 400);
});

test("human review links are symmetric, stale suggestions fail, and older links remain removable", async () => {
  const store = getIntelligenceStore();
  const claim = store.begin(source.id, { model: "controlled-test-fixture", promptVersion: "test", candidateCount: 1 });
  const runId = claim.analysis!.id;
  const result: AnalysisResult = {
    problem: "Avoid manual email reporting.", problemEvidence: "Send a dashboard by email every Monday.",
    theme: "Reporting", unknowns: [], suggestions: [{
      requestId: related.id, relationship: "duplicate", reason: "Both ask for scheduled dashboard email.",
      sourceEvidence: "Send a dashboard by email every Monday.", targetEvidence: "Email the dashboard on a schedule.",
    }],
  };
  store.finish(runId, result, 5);
  const accepted = await PUT(request("review", "PUT", {
    analysisId: runId, relatedRequestId: related.id, decision: "accepted",
  }), context);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).intelligence.reviews[0].decision, "accepted");
  assert.equal(store.get(related.id).reviews[0].relatedRequestId, source.id);
  const next = store.begin(source.id, { model: "controlled-test-fixture", promptVersion: "test", candidateCount: 1, force: true });
  store.finish(next.analysis!.id, { ...result, suggestions: [] }, 5);
  assert.equal((await PUT(request("review", "PUT", {
    analysisId: runId, relatedRequestId: related.id, decision: "rejected",
  }), context)).status, 409);
  const removed = await DELETE(request(`links/${related.id}`, "DELETE", { analysisId: runId }), {
    params: Promise.resolve({ id: source.id, relatedId: related.id }),
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).intelligence.reviews[0].decision, "rejected");
  assert.equal(store.get(related.id).reviews[0].decision, "rejected");
  assert.equal(getStore().list().length, 2);
});
