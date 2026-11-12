import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, after } from "node:test";
import { GET, POST } from "../app/api/requests/route.ts";
import { closeStore } from "../lib/store.ts";

const root = resolve(".test-data");
mkdirSync(root, { recursive: true });
process.env.SIGNAL_DB_PATH = join(mkdtempSync(join(root, "api-")), "signal.db");
after(closeStore);

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/requests", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}

test("API validates, creates and lists requests with uncached responses", async () => {
  const invalid = await POST(request({ title: "  ", description: "" }));
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.json()).fieldErrors.title);
  assert.deepEqual((await (await GET(new Request("http://localhost:3000/api/requests"))).json()).requests, []);
  const created = await POST(request({ title: "  Weekly report  ", description: "Email the dashboard every Monday." }));
  assert.equal(created.status, 201);
  const payload = await created.json();
  assert.equal(payload.request.title, "Weekly report");
  assert.ok(payload.request.id);
  assert.ok(!Number.isNaN(Date.parse(payload.request.createdAt)));
  const listed = await GET(new Request("http://localhost:3000/api/requests"));
  assert.equal(listed.headers.get("cache-control"), "private, no-store");
  assert.deepEqual((await listed.json()).requests, [payload.request]);
});

test("API rejects cross-origin writes, non-JSON, malformed and oversized bodies", async () => {
  assert.equal((await POST(request({}, { origin: "https://another-site.example" }))).status, 403);
  assert.equal((await POST(request({}, { "Content-Type": "text/plain" }))).status, 415);
  const malformed = new Request("http://localhost:3000/api/requests", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{broken",
  });
  assert.equal((await POST(malformed)).status, 400);
  assert.equal((await POST(request({ title: "x", description: "x".repeat(33_000) }))).status, 413);
});

test("uses the actual loopback Host when Next normalizes the request URL", async () => {
  const result = await POST(request({}, { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }));
  assert.equal(result.status, 400); // Same-origin accepted, empty fields rejected.
  assert.ok((await result.json()).fieldErrors);
  assert.equal((await POST(request({}, { host: "attacker.example", origin: "http://attacker.example" }))).status, 403);
});
