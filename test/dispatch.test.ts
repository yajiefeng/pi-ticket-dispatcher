import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";

// Track temp dirs so tests don't litter the OS temp folder.
const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
import { dispatch } from "../src/dispatch.ts";
import type { DispatchResult } from "../src/dispatch.ts";
import type { HerdrAdapter } from "../src/herdr.ts";
import type { DispatchInput } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

function sh(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8" }).trim();
}

function makeGitRepo(): string {
  const dir = tempDir("td-repo-");
  sh("git init -b main", dir);
  sh('git config user.email "t@t.dev"', dir);
  sh('git config user.name "Tester"', dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
  sh("git add -A && git commit -m init", dir);
  return dir;
}

class FakeHerdr implements HerdrAdapter {
  panes = new Map<string, { name: string; cwd: string; argv: string[]; workspaceId?: string }>();
  workspaces = new Map<string, string>();
  private paneSeq = 0;
  private wsSeq = 0;

  startAgent(opts: { name: string; argv: string[]; cwd?: string; workspaceId?: string; focus?: boolean }) {
    const paneId = `p${++this.paneSeq}`;
    this.panes.set(paneId, { name: opts.name, cwd: opts.cwd ?? "", argv: opts.argv, workspaceId: opts.workspaceId });
    return {
      paneId,
      workspaceId: opts.workspaceId ?? `w${++this.wsSeq}`,
      tabId: `${paneId}:t`,
      terminalId: `term_${paneId}`,
      name: opts.name,
    };
  }
  paneExists(paneId: string): boolean {
    return this.panes.has(paneId);
  }
  closePane(paneId: string): void {
    this.panes.delete(paneId);
  }
  createWorkspace(opts: { label: string; cwd?: string }) {
    const id = `w${++this.wsSeq}`;
    this.workspaces.set(id, opts.label);
    return { workspaceId: id };
  }
  closeWorkspace(workspaceId: string): void {
    this.workspaces.delete(workspaceId);
  }

  // -- test helpers ---------------------------------------------------------
  /** The script of the most recently started pane. */
  scriptOf(paneId: string): string {
    return this.panes.get(paneId)!.argv[2];
  }
  exitPathOf(paneId: string): string {
    const m = this.scriptOf(paneId).match(/echo \$\? > "([^"]+)"/);
    assert.ok(m, `no exit path in script: ${this.scriptOf(paneId)}`);
    return m![1];
  }
  promptContentOf(paneId: string): string {
    const m = this.scriptOf(paneId).match(/"([^"]+\.prompt\.md)"/);
    assert.ok(m, `no prompt path in script: ${this.scriptOf(paneId)}`);
    return fs.readFileSync(m![1], "utf-8");
  }
  verdictPathOf(paneId: string): string {
    const prompt = this.promptContentOf(paneId);
    const m = prompt.match(/at exactly this path:\s*([^\n]+)/);
    assert.ok(m, `no verdict path in prompt: ${prompt}`);
    return m![1].trim();
  }
  /** Simulate the worker committing a change in its worktree. */
  workerCommits(paneId: string, file = "impl.txt", content = "done"): void {
    const cwd = this.panes.get(paneId)!.cwd;
    fs.writeFileSync(path.join(cwd, file), content);
    try {
      sh("git add -A && git commit -m 'implement ticket'", cwd);
    } catch (e) {
      console.error("WORKER COMMIT FAILED in", cwd, "\nSTDERR:", (e as any).stderr, "\nSTDOUT:", (e as any).stdout);
      throw e;
    }
  }
  /** Simulate the worker finishing with a given exit code. */
  workerExits(paneId: string, exitCode: number): void {
    fs.writeFileSync(this.exitPathOf(paneId), String(exitCode), "utf-8");
  }
  /** Simulate a crash: pane disappears without writing an exit file. */
  workerCrashes(paneId: string): void {
    this.panes.delete(paneId);
  }
}

function makeDeps(herdr = new FakeHerdr()) {
  return { herdr };
}

async function run(input: DispatchInput, herdr: FakeHerdr): Promise<DispatchResult> {
  return dispatch(input, makeDeps(herdr));
}

function eventTypes(result: DispatchResult): string[] {
  return result.events.map((e) => e.type);
}

const TICKETS_SOURCE = JSON.stringify([
  { id: "TKT-001", title: "Greet", description: "Add greet()", dependsOn: [] },
  { id: "TKT-002", title: "Farewell", description: "Add farewell()", dependsOn: ["TKT-001"] },
]);

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

test("start initializes state and rejects duplicates", async () => {
  const repo = makeGitRepo();
  const herdr = new FakeHerdr();
  const r = await run({ action: "start", targetRepo: repo, ticketsSource: TICKETS_SOURCE }, herdr);
  assert.equal(r.runStatus, "starting");
  assert.deepEqual(eventTypes(r), []);
  assert.ok(fs.existsSync(path.join(repo, ".pi-ticket-dispatcher", "state.json")));
  // .gitignore contains the state dir
  assert.match(fs.readFileSync(path.join(repo, ".gitignore"), "utf-8"), /\.pi-ticket-dispatcher\//);
  // second start is rejected
  await assert.rejects(
    () => run({ action: "start", targetRepo: repo, ticketsSource: TICKETS_SOURCE }, herdr),
    /already exists/
  );
});

test("start rejects non-git repos and bad ticket sources", async () => {
  const dir = tempDir("td-notgit-");
  await assert.rejects(() => run({ action: "start", targetRepo: dir, ticketsSource: TICKETS_SOURCE }, new FakeHerdr()), /Not a git repository/);
  const repo = makeGitRepo();
  await assert.rejects(() => run({ action: "start", targetRepo: repo, ticketsSource: "garbage" }, new FakeHerdr()), /Could not parse/);
});

// ---------------------------------------------------------------------------
// advance: happy path with dependencies
// ---------------------------------------------------------------------------

test("full run: start -> implement -> integrate -> unlock -> complete", async () => {
  const repo = makeGitRepo();
  const herdr = new FakeHerdr();
  await run({ action: "start", targetRepo: repo, ticketsSource: TICKETS_SOURCE }, herdr);

  // Advance 1: only TKT-001 can start (TKT-002 blocked).
  let r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.deepEqual(eventTypes(r), ["worker_started"]);
  assert.equal((r.events[0] as { ticketId?: string }).ticketId, "TKT-001");

  // Worker completes with a clean commit.
  const p1 = herdr.panes.keys().next().value as string;
  herdr.workerCommits(p1);
  herdr.workerExits(p1, 0);

  // Advance 2: TKT-001 ready -> integrated -> TKT-002 unblocked -> started.
  r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  const types = eventTypes(r);
  assert.ok(types.includes("implementation_ready"));
  assert.ok(types.includes("ticket_integrated"));
  assert.ok(types.includes("worker_started"));
  assert.equal(r.events.find((e) => e.type === "ticket_integrated")!.ticketId, "TKT-001");
  assert.equal(r.events.find((e) => e.type === "worker_started")!.ticketId, "TKT-002");

  // Verify the merge actually landed on main.
  const mainContent = fs.readFileSync(path.join(repo, "impl.txt"), "utf-8");
  assert.equal(mainContent, "done");

  // TKT-002 worker completes (distinct change: TKT-001's file is already merged).
  const p2 = [...herdr.panes.keys()].pop() as string;
  herdr.workerCommits(p2, "farewell.txt", "bye");
  herdr.workerExits(p2, 0);

  // Advance 3: run completes.
  r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.deepEqual(eventTypes(r), ["implementation_ready", "ticket_integrated", "run_completed"]);
  assert.equal(r.runStatus, "completed");
  assert.equal(r.summary["integrated"], 2);
});

test("advance with nothing running reports state_unchanged", async () => {
  const repo = makeGitRepo();
  const herdr = new FakeHerdr();
  await run({ action: "start", targetRepo: repo, ticketsSource: TICKETS_SOURCE }, herdr);
  await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr); // starts TKT-001
  const r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.deepEqual(eventTypes(r), ["state_unchanged"]);
});

test("advance waits for a worker completion within waitMs", async () => {
  const repo = makeGitRepo();
  const herdr = new FakeHerdr();
  await run({ action: "start", targetRepo: repo, ticketsSource: TICKETS_SOURCE }, herdr);
  await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  const p1 = herdr.panes.keys().next().value as string;

  // Complete the worker 100ms into the wait; advance should pick it up.
  setTimeout(() => {
    herdr.workerCommits(p1);
    herdr.workerExits(p1, 0);
  }, 100);

  const r = await run({ action: "advance", targetRepo: repo, waitMs: 2000 }, herdr);
  assert.ok(eventTypes(r).includes("implementation_ready"));
});

// ---------------------------------------------------------------------------
// advance: failure and retry
// ---------------------------------------------------------------------------

test("failed attempt relaunches, then exceeds maxAttempts and fails", async () => {
  const repo = makeGitRepo();
  const herdr = new FakeHerdr();
  await run(
    { action: "start", targetRepo: repo, ticketsSource: JSON.stringify([{ id: "X", title: "X", description: "", dependsOn: [] }]), maxAttempts: 2 },
    herdr
  );
  await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);

  // Attempt 1 fails (exit 1, no commits).
  let p = herdr.panes.keys().next().value as string;
  herdr.workerExits(p, 1);
  let r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.deepEqual(eventTypes(r), ["worker_started"]); // relaunch

  // Attempt 2 fails -> ticket fails.
  p = [...herdr.panes.keys()].pop() as string;
  herdr.workerExits(p, 1);
  r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.deepEqual(eventTypes(r), ["ticket_failed", "run_completed"]);
  assert.equal(r.summary["failed"], 1);
});

test("dirty worktree counts as a failed attempt", async () => {
  const repo = makeGitRepo();
  const herdr = new FakeHerdr();
  await run({ action: "start", targetRepo: repo, ticketsSource: JSON.stringify([{ id: "X", title: "X", description: "", dependsOn: [] }]), maxAttempts: 1 }, herdr);
  await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  const p = herdr.panes.keys().next().value as string;
  // Commits, but leaves an uncommitted change.
  herdr.workerCommits(p);
  fs.writeFileSync(path.join(herdr.panes.get(p)!.cwd, "leftover.txt"), "junk");
  herdr.workerExits(p, 0);
  const r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.deepEqual(eventTypes(r), ["ticket_failed", "run_completed"]);
});

test("crashed worker (pane gone, no exit file) is relaunched", async () => {
  const repo = makeGitRepo();
  const herdr = new FakeHerdr();
  await run({ action: "start", targetRepo: repo, ticketsSource: JSON.stringify([{ id: "X", title: "X", description: "", dependsOn: [] }]) }, herdr);
  await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  const p = herdr.panes.keys().next().value as string;
  herdr.workerCrashes(p);
  const r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.deepEqual(eventTypes(r), ["worker_started"]);
  assert.equal(r.tickets[0].attempts, 1);
});

// ---------------------------------------------------------------------------
// reviewer flow
// ---------------------------------------------------------------------------

test("reviewer approves -> integrates; reviewer rejects -> fix round", async () => {
  const repo = makeGitRepo();
  const herdr = new FakeHerdr();
  await run(
    { action: "start", targetRepo: repo, ticketsSource: JSON.stringify([{ id: "X", title: "X", description: "", dependsOn: [] }]), useReviewer: true, maxAttempts: 3 },
    herdr
  );
  await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);

  // Implementer completes.
  let p = herdr.panes.keys().next().value as string;
  herdr.workerCommits(p);
  herdr.workerExits(p, 0);
  let r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.ok(eventTypes(r).includes("implementation_ready"));
  assert.ok(eventTypes(r).includes("reviewer_started"));

  // Reviewer rejects with feedback -> fix round starts.
  p = [...herdr.panes.keys()].pop() as string;
  const verdictPath = herdr.verdictPathOf(p);
  fs.writeFileSync(verdictPath, "APPROVED: no\nFEEDBACK: add more tests\n");
  herdr.workerExits(p, 0);
  r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.ok(eventTypes(r).includes("review_completed"));
  assert.equal(r.events.find((e) => e.type === "review_completed")!.approved, false);
  assert.ok(eventTypes(r).includes("worker_started")); // fix round

  // Fix worker completes; reviewer approves -> integrates.
  p = [...herdr.panes.keys()].pop() as string;
  herdr.workerCommits(p, "more-tests.txt", "tests added");
  herdr.workerExits(p, 0);
  r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);

  assert.ok(eventTypes(r).includes("implementation_ready"));
  assert.ok(eventTypes(r).includes("reviewer_started"));
  p = [...herdr.panes.keys()].pop() as string;
  const verdictPath2 = herdr.verdictPathOf(p);
  fs.writeFileSync(verdictPath2, "APPROVED: yes\n");
  herdr.workerExits(p, 0);
  r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.deepEqual(eventTypes(r), ["review_completed", "ticket_integrated", "run_completed"]);
});

// ---------------------------------------------------------------------------
// status / resume / resolve / cleanup
// ---------------------------------------------------------------------------

test("status reports run state without side effects", async () => {
  const repo = makeGitRepo();
  const herdr = new FakeHerdr();
  await run({ action: "start", targetRepo: repo, ticketsSource: TICKETS_SOURCE }, herdr);
  const r = await run({ action: "status", targetRepo: repo }, herdr);
  assert.equal(r.action, "status");
  assert.deepEqual(eventTypes(r), []);
});

test("resume loads existing state; advance without start errors", async () => {
  const repo = makeGitRepo();
  const herdr = new FakeHerdr();
  await assert.rejects(() => run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr), /No dispatch state/);
  await run({ action: "start", targetRepo: repo, ticketsSource: TICKETS_SOURCE }, herdr);
  const r = await run({ action: "resume", targetRepo: repo }, herdr);
  assert.equal(r.action, "resume");
});

test("resolve fail_ticket and cancel_run", async () => {
  const repo = makeGitRepo();
  const herdr = new FakeHerdr();
  await run({ action: "start", targetRepo: repo, ticketsSource: TICKETS_SOURCE }, herdr);
  let r = await run({ action: "resolve", targetRepo: repo, choice: "fail_ticket", ticketId: "TKT-001" }, herdr);
  assert.deepEqual(eventTypes(r), ["ticket_failed"]);
  assert.equal(r.summary["failed"], 1);

  // Cancel the rest.
  r = await run({ action: "resolve", targetRepo: repo, choice: "cancel_run" }, herdr);
  assert.ok(eventTypes(r).includes("run_completed"));
  assert.equal(r.summary["cancelled"], 1);
  // Advance after completion is a no-op.
  r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.deepEqual(eventTypes(r), ["state_unchanged"]);
});

test("cleanup removes integrated worktrees and branches", async () => {
  const repo = makeGitRepo();
  const herdr = new FakeHerdr();
  await run({ action: "start", targetRepo: repo, ticketsSource: TICKETS_SOURCE }, herdr);
  await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  const p = herdr.panes.keys().next().value as string;
  const worktree = herdr.panes.get(p)!.cwd;
  herdr.workerCommits(p);
  herdr.workerExits(p, 0);
  await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr); // integrates TKT-001, starts TKT-002

  // Cancel the run so no more workers matter, then clean up.
  await run({ action: "resolve", targetRepo: repo, choice: "cancel_run" }, herdr);
  const r = await run({ action: "cleanup", targetRepo: repo }, herdr);
  assert.equal(r.action, "cleanup");
  assert.ok(!fs.existsSync(worktree), "worktree should be removed");
  // Branch is deleted; commits preserved via the merge.
  const branches = sh("git branch --list", repo);
  assert.ok(!branches.includes("ticket/tkt-001-"), "branch should be deleted");
});

test("merge conflict asks the human via waiting_human", async () => {
  const repo = makeGitRepo();
  // Seed a file both sides will modify.
  fs.writeFileSync(path.join(repo, "conflict.txt"), "base\n");
  sh("git add -A && git commit -m 'base version'", repo);
  const herdr = new FakeHerdr();
  await run({ action: "start", targetRepo: repo, ticketsSource: JSON.stringify([{ id: "X", title: "X", description: "", dependsOn: [] }]) }, herdr);
  await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);

  // Main advances AFTER the worker's branch point, then the worker changes
  // the same file -> a real conflict.
  fs.writeFileSync(path.join(repo, "conflict.txt"), "from main v2\n");
  sh("git add -A && git commit -m 'main moves on'", repo);

  const p = herdr.panes.keys().next().value as string;
  const cwd = herdr.panes.get(p)!.cwd;
  fs.writeFileSync(path.join(cwd, "conflict.txt"), "from worker\n");
  sh("git add -A && git commit -m 'worker version'", cwd);
  herdr.workerExits(p, 0);

  const r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.ok(eventTypes(r).includes("waiting_human"));
  assert.equal(r.runStatus, "waiting_human");
});
