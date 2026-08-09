import { test } from "node:test";
import assert from "node:assert/strict";
import { usesNewAgentApi } from "../src/herdr.ts";

test("usesNewAgentApi: 0.7.x uses the old agent-start API", () => {
  assert.equal(usesNewAgentApi("herdr 0.7.1"), false);
  assert.equal(usesNewAgentApi("herdr 0.7.0"), false);
});

test("usesNewAgentApi: 0.8+ and 1.x use the new API", () => {
  assert.equal(usesNewAgentApi("herdr 0.8.0"), true);
  assert.equal(usesNewAgentApi("herdr 0.9.2"), true);
  assert.equal(usesNewAgentApi("herdr 1.2.0"), true);
});

test("usesNewAgentApi: unknown version assumes the new API", () => {
  assert.equal(usesNewAgentApi(""), true);
  assert.equal(usesNewAgentApi("something weird"), true);
});
