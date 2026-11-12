import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { GET, POST } from "../app/api/requests/route.ts";
import { PUT, DELETE } from "../app/api/requests/[id]/support/route.ts";
import { closeStore } from "../lib/store.ts";

const root = resolve(".test-data");
mkdirSync(root, { recursive: true });
process.env.SIGNAL_DB_PATH = join(mkdtempSync(join(root, "support-api-")), "signal.db");
after(closeStore);

function read(cookie = "") {
  return new Request("http://localhost:3000/api/requests", { headers: { cookie } });
}

function mutation(id: string, method: string, cookie: string, extraHeaders = {}) {
  return new Request(`http://localhost:3000/api/requests/${id}/support`, {
    method, headers: { cookie, origin: "http://localhost:3000", ...extraHeaders },
  });
}

test("board issues an HttpOnly identity and reuses it; support add/remove are idempotent", async () => {
  const initial = await GET(read());
  const setCookie = initial.headers.get("set-cookie")!;
  assert.match(setCookie, /^signal_supporter=[0-9a-f-]{36};/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=31536000/);
  assert.equal(initial.headers.get("vary"), "Cookie");
  const cookie = setCookie.split(";")[0];
  assert.equal((await GET(read(cookie))).headers.get("set-cookie"), null);

  const created = await POST(new Request("http://localhost:3000/api/requests", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Team reports", description: "Share a weekly overview." }),
  }));
  const { request: item } = await created.json();
  const context = { params: Promise.resolve({ id: item.id }) };
  const first = await PUT(mutation(item.id, "PUT", cookie), context);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).request.supportCount, 1);
  const again = await PUT(mutation(item.id, "PUT", cookie), context);
  assert.equal((await again.json()).request.supportCount, 1);
  const ownBoard = await (await GET(read(cookie))).json();
  assert.equal(ownBoard.requests[0].supportedByViewer, true);
  const otherBoard = await (await GET(read())).json();
  assert.equal(otherBoard.requests[0].supportedByViewer, false);
  assert.equal(otherBoard.requests[0].supportCount, 1);
  for (let i = 0; i < 2; i++) {
    const removed = await DELETE(mutation(item.id, "DELETE", cookie), context);
    assert.equal(removed.status, 200);
    const data = await removed.json();
    assert.equal(data.request.supportCount, 0);
    assert.equal(data.request.supportedByViewer, false);
  }
});

test("support rejects missing or malformed identities, cross-origin writes and absent requests", async () => {
  const id = randomUUID();
  const context = { params: Promise.resolve({ id }) };
  assert.equal((await PUT(mutation(id, "PUT", ""), context)).status, 400);
  const malformed = await PUT(mutation(id, "PUT", "signal_supporter=not-an-id"), context);
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("set-cookie"), null);
  const cookie = `signal_supporter=${randomUUID()}`;
  assert.equal((await PUT(mutation(id, "PUT", cookie, { origin: "https://another-site.example" }), context)).status, 403);
  assert.equal((await DELETE(mutation(id, "DELETE", cookie, { origin: "https://another-site.example" }), context)).status, 403);
  assert.equal((await PUT(mutation(id, "PUT", cookie), context)).status, 404);
  const loopback = await PUT(mutation(id, "PUT", cookie, { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }), context);
  assert.equal(loopback.status, 404); // Origin allowed; missing request handled normally.
});
