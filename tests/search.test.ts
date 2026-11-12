import assert from "node:assert/strict";
import { test } from "node:test";
import { filterRequests } from "../lib/search.ts";

const requests = [
  { id: "newest", title: "Weekly Reports", description: "Email the dashboard every Monday." },
  { id: "middle", title: "Save filters", description: "Keep a report view for each team." },
  { id: "oldest", title: "Report exports", description: "Download an archive." },
] as const;

test("search finds title and description matches without changing newest-first order", () => {
  assert.deepEqual(filterRequests(requests, "report").map((request) => request.id), [
    "newest", "middle", "oldest",
  ]);
  assert.deepEqual(filterRequests(requests, "dashboard").map((request) => request.id), ["newest"]);
});

test("search ignores case and surrounding whitespace while keeping an empty query unfiltered", () => {
  assert.deepEqual(filterRequests(requests, "  SAVE FILTERS  ").map((request) => request.id), ["middle"]);
  assert.deepEqual(filterRequests(requests, ""), requests);
  assert.deepEqual(filterRequests(requests, " \n\t "), requests);
  assert.deepEqual(filterRequests(requests, "missing feature"), []);
});

test("search treats wildcard and regular-expression punctuation as literal text", () => {
  const punctuationRequests = [
    { title: "99% uptime", description: "Track reliability." },
    { title: "customer_id field", description: "Include the external ID." },
    { title: "Alerts", description: "Show [urgent] next to blockers." },
  ];
  assert.deepEqual(filterRequests(punctuationRequests, "%"), [punctuationRequests[0]]);
  assert.deepEqual(filterRequests(punctuationRequests, "_"), [punctuationRequests[1]]);
  assert.deepEqual(filterRequests(punctuationRequests, "[urgent]"), [punctuationRequests[2]]);
  assert.deepEqual(filterRequests(punctuationRequests, ".*"), []);
});

test("search normalizes Unicode forms in both stored text and the query", () => {
  const unicodeRequests = [
    { title: "CAFÉ settings", description: "Configure localized labels." },
    { title: "Ｆｉｌｔｅｒ presets", description: "Remember my preferences." },
    { title: "Export options", description: "Keep the cafe\u0301 name in receipts." },
  ];
  assert.deepEqual(filterRequests(unicodeRequests, "cafe\u0301"), [unicodeRequests[0], unicodeRequests[2]]);
  assert.deepEqual(filterRequests(unicodeRequests, "ＦＩＬＴＥＲ"), [unicodeRequests[1]]);
});
