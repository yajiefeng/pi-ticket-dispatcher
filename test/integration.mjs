#!/usr/bin/env node
/**
 * Manual end-to-end integration test: runs the real dispatcher against real
 * Herdr and real `pi -p` workers. Not part of `npm test` (needs herdr + a
 * configured LLM provider).
 *
 * Usage: node test/integration.mjs [targetRepo]
 */
import { dispatch } from "../src/dispatch.ts";
import { herdrAdapter } from "../src/herdr.ts";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const sh = (c, d) => execSync(c, { cwd: d, encoding: "utf-8" }).trim();

const repo =
  process.argv[2] ??
  (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "td-int-"));
    sh("git init -b main", dir);
    sh('git config user.email "int@t.dev"', dir);
    sh('git config user.name "Integration"', dir);
    fs.writeFileSync(path.join(dir, "README.md"), "# integration repo\n");
    sh("git add -A && git commit -m init", dir);
    return dir;
  })();

const deps = { herdr: herdrAdapter, log: (m) => console.log("[dispatch]", m) };
const tickets = JSON.stringify([
  { id: "INT-001", title: "Add greeting module", description: "Create src/greet.ts exporting a function greet(name: string): string that returns `Hello, ${name}!`. Add it to the repo and commit.", dependsOn: [] },
]);

async function step(name, input) {
  const r = await dispatch(input, deps);
  console.log(`\n=== ${name} ===`);
  console.log("runStatus:", r.runStatus, "| summary:", JSON.stringify(r.summary));
  for (const e of r.events) console.log("event:", JSON.stringify(e));
  return r;
}

await step("start", { action: "start", targetRepo: repo, ticketsSource: tickets, maxParallel: 1, maxAttempts: 2 });
let r = await step("advance #1", { action: "advance", targetRepo: repo, waitMs: 0 });
while (true) {
  const terminal = r.events.some((e) => ["run_completed", "run_failed"].includes(e.type)) ||
    r.events.some((e) => e.type === "waiting_human");
  if (terminal) break;
  const waitMs = r.events.some((e) => e.type === "state_unchanged") ? 60000 : 5000;
  r = await step(`advance (wait ${waitMs})`, { action: "advance", targetRepo: repo, waitMs });
  if (r.runStatus === "waiting_human") {
    console.log("WAITING HUMAN:", JSON.stringify(r.events));
    break;
  }
}
console.log("\n--- final state ---");
const final = await step("status", { action: "status", targetRepo: repo });
console.log("tickets:", JSON.stringify(final.tickets, null, 1));
console.log("\n--- git log main ---");
console.log(sh("git log --oneline -5", repo));
if (fs.existsSync(path.join(repo, "src", "greet.ts"))) {
  console.log("\n--- src/greet.ts exists: OK ---");
} else {
  console.log("\n--- src/greet.ts MISSING ---");
}
console.log("\n--- cleanup ---");
await step("cleanup", { action: "cleanup", targetRepo: repo, removeIntegrated: true });
