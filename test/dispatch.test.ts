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
  panes = new Map<string, { name: string; cwd: string; argv: string[]; workspaceId?: string; content: string }>();
  workspaces = new Map<string, string>();
  sent: Array<{ target: string; text: string }> = [];
  private paneSeq = 0;
  private wsSeq = 0;

  startAgent(opts: { name: string; argv: string[]; cwd?: string; workspaceId?: string; tabId?: string; paneId?: string; focus?: boolean }) {
    // With the per-ticket tab layout the dispatcher passes the tab's root
    // pane; record the agent on that same pane.
    const paneId = opts.paneId ?? `p${++this.paneSeq}`;
    this.panes.set(paneId, { name: opts.name, cwd: opts.cwd ?? "", argv: opts.argv, workspaceId: opts.workspaceId, content: "" });
    return {
      paneId,
      workspaceId: opts.workspaceId ?? `w${++this.wsSeq}`,
      tabId: opts.tabId ?? `${paneId}:t`,
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
  submitPrompt(target: string, paneId: string, text: string): void {
    this.sent.push({ target, text });
    const pane = this.panes.get(paneId);
    if (pane) this.statuses.set(pane.name, "working");
  }
  readPane(paneId: string): string {
    return this.panes.get(paneId)?.content ?? "";
  }
  waitAgentIdle(_target: string, _timeoutMs: number): boolean {
    return true;
  }
  /** Configurable agent status; default idle so re-sends are testable. */
  statuses = new Map<string, string>();
  agentStatus(target: string): string | undefined {
    return this.statuses.get(target) ?? "idle";
  }
  createWorkspace(opts: { label: string; cwd?: string }) {
    const id = `w${++this.wsSeq}`;
    this.workspaces.set(id, opts.label);
    return { workspaceId: id };
  }
  closeWorkspace(workspaceId: string): void {
    this.workspaces.delete(workspaceId);
  }
  tabs = new Map<string, { label: string; paneId: string }>();
  private tabSeq = 0;
  createTab(opts: { label: string; cwd?: string }) {
    const tabId = `t${++this.tabSeq}`;
    const paneId = `p${++this.paneSeq}`;
    this.tabs.set(tabId, { label: opts.label, paneId });
    this.panes.set(paneId, { name: opts.label, cwd: opts.cwd ?? "", argv: [], content: "" });
    return { tabId, paneId };
  }
  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab) this.panes.delete(tab.paneId);
    this.tabs.delete(tabId);
  }

  // -- test helpers ---------------------------------------------------------
  /** The last instruction sent to a pane's agent. */
  lastInstruction(paneId: string): { target: string; text: string } {
    const name = this.panes.get(paneId)!.name;
    const last = [...this.sent].reverse().find((s) => s.target === name);
    assert.ok(last, `no instruction sent to ${name}`);
    return last!;
  }
  promptContentOf(paneId: string): string {
    const m = this.lastInstruction(paneId).text.match(/specified in (\S+)/);
    assert.ok(m, `no prompt path in instruction`);
    return fs.readFileSync(m![1], "utf-8");
  }
  verdictPathOf(paneId: string): string {
    const instruction = this.lastInstruction(paneId).text;
    const m = instruction.match(/structured verdict to (\S+)\.?$/);
    assert.ok(m, `no verdict path in instruction: ${instruction}`);
    return m![1].replace(/\.$/, "");
  }
  /** Simulate the worker committing and reporting the exact commit id. */
  workerCommits(paneId: string, file = "impl.txt", content = "done"): void {
    const pane = this.panes.get(paneId)!;
    const cwd = pane.cwd;
    fs.writeFileSync(path.join(cwd, file), content);
    try {
      sh("git add -A && git commit -m 'implement ticket'", cwd);
      const commit = sh("git rev-parse HEAD", cwd);
      pane.content = `${pane.content}\nImplemented and committed as ${commit}`;
    } catch (e) {
      console.error("WORKER COMMIT FAILED in", cwd, "\nSTDERR:", (e as any).stderr, "\nSTDOUT:", (e as any).stdout);
      throw e;
    }
  }
  /** Simulate the worker returning to Herdr idle after its skill completes. */
  workerDone(paneId: string): void {
    const pane = this.panes.get(paneId)!;
    this.statuses.set(pane.name, "idle");
  }
  /** Simulate a crash: pane disappears before completion. */
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
  const launchedPane = herdr.panes.keys().next().value as string;
  assert.deepEqual(herdr.panes.get(launchedPane)!.argv, ["pi", "--approve"]);
  assert.ok(herdr.lastInstruction(launchedPane).text.startsWith("/skill:implement"));

  // Worker completes with a clean commit.
  const p1 = herdr.panes.keys().next().value as string;
  herdr.workerCommits(p1);
  herdr.workerDone(p1);

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
  herdr.workerDone(p2);

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
    herdr.workerDone(p1);
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

  // Attempt 1 fails (no commits): the same worker is told to fix it.
  let p = herdr.panes.keys().next().value as string;
  herdr.workerDone(p);
  let r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.deepEqual(eventTypes(r), ["worker_retrying"]);
  assert.equal(r.tickets[0].attempts, 1);

  // Attempt 2 fails -> ticket fails.
  herdr.workerDone(p);
  r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.deepEqual(eventTypes(r), ["ticket_failed", "run_completed"]);
  assert.equal(r.summary["failed"], 1);
});

test("an old or unrelated reported commit does not pass implementation verification", async () => {
  const repo = makeGitRepo();
  const herdr = new FakeHerdr();
  await run({
    action: "start",
    targetRepo: repo,
    ticketsSource: JSON.stringify([{ id: "X", title: "X", description: "", dependsOn: [] }]),
    maxAttempts: 1,
  }, herdr);
  await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  const paneId = herdr.panes.keys().next().value as string;
  const oldCommit = sh("git rev-parse HEAD", repo);
  herdr.panes.get(paneId)!.content = `Commit: ${oldCommit}`;
  herdr.workerDone(paneId);

  const result = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.ok(eventTypes(result).includes("ticket_failed"));
  assert.equal(result.summary.failed, 1);
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
  herdr.workerDone(p);
  const r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.deepEqual(eventTypes(r), ["ticket_failed", "run_completed"]);
});

test("crashed worker (pane gone before completion) is relaunched", async () => {
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
  const implPane = herdr.panes.keys().next().value as string;
  herdr.workerCommits(implPane);
  herdr.workerDone(implPane);
  let r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.ok(eventTypes(r).includes("implementation_ready"));
  assert.ok(eventTypes(r).includes("reviewer_started"));

  // Reviewer rejects with feedback -> fix round reuses the implementer pane.
  const reviewPane1 = [...herdr.panes.keys()].pop() as string;
  assert.ok(herdr.lastInstruction(reviewPane1).text.startsWith("/skill:code-review"));
  const verdictPath = herdr.verdictPathOf(reviewPane1);
  fs.writeFileSync(verdictPath, "APPROVED: no\nFEEDBACK: add more tests\n");
  herdr.workerDone(reviewPane1);
  r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.ok(eventTypes(r).includes("review_completed"));
  assert.equal(r.events.find((e) => e.type === "review_completed")!.approved, false);
  // The fix round runs on the same implementer pane (keeps context).
  assert.equal(herdr.panes.has(implPane), true);

  // Fix worker completes; reviewer approves -> integrates.
  herdr.workerCommits(implPane, "more-tests.txt", "tests added");
  herdr.workerDone(implPane);
  r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);

  assert.ok(eventTypes(r).includes("implementation_ready"));
  assert.ok(eventTypes(r).includes("reviewer_started"));
  const reviewPane2 = [...herdr.panes.keys()].pop() as string;
  const verdictPath2 = herdr.verdictPathOf(reviewPane2);
  fs.writeFileSync(verdictPath2, "APPROVED: yes\n");
  herdr.workerDone(reviewPane2);
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
  herdr.workerDone(p);
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

test("merge conflict is auto-resolved by a conflict worker, then integrated", async () => {
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

  let p = herdr.panes.keys().next().value as string;
  const cwd = herdr.panes.get(p)!.cwd;
  fs.writeFileSync(path.join(cwd, "conflict.txt"), "from worker\n");
  sh("git add -A && git commit -m 'worker version'", cwd);
  const workerCommit = sh("git rev-parse HEAD", cwd);
  herdr.panes.get(p)!.content += `\nImplemented and committed as ${workerCommit}`;
  herdr.workerDone(p);

  // Advance: ready -> merge conflicts -> rebase conflicts -> a conflict
  // resolution worker is dispatched (NOT waiting_human).
  let r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.ok(eventTypes(r).includes("implementation_ready"));
  assert.ok(eventTypes(r).includes("worker_retrying"));
  assert.ok(!eventTypes(r).includes("waiting_human"), "no waiting_human for a resolvable conflict");
  const resolving = r.tickets.find((t) => t.id === "X")!;
  assert.equal(resolving.status, "resolving");

  // The conflict worker resolves the rebase conflict in the worktree.
  p = [...herdr.panes.keys()].pop() as string;
  const wt = herdr.panes.get(p)!.cwd;
  fs.writeFileSync(path.join(wt, "conflict.txt"), "merged\n");
  sh("git add conflict.txt", wt);
  sh("GIT_EDITOR=true git rebase --continue", wt);
  herdr.workerDone(p);

  r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.ok(eventTypes(r).includes("conflict_resolved"));
  assert.ok(eventTypes(r).includes("ticket_integrated"));
  assert.equal(r.summary["integrated"], 1);
  const merged = fs.readFileSync(path.join(repo, "conflict.txt"), "utf-8");
  assert.equal(merged, "merged\n");
});

test("stalled idle worker is auto-restarted, then pauses for a human", async () => {
  const repo = makeGitRepo();
  const herdr = new FakeHerdr();
  await run({ action: "start", targetRepo: repo, ticketsSource: JSON.stringify([{ id: "X", title: "X", description: "", dependsOn: [] }]), maxAttempts: 5 }, herdr);
  await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);

  // Worker never completes and stays idle: fake the idle-stall signal by
  // making the recorded last active time old.
  const statePath = path.join(repo, ".pi-ticket-dispatcher", "state.json");
  const age = (ms: number) => {
    const st = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    st.tickets.X.implementer.lastActiveAt = Date.now() - ms;
    st.tickets.X.implementer.status = "starting";
    const pane = herdr.panes.get(st.tickets.X.implementer.paneId);
    if (pane) herdr.statuses.set(pane.name, "idle");
    fs.writeFileSync(statePath, JSON.stringify(st), "utf-8");
  };

  // First stall -> auto restart (worker_retrying), new worker launched.
  age(40 * 60_000);
  let r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.ok(eventTypes(r).includes("worker_retrying"), JSON.stringify(r.events));
  assert.equal(herdr.panes.size, 1, "a fresh worker pane should be launched");
  assert.equal(r.tickets[0].attempts, 1);

  // Second stall -> restart again.
  age(40 * 60_000);
  r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.ok(eventTypes(r).includes("worker_retrying"));

  // Third stall (restarts exhausted) -> waiting_human.
  age(40 * 60_000);
  r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.ok(eventTypes(r).includes("waiting_human"), JSON.stringify(r.events));
  assert.equal(r.runStatus, "waiting_human");
});

test("resume migrates legacy (pre-interactive) state", async () => {
  const repo = makeGitRepo();
  const herdr = new FakeHerdr();
  await run({ action: "start", targetRepo: repo, ticketsSource: TICKETS_SOURCE }, herdr);

  // Rewrite state.json to look like the old schema: no `round`, stale worker
  // records, a pending ticket missing round.
  const statePath = path.join(repo, ".pi-ticket-dispatcher", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  delete state.tickets["TKT-001"].round;
  state.tickets["TKT-001"].status = "implementing";
  state.tickets["TKT-001"].implementer = {
    paneId: "p9",
    agentName: "ticket-tkt-001-impl-1",
    workspace: "w9",
    worktreePath: "/nowhere",
    branchName: "ticket/tkt-001-greet",
    startedAt: 1,
    status: "working",
  };
  fs.writeFileSync(statePath, JSON.stringify(state), "utf-8");

  const r = await run({ action: "resume", targetRepo: repo }, herdr);
  assert.equal(r.action, "resume");
  // Migration ran: stale worker cleared, round seeded.
  const migrated = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  assert.equal(migrated.tickets["TKT-001"].round, 0);
  assert.equal(migrated.tickets["TKT-001"].implementer, undefined);
  assert.equal(migrated.tickets["TKT-001"].status, "implementing");

  // advance relaunches with the interactive model.
  const adv = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.ok(eventTypes(adv).includes("worker_started"));
});

test("re-sends a lost worker instruction", async () => {
  const repo = makeGitRepo();
  const herdr = new FakeHerdr();
  await run({ action: "start", targetRepo: repo, ticketsSource: JSON.stringify([{ id: "X", title: "X", description: "", dependsOn: [] }]) }, herdr);
  await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.equal(herdr.sent.length, 1);

  // Simulate a lost instruction: the worker is idle, no result ever appears,
  // and the last send was long ago.
  herdr.sent = [];
  const workerName = herdr.panes.values().next().value!.name;
  herdr.statuses.set(workerName, "idle");
  const statePath = path.join(repo, ".pi-ticket-dispatcher", "state.json");
  const st = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  st.tickets.X.implementer.instructionSentAt = Date.now() - 200_000;
  fs.writeFileSync(statePath, JSON.stringify(st), "utf-8");

  const r = await run({ action: "advance", targetRepo: repo, waitMs: 0 }, herdr);
  assert.equal(herdr.sent.length, 1, "lost instruction should be re-sent");
  assert.ok(herdr.sent[0].text.startsWith("/skill:implement"), herdr.sent[0].text);
});
