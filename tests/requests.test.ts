import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRequest, RequestValidationError } from "../lib/requests.ts";

test("trims fields while preserving meaningful multiline content", () => {
  assert.deepEqual(validateRequest({ title: "  Weekly reports  ", description: "  Line one\n\nLine two  " }), {
    title: "Weekly reports", description: "Line one\n\nLine two",
  });
});

test("rejects empty, wrong-type, whitespace-only and over-limit submissions", () => {
  const invalid = [null, [], {}, { title: 123, description: true },
    { title: " \n ", description: "\t" },
    { title: "a".repeat(121), description: "Valid" },
    { title: "Valid", description: "a".repeat(4001) },
    { title: "bad\0title", description: "Valid" }];
  for (const input of invalid) assert.throws(() => validateRequest(input), RequestValidationError);
  assert.doesNotThrow(() => validateRequest({ title: "a".repeat(120), description: "b".repeat(4000) }));
});
