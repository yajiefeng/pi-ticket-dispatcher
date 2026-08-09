/**
 * State management for the ticket dispatcher.
 *
 * Durable state lives in <target-repo>/.pi-ticket-dispatcher/state.json.
 * All mutations go through functions here to enforce valid transitions
 * and write the state atomically.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  DispatchState,
  Ticket,
  TicketState,
  TicketStatus,
  AttemptRecord,
  WorkerInfo,
} from "./types.ts";

const STATE_DIR = ".pi-ticket-dispatcher";
const STATE_FILE = "state.json";

/** Get the path to the state directory within the target repo. */
export function stateDir(targetRepo: string): string {
  return path.join(targetRepo, STATE_DIR);
}

/** Get the path to the state file. */
export function stateFilePath(targetRepo: string): string {
  return path.join(targetRepo, STATE_DIR, STATE_FILE);
}

/** Check if state exists for the given target repo. */
export function stateExists(targetRepo: string): boolean {
  return fs.existsSync(stateFilePath(targetRepo));
}

/** Load state from disk. Throws if not found or invalid. */
export function loadState(targetRepo: string): DispatchState {
  const file = stateFilePath(targetRepo);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No dispatch state found at ${file}. Use action "start" to initialize.`
    );
  }
  const raw = fs.readFileSync(file, "utf-8");
  const state = JSON.parse(raw) as DispatchState;
  if (state.schemaVersion !== 1) {
    throw new Error(`Unsupported state schema version: ${state.schemaVersion}`);
  }
  return state;
}

/** Atomically write state to disk. */
export function saveState(state: DispatchState): void {
  const dir = stateDir(state.targetRepo);
  const file = stateFilePath(state.targetRepo);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpFile = `${file}.tmp.${process.pid}`;
  const toWrite: DispatchState = { ...state, updatedAt: Date.now() };
  fs.writeFileSync(tmpFile, JSON.stringify(toWrite, null, 2), "utf-8");
  fs.renameSync(tmpFile, file);
}

/** Generate a short, human-readable ticket branch name. */
export function ticketBranchName(ticketId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `ticket/${ticketId.toLowerCase()}-${slug}`;
}

/**
 * Initialize a new dispatch run with the given tickets.
 * Orders tickets topologically so dependencies are dispatched first.
 */
export function initState(params: {
  targetRepo: string;
  tickets: Ticket[];
  baseBranch: string;
  maxParallel: number;
  useReviewer: boolean;
  maxAttempts: number;
}): DispatchState {
  const { targetRepo, tickets, baseBranch, maxParallel, useReviewer, maxAttempts } = params;
  const now = Date.now();
  const runId = `dispatch-${now.toString(36)}`;

  // Build ticket state map
  const ticketStates: Record<string, TicketState> = {};
  for (const ticket of tickets) {
    ticketStates[ticket.id] = {
      ticket,
      status: "pending",
      branchName: ticketBranchName(ticket.id, ticket.title),
      attempts: [],
      attemptCount: 0,
      round: 0,
      maxAttempts,
      createdAt: now,
      updatedAt: now,
    };
  }

  // Topological sort: dependencies first
  const dispatchOrder = topologicalSort(tickets);

  // Mark tickets with unmet dependencies as blocked initially
  for (const ticket of tickets) {
    if (ticket.dependsOn.length > 0) {
      const hasPendingDep = ticket.dependsOn.some(
        (depId) => ticketStates[depId] && ticketStates[depId].status !== "integrated"
      );
      if (hasPendingDep) {
        ticketStates[ticket.id].status = "blocked";
      }
    }
  }

  const state: DispatchState = {
    runId,
    targetRepo,
    baseBranch,
    tickets: ticketStates,
    dispatchOrder,
    maxParallel,
    useReviewer,
    runStatus: "starting",
    startedAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };

  return state;
}

/**
 * Topologically sort tickets by dependency.
 * Returns ticket IDs in dispatch order (dependencies first).
 * Throws on circular dependencies.
 */
export function topologicalSort(tickets: Ticket[]): string[] {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const result: string[] = [];
  const ticketMap = new Map(tickets.map((t) => [t.id, t]));

  function dfs(id: string): void {
    if (inStack.has(id)) {
      throw new Error(`Circular dependency detected involving ticket ${id}`);
    }
    if (visited.has(id)) return;

    inStack.add(id);
    const ticket = ticketMap.get(id);
    if (!ticket) {
      throw new Error(`Ticket ${id} not found in ticket list`);
    }
    for (const depId of ticket.dependsOn) {
      dfs(depId);
    }
    inStack.delete(id);
    visited.add(id);
    result.push(id);
  }

  for (const ticket of tickets) {
    dfs(ticket.id);
  }

  return result;
}

/** Valid status transitions. */
const VALID_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  pending: ["blocked", "implementing", "cancelled"],
  blocked: ["pending", "cancelled"],
  implementing: ["ready", "fixing", "failed", "cancelled", "reviewing"],
  reviewing: ["ready", "fixing", "failed", "cancelled"],
  fixing: ["ready", "reviewing", "failed", "cancelled"],
  ready: ["integrated", "cancelled", "failed"],
  integrated: [], // terminal
  failed: [],     // terminal
  cancelled: [],  // terminal
};

/**
 * Transition a ticket's status.
 * Returns a new TicketState with the updated status.
 * Throws if the transition is invalid.
 */
export function transitionStatus(
  state: TicketState,
  newStatus: TicketStatus
): TicketState {
  const valid = VALID_TRANSITIONS[state.status];
  if (!valid.includes(newStatus)) {
    throw new Error(
      `Invalid ticket status transition: ${state.status} -> ${newStatus} ` +
      `(ticket: ${state.ticket.id})`
    );
  }
  return {
    ...state,
    status: newStatus,
    updatedAt: Date.now(),
  };
}

/** Add an attempt record to a ticket. */
export function addAttempt(
  state: TicketState,
  attempt: AttemptRecord
): TicketState {
  // Implementation attempts (initial implement + fix rounds) count against
  // maxAttempts; review rounds are recorded but never consume an attempt.
  const counts = attempt.type === "implement" || attempt.type === "fix";
  return {
    ...state,
    attempts: [...state.attempts, attempt],
    attemptCount: counts ? state.attemptCount + 1 : state.attemptCount,
    updatedAt: Date.now(),
  };
}

/** Count attempts of a given type for a ticket. */
export function countAttempts(
  state: TicketState,
  type: AttemptRecord["type"]
): number {
  return state.attempts.filter((a) => a.type === type).length;
}

/** Set the implementer worker info. */
export function setImplementer(
  state: TicketState,
  worker: WorkerInfo
): TicketState {
  return {
    ...state,
    implementer: worker,
    worktreePath: worker.worktreePath,
    updatedAt: Date.now(),
  };
}

/** Set the reviewer worker info. */
export function setReviewer(
  state: TicketState,
  reviewer: WorkerInfo
): TicketState {
  return {
    ...state,
    reviewer,
    updatedAt: Date.now(),
  };
}

/** Get all tickets currently in active (non-terminal, non-blocked, non-pending) state. */
export function getActiveTickets(state: DispatchState): string[] {
  return Object.entries(state.tickets)
    .filter(([, ts]) => ["implementing", "reviewing", "fixing"].includes(ts.status))
    .map(([id]) => id);
}

/** Count tickets that currently have a live worker running (pane alive, no exit yet).
 *  Reviewer and implementer panes are both counted; a crash-detected worker is not. */
export function countRunningWorkers(state: DispatchState): number {
  let count = 0;
  for (const ts of Object.values(state.tickets)) {
    if (!["implementing", "reviewing", "fixing"].includes(ts.status)) continue;
    const worker = ts.status === "reviewing" ? ts.reviewer : ts.implementer;
    if (worker?.paneId) count += 1;
  }
  return count;
}

/** Get all pending (ready to start) tickets. */
export function getReadyTickets(state: DispatchState): string[] {
  return Object.entries(state.tickets)
    .filter(([, ts]) => ts.status === "pending")
    .map(([id]) => id)
    .sort(
      (a, b) => state.dispatchOrder.indexOf(a) - state.dispatchOrder.indexOf(b)
    );
}

/**
 * Unblock tickets whose dependencies have been satisfied.
 * Call this after integrating a ticket.
 */
export function unblockDependents(state: DispatchState, integratedTicketId: string): DispatchState {
  const newTickets = { ...state.tickets };
  for (const [id, ts] of Object.entries(newTickets)) {
    if (ts.status !== "blocked") continue;
    // Check if the integrated ticket is in this one's dependencies
    if (ts.ticket.dependsOn.includes(integratedTicketId)) {
      // Check if ALL dependencies are now satisfied
      const allDepsSatisfied = ts.ticket.dependsOn.every(
        (depId) =>
          newTickets[depId] && newTickets[depId].status === "integrated"
      );
      if (allDepsSatisfied) {
        newTickets[id] = transitionStatus(ts, "pending");
      }
    }
  }
  return { ...state, tickets: newTickets, updatedAt: Date.now() };
}

/** Compute a summary of the current run status. */
export function runSummary(state: DispatchState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ts of Object.values(state.tickets)) {
    counts[ts.status] = (counts[ts.status] || 0) + 1;
  }
  return counts;
}

/** Check if all tickets have reached a terminal state. */
export function isRunComplete(state: DispatchState): boolean {
  return Object.values(state.tickets).every(
    (ts) => ts.status === "integrated" || ts.status === "failed" || ts.status === "cancelled"
  );
}
