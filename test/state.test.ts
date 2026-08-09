import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initState,
  transitionStatus,
  addAttempt,
  countAttempts,
  unblockDependents,
  isRunComplete,
  getReadyTickets,
  countRunningWorkers,
} from "../src/state.ts";
import type { Ticket } from "../src/types.ts";

const TICKETS: Ticket[] = [
  { id: "A", title: "Alpha", description: "", dependsOn: [] },
  { id: "B", title: "Beta", description: "", dependsOn: ["A"] },
  { id: "C", title: "Gamma", description: "", dependsOn: ["A", "B"] },
];

function makeState() {
  return initState({
    targetRepo: "/tmp/repo",
    tickets: TICKETS,
    baseBranch: "main",
    maxParallel: 2,
    useReviewer: false,
    maxAttempts: 3,
  });
}

test("initState orders tickets and blocks dependents", () => {
  const state = makeState();
  assert.deepEqual(state.dispatchOrder, ["A", "B", "C"]);
  assert.equal(state.tickets["A"].status, "pending");
  assert.equal(state.tickets["B"].status, "blocked");
  assert.equal(state.tickets["C"].status, "blocked");
  assert.equal(state.tickets["A"].round, 0);
});

test("transitionStatus enforces valid transitions", () => {
  const state = makeState();
  const t = state.tickets["A"];
  const impl = transitionStatus(t, "implementing");
  assert.equal(impl.status, "implementing");
  assert.throws(() => transitionStatus(t, "integrated"), /Invalid ticket status transition/);
});

test("addAttempt counts implement and fix, not review", () => {
  const state = makeState();
  let t = state.tickets["A"];
  t = addAttempt(t, { type: "implement", startedAt: 1, workerName: "w" });
  t = addAttempt(t, { type: "fix", startedAt: 2, workerName: "w" });
  t = addAttempt(t, { type: "review", startedAt: 3, workerName: "r" });
  assert.equal(t.attemptCount, 2);
  assert.equal(countAttempts(t, "review"), 1);
});

test("unblockDependents unlocks tickets when all deps integrate", () => {
  let state = makeState();
  state.tickets["A"] = { ...state.tickets["A"], status: "integrated" };
  state = unblockDependents(state, "A");
  // B depends only on A -> pending; C still blocked (needs B too).
  assert.equal(state.tickets["B"].status, "pending");
  assert.equal(state.tickets["C"].status, "blocked");

  state.tickets["B"] = { ...state.tickets["B"], status: "integrated" };
  state = unblockDependents(state, "B");
  assert.equal(state.tickets["C"].status, "pending");
});

test("isRunComplete only when all tickets terminal", () => {
  const state = makeState();
  assert.equal(isRunComplete(state), false);
  for (const id of ["A", "B", "C"]) {
    state.tickets[id] = { ...state.tickets[id], status: "integrated" };
  }
  assert.equal(isRunComplete(state), true);
});

test("getReadyTickets follows dispatch order", () => {
  const state = makeState();
  state.tickets["B"] = { ...state.tickets["B"], status: "pending" };
  assert.deepEqual(getReadyTickets(state), ["A", "B"]);
});

test("countRunningWorkers counts panes in active states", () => {
  const state = makeState();
  state.tickets["A"] = {
    ...state.tickets["A"],
    status: "implementing",
    implementer: { paneId: "p1", agentName: "w", workspace: "", worktreePath: "", branchName: "", startedAt: 0, status: "working" },
  };
  state.tickets["B"] = {
    ...state.tickets["B"],
    status: "reviewing",
    reviewer: { paneId: "p2", agentName: "r", workspace: "", worktreePath: "", branchName: "", startedAt: 0, status: "working" },
  };
  state.tickets["C"] = {
    ...state.tickets["C"],
    status: "implementing",
    implementer: { paneId: "p3", agentName: "w3", workspace: "", worktreePath: "", branchName: "", startedAt: 0, status: "done" },
  };
  // C's worker has a paneId too; all three count in the naive counter.
  assert.equal(countRunningWorkers(state), 3);
});
