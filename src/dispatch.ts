/**
 * Dispatch state machine for the Pi Ticket Dispatcher.
 *
 * This is the "deep" logic behind the ticket_dispatch tool: every action is
 * deterministic, idempotent, persists state around side effects, and returns
 * structured events. The model never mutates state directly — it only calls
 * these actions and reacts to the events.
 *
 * Actions:
 * - start:   validate repo, parse tickets, init + save state
 * - resume:  load existing state (clears "paused")
 * - advance: one bounded, idempotent progression (reap -> integrate -> launch,
 *            then optionally wait for the next worker completion)
 * - status:  report state, no side effects
 * - resolve: answer a waiting_human decision
 * - cleanup: remove worktrees/panes/artifacts for integrated/failed tickets
 *
 * Workers are Herdr-managed interactive Pi agents. Completion is detected
 * from Herdr's working -> idle transition, then verified by role-specific
 * artifacts: a reported git commit for implementers or a verdict file for reviewers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  DispatchEvent,
  DispatchState,
  DispatchInput,
  TicketState,
  WorkerInfo,
} from "./types.ts";
import {
  addAttempt,
  countAttempts,
  getReadyTickets,
  initState,
  isRunComplete,
  loadState,
  saveState,
  stateDir,
  stateExists,
  unblockDependents,
} from "./state.ts";
import { parseTickets, validateTickets, loadTicketsFromFile } from "./tickets.ts";
import * as git from "./git.ts";
import type { HerdrAdapter } from "./herdr.ts";
import {
  activeWorker,
  buildImplementerPrompt,
  buildReviewerPrompt,
  buildTaskInstruction,
  parseVerdict,
  promptFile,
  readIfExists,
  reportedCommitIds,
  sanitizeId,
  ticketWorkDir,
  verdictFile,
  workerAgentName,
} from "./workers.ts";

/** Result of any dispatch action, returned to the model. */
export interface DispatchResult {
  action: string;
  runStatus: DispatchState["runStatus"];
  events: DispatchEvent[];
  summary: Record<string, number>;
  tickets: Array<{
    id: string;
    title: string;
    status: TicketState["status"];
    attempts: number;
    maxAttempts: number;
    lastError?: string;
    worker?: { role: "implementer" | "reviewer"; agentName: string; paneId: string };
  }>;
  message?: string;
}

/** Injectable dependencies (for tests). */
export interface DispatcherDeps {
  herdr: HerdrAdapter;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

const DEFAULT_MAX_PARALLEL = 2;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_WAIT_MS = 60_000;
const MAX_WAIT_MS = 600_000;
const POLL_INTERVAL_MS = 1_000;
/** Re-send a worker's instruction if it remains idle without a result this long. */
const REINSTRUCT_INTERVAL_MS = 90_000;
/** If a worker reports non-working for this long without a result, it is stalled: auto-restart it. */
const IDLE_TIMEOUT_MS = 30 * 60_000;
/** Auto-restarts per worker before pausing for a human. */
const MAX_WORKER_RESTARTS = 2;
/** Conflict-resolution attempts per ticket before pausing for a human. */
const MAX_CONFLICT_ATTEMPTS = 2;
/** Default instruction suffix for conflict-resolution rounds. */
const CONFLICT_INSTRUCTION =
  "You are resolving merge/rebase conflicts. Run git status to see conflicted files, " +
  "resolve them, git add them, then run git rebase --continue (set GIT_EDITOR=true). " +
  "Repeat until the rebase is done, then commit if needed.";

export type ResolvedDeps = Required<Pick<DispatcherDeps, "now" | "sleep">> & DispatcherDeps;

function defaultDeps(deps: DispatcherDeps): ResolvedDeps {
  return {
    ...deps,
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
}

function assertAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("aborted");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lightweight fingerprint used to detect whether a pass changed anything. */
function fingerprint(state: DispatchState): string {
  return JSON.stringify({
    runStatus: state.runStatus,
    statusMessage: state.statusMessage,
    tickets: Object.entries(state.tickets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, ts]) => [
        id,
        ts.status,
        ts.attemptCount,
        ts.round,
        ts.implementer?.paneId ?? null,
        ts.reviewer?.paneId ?? null,
        ts.lastCommit ?? null,
      ]),
  });
}

/** Append `.pi-ticket-dispatcher/` to the target repo's .gitignore. */
function ensureStateDirGitignored(targetRepo: string): void {
  const gitignore = path.join(targetRepo, ".gitignore");
  const entry = ".pi-ticket-dispatcher/";
  let content = "";
  try {
    content = fs.readFileSync(gitignore, "utf-8");
  } catch {
    /* no gitignore yet */
  }
  if (content.split("\n").some((l) => l.trim() === entry.trim())) return;
  const sep = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(gitignore, `${sep}${entry}\n`);
}

function assertGitRepo(repo: string): void {
  const r = git.gitRun(repo, ["rev-parse", "--is-inside-work-tree"]);
  if (r.exitCode !== 0) {
    throw new Error(`Not a git repository: ${repo}`);
  }
}

function activeTicketsToProcess(state: DispatchState, only?: string[]): string[] {
  const filter = only ? new Set(only) : undefined;
  return Object.values(state.tickets)
    .map((ts) => ts.ticket.id)
    .filter((id) => !filter || filter.has(id));
}

// ---------------------------------------------------------------------------
// Phase: reap completed workers
// ---------------------------------------------------------------------------

interface ReapContext {
  events: DispatchEvent[];
  changed: boolean;
  only?: string[];
}

// ---------------------------------------------------------------------------
// Worker instructions (interactive pi workers)
// ---------------------------------------------------------------------------

/**
 * Send a Matt skill command to a worker's interactive Pi. The worker pane is
 * reused across rounds so it keeps context; only a crashed/missing pane is
 * relaunched.
 */
function instructWorker(
  state: DispatchState,
  ticket: TicketState,
  role: "implementer" | "reviewer",
  worker: WorkerInfo,
  deps: ResolvedDeps,
  opts?: { reason?: string }
): void {
  const id = ticket.ticket.id;
  const round = worker.round ?? ticket.round;
  const workDir = ticketWorkDir(state, id);
  fs.mkdirSync(workDir, { recursive: true });

  const promptPath = promptFile(state, id, round);
  const verdictPath = verdictFile(state, id, round);
  const prompt =
    role === "reviewer"
      ? buildReviewerPrompt({ state, ticket, verdict: verdictPath })
      : buildImplementerPrompt({
          state,
          ticket,
          feedback:
            opts?.reason ?? (ticket.status === "resolving" ? CONFLICT_INSTRUCTION : ticket.reviewFeedback),
        });
  fs.writeFileSync(promptPath, prompt, "utf-8");

  const instruction = buildTaskInstruction({
    role,
    promptFile: promptPath,
    baseBranch: state.baseBranch,
    verdictFile: role === "reviewer" ? verdictPath : undefined,
  });

  deps.herdr.submitPrompt(worker.agentName, worker.paneId, instruction);
  // Record when the instruction was sent so reap can re-send it if it was
  // lost (e.g. the worker was not ready when it arrived).
  const current = state.tickets[id];
  if (role === "reviewer") {
    current.reviewer = current.reviewer ? { ...current.reviewer, instructionSentAt: deps.now() } : current.reviewer;
  } else {
    current.implementer = current.implementer ? { ...current.implementer, instructionSentAt: deps.now() } : current.implementer;
  }
  deps.log?.(`instructed ${role} ${worker.agentName} with Matt skill (round ${round})`);
}

/** Wait for an interactive pi worker to finish starting up (herdr idle). */
async function waitForWorkerIdle(
  deps: ResolvedDeps,
  worker: WorkerInfo,
  timeoutMs = 60_000
): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    if (deps.herdr.waitAgentIdle(worker.agentName, 5_000)) return true;
    await deps.sleep(Math.min(1_000, deadline - deps.now()));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Phase: reap completed workers (Herdr status + role-specific verification)
// ---------------------------------------------------------------------------

function reapWorkers(state: DispatchState, ctx: ReapContext, deps: ResolvedDeps): void {
  for (const id of activeTicketsToProcess(state, ctx.only)) {
    const ticket = state.tickets[id];
    if (!["implementing", "reviewing", "fixing", "resolving"].includes(ticket.status)) continue;
    const worker = activeWorker(ticket);
    if (!worker?.paneId) continue;
    const round = worker.round ?? ticket.round;

    if (!deps.herdr.paneExists(worker.paneId)) {
      if (ticket.status === "reviewing") restartReviewer(state, ticket, worker, ctx);
      else crashImplementer(state, ticket, worker, ctx);
      continue;
    }

    const status = deps.herdr.agentStatus(worker.agentName);
    const paneText = deps.herdr.readPane(worker.paneId, 120);

    if (status === "working") {
      if (worker.status !== "working") {
        worker.status = "working";
        worker.lastActiveAt = deps.now();
        ctx.changed = true;
      }
      continue;
    }

    const verdictExists =
      ticket.status === "reviewing" && readIfExists(verdictFile(state, id, round)) !== undefined;
    let reportedCommit: string | undefined;
    if (ticket.status !== "reviewing" && ticket.status !== "resolving" && worker.baseCommit) {
      for (const commitId of reportedCommitIds(paneText).reverse()) {
        reportedCommit = git.verifyReportedCommit(worker.worktreePath, commitId, worker.baseCommit);
        if (reportedCommit) break;
      }
    }

    // A valid role-specific artifact also proves completion when a very fast
    // worker went working -> idle between two dispatcher polls.
    const settled = status === "idle" || status === "done";
    const completed = settled && (worker.status === "working" || verdictExists || reportedCommit !== undefined);
    if (completed) {
      worker.status = "idle";
      if (ticket.status === "reviewing") {
        handleReviewerDone(state, ticket, worker, round, ctx, deps);
      } else if (ticket.status === "resolving") {
        handleConflictWorkerDone(state, ticket, worker, round, ctx, deps);
      } else {
        handleImplementerDone(state, ticket, worker, round, reportedCommit, ctx, deps);
      }
      continue;
    }

    // Idle without a result may mean Pi was not ready when the command was
    // sent. Re-send periodically, then restart after a prolonged stall.
    const lastSent = worker.instructionSentAt ?? worker.startedAt;
    if (deps.now() - lastSent > REINSTRUCT_INTERVAL_MS) {
      instructWorker(
        state,
        ticket,
        ticket.status === "reviewing" ? ("reviewer" as const) : ("implementer" as const),
        worker,
        deps
      );
      ctx.changed = true;
      continue;
    }

    const lastActive = worker.lastActiveAt ?? worker.startedAt;
    if (deps.now() - lastActive > IDLE_TIMEOUT_MS) {
      restartStalledWorker(state, ticket, worker, ctx, deps);
    }
  }
}

/**
 * A worker that stayed non-working past IDLE_TIMEOUT_MS without completing is
 * stalled: close its pane and relaunch it (bounded by MAX_WORKER_RESTARTS and
 * maxAttempts). Only after repeated stalls do we pause for a human.
 */
function restartStalledWorker(
  state: DispatchState,
  ticket: TicketState,
  worker: WorkerInfo,
  ctx: ReapContext,
  deps: ResolvedDeps
): void {
  const id = ticket.ticket.id;
  const stallCount = (ticket.stallCount ?? 0) + 1;
  deps.herdr.closePane(worker.paneId);

  if (stallCount <= MAX_WORKER_RESTARTS && ticket.attemptCount < ticket.maxAttempts) {
    const updated = addAttempt(ticket, {
      type: ticket.status === "reviewing" ? ("review" as const) : ticket.status === "fixing" ? ("fix" as const) : ("implement" as const),
      startedAt: worker.startedAt,
      endedAt: Date.now(),
      outcome: "failure",
      notes: `worker stalled idle for ${Math.round(IDLE_TIMEOUT_MS / 60_000)}min without completing; restarted (${stallCount}/${MAX_WORKER_RESTARTS})`,
      workerName: worker.agentName,
    });
    const nextRound = updated.round + 1;
    if (ticket.status === "reviewing") {
      updated.reviewer = undefined; // launchWorkers relaunches
    } else {
      updated.implementer = undefined;
    }
    updated.stallCount = stallCount;
    updated.round = nextRound;
    state.tickets[id] = updated;
    ctx.events.push({
      type: "worker_retrying",
      ticketId: id,
      round: nextRound,
      reason: `worker ${worker.agentName} stalled idle and was restarted (${stallCount}/${MAX_WORKER_RESTARTS})`,
    });
    ctx.changed = true;
    return;
  }

  // Restarts exhausted: pause the run and ask the human.
  state.runStatus = "waiting_human";
  state.statusMessage = `worker ${worker.agentName} (ticket ${id}) stalled ${stallCount} times without completing`;
  ctx.events.push({
    type: "waiting_human",
    reason: `worker ${worker.agentName} for ticket ${id} stalled idle repeatedly without completing; resolve with retry_launch (restart), fail_ticket, or cancel_run`,
    ticketId: id,
    options: ["retry_launch", "fail_ticket", "cancel_run"],
  });
  ctx.changed = true;
}

/** An implementer pane vanished mid-round: count it and relaunch (or fail). */
function crashImplementer(
  state: DispatchState,
  ticket: TicketState,
  worker: WorkerInfo,
  ctx: ReapContext
): void {
  const id = ticket.ticket.id;
  const updated = addAttempt(ticket, {
    type: ticket.status === "fixing" ? ("fix" as const) : ("implement" as const),
    startedAt: worker.startedAt,
    endedAt: Date.now(),
    outcome: "failure",
    notes: `worker ${worker.agentName} crashed (pane ${worker.paneId} gone)`,
    workerName: worker.agentName,
  });
  if (updated.attemptCount < updated.maxAttempts) {
    updated.implementer = undefined; // launchWorkers() relaunches
    state.tickets[id] = updated;
    ctx.changed = true;
    return;
  }
  const failed = { ...updated, status: "failed" as const, errorMessage: "worker crashed repeatedly" };
  state.tickets[id] = failed;
  ctx.events.push({
    type: "ticket_failed",
    ticketId: id,
    reason: "worker crashed without completing",
  });
  ctx.changed = true;
}

/** A reviewer pane vanished mid-round: retry the reviewer (or fail). */
function restartReviewer(
  state: DispatchState,
  ticket: TicketState,
  worker: WorkerInfo,
  ctx: ReapContext
): void {
  const id = ticket.ticket.id;
  const updated = addAttempt(ticket, {
    type: "review",
    startedAt: worker.startedAt,
    endedAt: Date.now(),
    outcome: "failure",
    notes: `reviewer ${worker.agentName} crashed (pane ${worker.paneId} gone)`,
    workerName: worker.agentName,
  });
  if (countAttempts(updated, "review") < ticket.maxAttempts) {
    updated.reviewer = undefined; // launchWorkers() relaunches
    state.tickets[id] = updated;
    ctx.changed = true;
    return;
  }
  const failed = {
    ...updated,
    status: "failed" as const,
    errorMessage: "reviewer crashed repeatedly without producing a verdict",
  };
  state.tickets[id] = failed;
  ctx.events.push({
    type: "ticket_failed",
    ticketId: id,
    reason: "reviewer crashed without producing a verdict",
  });
  ctx.changed = true;
}

/** Implementer finished its round: verify git; success -> ready/reviewing, else re-instruct. */
function handleImplementerDone(
  state: DispatchState,
  ticket: TicketState,
  worker: WorkerInfo,
  round: number,
  reportedCommit: string | undefined,
  ctx: ReapContext,
  deps: ResolvedDeps
): void {
  const id = ticket.ticket.id;
  const worktree = ticket.worktreePath ?? worker.worktreePath;

  if (worktree && reportedCommit && !git.isWorktreeDirty(worktree)) {
    const commitSha = reportedCommit;
    const updated = addAttempt(ticket, {
      type: ticket.status === "fixing" ? ("fix" as const) : ("implement" as const),
      startedAt: worker.startedAt,
      endedAt: Date.now(),
      outcome: "success",
      notes: commitSha,
      workerName: worker.agentName,
    });
    updated.lastCommit = commitSha;
    updated.reviewFeedback = undefined;
    updated.status = state.useReviewer ? "reviewing" : "ready";
    state.tickets[id] = updated;
    ctx.events.push({ type: "implementation_ready", ticketId: id, commitSha });
    ctx.changed = true;
    return;
  }

  // Failed round: send a corrective instruction to the same worker (keeps
  // context), bounded by maxAttempts.
  const reason = !worktree
    ? "your worktree is missing"
    : git.isWorktreeDirty(worktree)
      ? "you left uncommitted changes in the worktree"
      : "your completed response did not report a new commit id from this round";
  instructImplementerFix(state, ticket, worker, reason, ctx, deps);
}

/**
 * A conflict-resolution worker finished its round. Verify the rebase is
 * complete; if so the ticket goes back to ready and integrateReady retries.
 */
function handleConflictWorkerDone(
  state: DispatchState,
  ticket: TicketState,
  worker: WorkerInfo,
  round: number,
  ctx: ReapContext,
  deps: ResolvedDeps
): void {
  const id = ticket.ticket.id;
  const worktree = ticket.worktreePath ?? worker.worktreePath;

  if (worktree && !git.isRebaseInProgress(worktree) && git.hasNewCommits(worktree, state.baseBranch)) {
    // Conflicts resolved: rebase finished, branch has commits. Retry integration.
    const updated = addAttempt(ticket, {
      type: "fix",
      startedAt: worker.startedAt,
      endedAt: Date.now(),
      outcome: "success",
      notes: "resolved merge conflicts",
      workerName: worker.agentName,
    });
    updated.status = "ready";
    state.tickets[id] = updated;
    ctx.events.push({ type: "conflict_resolved", ticketId: id });
    ctx.changed = true;
    return;
  }

  // The worker did not finish the rebase. Count and re-instruct (bounded).
  const conflictAttempts = (ticket.conflictAttempts ?? 0) + 1;
  const updated = addAttempt(ticket, {
    type: "fix",
    startedAt: worker.startedAt,
    endedAt: Date.now(),
    outcome: "failure",
    notes: worktree && git.isRebaseInProgress(worktree)
      ? "rebase still in progress after worker round"
      : "conflict resolution produced no commits",
    workerName: worker.agentName,
  });
  updated.conflictAttempts = conflictAttempts;

  if (conflictAttempts > MAX_CONFLICT_ATTEMPTS) {
    const failed = { ...updated, status: "failed" as const, errorMessage: "conflict resolution failed repeatedly" };
    state.tickets[id] = failed;
    ctx.events.push({
      type: "ticket_failed",
      ticketId: id,
      reason: "could not auto-resolve merge conflicts",
    });
    ctx.changed = true;
    return;
  }

  const nextRound = updated.round + 1;
  const nextWorker: WorkerInfo = {
    ...worker,
    round: nextRound,
    startedAt: deps.now(),
    status: "starting",
    baseCommit: worktree ? git.getHeadCommit(worktree) : worker.baseCommit,
  };
  updated.implementer = nextWorker;
  updated.round = nextRound;
  state.tickets[id] = updated;
  instructWorker(state, updated, "implementer", nextWorker, deps, {
    reason:
      "You are resolving merge/rebase conflicts. Run git status to see conflicted files, resolve them, " +
      "git add them, then run git rebase --continue (set GIT_EDITOR=true). Repeat until the rebase is done.",
  });
  ctx.events.push({
    type: "worker_retrying",
    ticketId: id,
    round: nextRound,
    reason: `conflict resolution attempt ${conflictAttempts}/${MAX_CONFLICT_ATTEMPTS} did not finish`,
  });
  ctx.changed = true;
}

/** Send a corrective instruction (new round, same pane) or fail the ticket. */
function instructImplementerFix(
  state: DispatchState,
  ticket: TicketState,
  worker: WorkerInfo,
  reason: string,
  ctx: ReapContext,
  deps: ResolvedDeps
): void {
  const id = ticket.ticket.id;
  const updated = addAttempt(ticket, {
    type: ticket.status === "fixing" ? ("fix" as const) : ("implement" as const),
    startedAt: worker.startedAt,
    endedAt: Date.now(),
    outcome: "failure",
    notes: reason,
    workerName: worker.agentName,
  });
  if (updated.attemptCount >= updated.maxAttempts) {
    const failed = { ...updated, status: "failed" as const, errorMessage: reason };
    state.tickets[id] = failed;
    ctx.events.push({
      type: "ticket_failed",
      ticketId: id,
      reason: `exceeded ${ticket.maxAttempts} implementation attempts: ${reason}`,
    });
    ctx.changed = true;
    return;
  }

  const nextRound = updated.round + 1;
  const nextWorker: WorkerInfo = {
    ...worker,
    round: nextRound,
    startedAt: deps.now(),
    status: "starting",
    baseCommit: worker.worktreePath ? git.getHeadCommit(worker.worktreePath) : worker.baseCommit,
  };
  if (updated.status === "reviewing") {
    // came from a rejected review -> fixing round
    updated.status = "fixing";
  }
  updated.implementer = nextWorker;
  updated.round = nextRound;
  state.tickets[id] = updated;
  instructWorker(state, updated, "implementer", nextWorker, deps, {
    reason: `Your previous attempt did not pass verification: ${reason}. Fix it, commit it, and report the new commit id.`,
  });
  ctx.events.push({
    type: "worker_retrying",
    ticketId: id,
    round: nextRound,
    reason: `implementation round did not pass verification: ${reason}`,
  });
  ctx.changed = true;
}

/** Reviewer finished its round: read the verdict file. */
function handleReviewerDone(
  state: DispatchState,
  ticket: TicketState,
  worker: WorkerInfo,
  round: number,
  ctx: ReapContext,
  deps: ResolvedDeps
): void {
  const id = ticket.ticket.id;
  const verdict = parseVerdict(readIfExists(verdictFile(state, id, round)));

  const updated = addAttempt(ticket, {
    type: "review",
    startedAt: worker.startedAt,
    endedAt: Date.now(),
    outcome: verdict?.approved ? ("success" as const) : ("failure" as const),
    notes: verdict?.feedback?.slice(0, 200) ?? "no verdict file",
    workerName: worker.agentName,
  });

  if (verdict?.approved) {
    updated.status = "ready";
    state.tickets[id] = updated;
    ctx.events.push({ type: "review_completed", ticketId: id, approved: true });
    ctx.changed = true;
    return;
  }

  const feedback = verdict?.feedback ?? "(no actionable feedback provided)";
  if (verdict === undefined) {
    // Reviewer finished but produced no verdict file: re-instruct (bounded).
    if (countAttempts(updated, "review") >= ticket.maxAttempts) {
      const failed = {
        ...updated,
        status: "failed" as const,
        errorMessage: "reviewer produced no verdict",
      };
      state.tickets[id] = failed;
      ctx.events.push({ type: "ticket_failed", ticketId: id, reason: "reviewer produced no verdict" });
      ctx.changed = true;
      return;
    }
    const nextRound = updated.round + 1;
    const nextWorker: WorkerInfo = {
      ...worker,
      round: nextRound,
      startedAt: deps.now(),
      status: "starting",
    };
    updated.reviewer = nextWorker;
    updated.round = nextRound;
    state.tickets[id] = updated;
    instructWorker(state, updated, "reviewer", nextWorker, deps, {
      reason: "You must create the verdict file at the path given in your instructions.",
    });
    ctx.events.push({
      type: "worker_retrying",
      ticketId: id,
      round: nextRound,
      reason: "reviewer finished without producing a verdict file",
    });
    ctx.changed = true;
    return;
  }

  // Rejected with feedback -> fixing round on the implementer pane.
  if (ticket.attemptCount >= ticket.maxAttempts) {
    const failed = {
      ...updated,
      status: "failed" as const,
      errorMessage: "fix loop exceeded max implementation attempts",
      reviewFeedback: feedback,
    };
    state.tickets[id] = failed;
    ctx.events.push({
      type: "ticket_failed",
      ticketId: id,
      reason: "fix loop exceeded max implementation attempts",
    });
    ctx.changed = true;
    return;
  }
  const implementer = ticket.implementer;
  updated.status = "fixing";
  updated.reviewFeedback = feedback;
  updated.reviewer = undefined;
  if (implementer?.paneId) {
    // Reuse the implementer pane with feedback (keeps context).
    const nextRound = updated.round + 1;
    const nextWorker: WorkerInfo = {
      ...implementer,
      round: nextRound,
      startedAt: deps.now(),
      status: "starting",
      baseCommit: implementer.worktreePath
        ? git.getHeadCommit(implementer.worktreePath)
        : implementer.baseCommit,
    };
    updated.implementer = nextWorker;
    updated.round = nextRound;
    state.tickets[id] = updated;
    instructWorker(state, updated, "implementer", nextWorker, deps, {
      reason: feedback,
    });
  } else {
    state.tickets[id] = updated;
  }
  ctx.events.push({ type: "review_completed", ticketId: id, approved: false, feedback });
  ctx.changed = true;
}

/** Apply unblockDependents in place (unblockDependents returns a new object). */
function applyUnblock(state: DispatchState, integratedTicketId: string): void {
  const next = unblockDependents(state, integratedTicketId);
  state.tickets = next.tickets;
  state.updatedAt = next.updatedAt;
}

function integrateReady(state: DispatchState, ctx: ReapContext, deps: ResolvedDeps): void {
  for (const id of activeTicketsToProcess(state, ctx.only)) {
    const ticket = state.tickets[id];
    if (ticket.status !== "ready") continue;
    if (!ticket.worktreePath) {
      // No worktree recorded; nothing to integrate. Fail hard.
      const failed = { ...ticket, status: "failed" as const, errorMessage: "ready but no worktree" };
      state.tickets[id] = failed;
      ctx.events.push({ type: "ticket_failed", ticketId: id, reason: "ticket ready but worktree missing" });
      ctx.changed = true;
      continue;
    }

    let mergeSha: string;
    try {
      mergeSha = git.integrateBranch({
        repoPath: state.targetRepo,
        branchName: ticket.branchName,
        baseBranch: state.baseBranch,
        ticketId: id,
      });
    } catch (err) {
      // Merge conflict: try to resolve it automatically (rebase, then a
      // worker resolves any remaining conflicts) instead of asking the human.
      handleMergeConflict(state, ticket, ctx, deps);
      continue; // keep integrating other ready tickets
    }

    const integrated = { ...ticket, status: "integrated" as const, lastCommit: mergeSha };
    state.tickets[id] = integrated;
    ctx.events.push({ type: "ticket_integrated", ticketId: id });
    ctx.changed = true;
    applyUnblock(state, id);
  }
}

/**
 * A merge into the base conflicted. Try, in order:
 * 1. rebase the ticket branch onto the base (many conflicts vanish),
 * 2. dispatch a worker to resolve any remaining rebase conflicts,
 * 3. only after MAX_CONFLICT_ATTEMPTS pause for a human.
 */
function handleMergeConflict(
  state: DispatchState,
  ticket: TicketState,
  ctx: ReapContext,
  deps: ResolvedDeps
): void {
  const id = ticket.ticket.id;
  const conflictAttempts = (ticket.conflictAttempts ?? 0) + 1;
  const updated = { ...ticket, conflictAttempts } as TicketState;

  if (conflictAttempts > MAX_CONFLICT_ATTEMPTS) {
    state.tickets[id] = updated;
    state.runStatus = "waiting_human";
    state.statusMessage = `ticket ${id} conflicts with ${state.baseBranch} and could not be auto-resolved`;
    ctx.events.push({
      type: "waiting_human",
      reason: `ticket ${id} still conflicts with ${state.baseBranch} after ${MAX_CONFLICT_ATTEMPTS} auto-resolve attempts; resolve with retry_launch (retry), fail_ticket, or cancel_run`,
      ticketId: id,
      options: ["retry_launch", "fail_ticket", "cancel_run"],
    });
    ctx.changed = true;
    return;
  }

  // Rebase the ticket branch onto the current base.
  const worktree = ticket.worktreePath;
  if (!worktree) {
    const failed = { ...updated, status: "failed" as const, errorMessage: "ready but worktree missing" };
    state.tickets[id] = failed;
    ctx.events.push({ type: "ticket_failed", ticketId: id, reason: "ticket ready but worktree missing" });
    ctx.changed = true;
    return;
  }
  const rebased = git.rebaseOnto(worktree, state.baseBranch);
  if (!rebased.conflicted) {
    // Rebase clean: go straight back to ready; the next cascade pass integrates.
    updated.status = "ready";
    state.tickets[id] = updated;
    ctx.events.push({ type: "conflict_resolved", ticketId: id });
    ctx.changed = true;
    return;
  }

  // Rebase left conflicts: dispatch a worker to resolve them in the worktree.
  updated.status = "resolving";
  updated.implementer = undefined;
  state.tickets[id] = updated;
  ctx.events.push({
    type: "worker_retrying",
    ticketId: id,
    round: updated.round + 1,
    reason: `merge with ${state.baseBranch} conflicted; dispatch conflict-resolution worker (attempt ${conflictAttempts}/${MAX_CONFLICT_ATTEMPTS})`,
  });
  ctx.changed = true;
}

// ---------------------------------------------------------------------------
// Phase: launch workers
// ---------------------------------------------------------------------------

async function launchWorkerFor(
  state: DispatchState,
  ticket: TicketState,
  role: "implementer" | "reviewer",
  ctx: ReapContext,
  deps: ResolvedDeps
): Promise<void> {
  const id = ticket.ticket.id;
  const round = ticket.round + 1;
  const workDir = ticketWorkDir(state, id);
  fs.mkdirSync(workDir, { recursive: true });

  const isReviewer = role === "reviewer";
  const verdictPath = verdictFile(state, id, round);

  // Worktree must exist (cleanup may have removed it).
  let worktree = ticket.worktreePath;
  try {
    if (!worktree || !fs.existsSync(worktree)) {
      worktree = git.createWorktree({
        repoPath: state.targetRepo,
        worktreePath: worktreePathFor(state, id),
        branchName: ticket.branchName,
        baseBranch: state.baseBranch,
      });
    }
  } catch (err) {
    const failed = {
      ...ticket,
      status: "failed" as const,
      errorMessage: `failed to create worktree: ${(err as Error).message}`,
    };
    state.tickets[id] = failed;
    ctx.events.push({ type: "ticket_failed", ticketId: id, reason: `failed to create worktree: ${(err as Error).message}` });
    ctx.changed = true;
    return;
  }

  // The prompt file (written by instructWorker on the same round) and verdict
  // path are prepared up front so the worker can be instructed right away.
  if (isReviewer) {
    fs.writeFileSync(
      promptFile(state, id, round),
      buildReviewerPrompt({ state, ticket, verdict: verdictPath }),
      "utf-8"
    );
  } else {
    fs.writeFileSync(
      promptFile(state, id, round),
      buildImplementerPrompt({
        state,
        ticket,
        feedback: ticket.status === "resolving" ? CONFLICT_INSTRUCTION : ticket.reviewFeedback,
      }),
      "utf-8"
    );
  }

  const agentName = workerAgentName(id, round, isReviewer ? "review" : "impl");
  const tabLabel = `ticket ${id}`;

  // Each ticket gets its own tab in the dispatcher's workspace (keeps the
  // workspace list clean). Reuse the ticket's tab if one was already created.
  let tabId = ticket.tabId;
  let tabPaneId: string | undefined;
  if (!tabId) {
    try {
      const tab = deps.herdr.createTab({ label: tabLabel, cwd: worktree });
      tabId = tab.tabId;
      tabPaneId = tab.paneId;
    } catch (err) {
      tabId = undefined;
      deps.log?.(`tab create failed for ${id}: ${(err as Error).message}; using default tab`);
    }
  }

  let started: ReturnType<HerdrAdapter["startAgent"]>;
  try {
    started = deps.herdr.startAgent({
      name: agentName,
      // Ticket worktrees are created from a repository the user explicitly
      // selected for this run. Approve project-local Pi resources for this
      // worker session so unattended dispatch is not blocked by the trust UI.
      argv: ["pi", "--approve"],
      cwd: worktree,
      workspaceId: ticket.workspaceId,
      tabId,
      paneId: tabPaneId,
      focus: false,
    });
  } catch (err) {
    // Infra failure: don't burn the ticket, ask the human.
    state.runStatus = "waiting_human";
    state.statusMessage = `failed to launch ${role} worker for ticket ${id}`;
    ctx.events.push({
      type: "waiting_human",
      reason: `failed to launch ${role} worker for ticket ${id}: ${(err as Error).message}`,
      ticketId: id,
      options: ["retry_launch", "fail_ticket", "cancel_run"],
    });
    ctx.changed = true;
    return;
  }

  const workerInfo: WorkerInfo = {
    paneId: started.paneId,
    agentName,
    workspace: started.workspaceId,
    worktreePath: worktree,
    branchName: ticket.branchName,
    startedAt: deps.now(),
    status: "starting",
    round,
    baseCommit: isReviewer ? undefined : git.getHeadCommit(worktree),
    workspaceId: started.workspaceId,
    tabId,
  };

  // Persist the worker immediately (crash recovery), then wait for the
  // interactive pi to become ready and send the task instruction.
  const updated: TicketState = {
    ...ticket,
    round,
    worktreePath: worktree,
    workspaceId: ticket.workspaceId,
    tabId: tabId ?? ticket.tabId,
  };
  if (isReviewer) {
    updated.reviewer = workerInfo;
  } else {
    updated.implementer = workerInfo;
    if (updated.status === "pending") updated.status = "implementing";
  }
  state.tickets[id] = updated;
  saveState(state);

  if (!(await waitForWorkerIdle(deps, workerInfo))) {
    deps.log?.(
      `worker ${agentName} did not become idle in time; sending the instruction anyway ` +
        "(reap will re-send it if it was lost)"
    );
  }
  instructWorker(
    state,
    state.tickets[id],
    isReviewer ? "reviewer" : "implementer",
    activeWorker(state.tickets[id]) ?? workerInfo,
    deps
  );
  state.tickets[id].updatedAt = deps.now();
  saveState(state);

  ctx.events.push(
    isReviewer
      ? { type: "reviewer_started", ticketId: id }
      : { type: "worker_started", ticketId: id, workerName: agentName }
  );
  ctx.changed = true;
}

async function launchWorkers(state: DispatchState, ctx: ReapContext, deps: ResolvedDeps): Promise<void> {
  const running = Object.values(state.tickets).filter(
    (ts) => ["implementing", "reviewing", "fixing", "resolving"].includes(ts.status) && activeWorker(ts)?.paneId
  ).length;
  let capacity = state.maxParallel - running;

  if (capacity <= 0) return;

  // 1) Start reviewers for implementations waiting to be reviewed.
  for (const id of activeTicketsToProcess(state, ctx.only)) {
    if (capacity <= 0) return;
    const ticket = state.tickets[id];
    if (ticket.status === "reviewing" && !ticket.reviewer?.paneId) {
      await launchWorkerFor(state, ticket, "reviewer", ctx, deps);
      capacity -= 1;
    }
  }

  // 2) Relaunch implementers whose worker was cleared (crash / stall) and
  //    launch conflict-resolution workers for tickets waiting on a rebase.
  for (const id of activeTicketsToProcess(state, ctx.only)) {
    if (capacity <= 0) return;
    const ticket = state.tickets[id];
    if (
      (ticket.status === "implementing" ||
        ticket.status === "fixing" ||
        ticket.status === "resolving") &&
      !ticket.implementer?.paneId
    ) {
      await launchWorkerFor(state, ticket, "implementer", ctx, deps);
      capacity -= 1;
    }
  }

  // 3) Start new tickets, in dispatch order.
  for (const id of getReadyTickets(state)) {
    if (capacity <= 0) return;
    if (ctx.only && !ctx.only.includes(id)) continue;
    await launchWorkerFor(state, state.tickets[id], "implementer", ctx, deps);
    capacity -= 1;
  }
}

// ---------------------------------------------------------------------------
// Advance
// ---------------------------------------------------------------------------

function summarize(state: DispatchState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ts of Object.values(state.tickets)) {
    counts[ts.status] = (counts[ts.status] || 0) + 1;
  }
  return counts;
}

function ticketRows(state: DispatchState): DispatchResult["tickets"] {
  return Object.values(state.tickets).map((ts) => {
    const active = ["implementing", "reviewing", "fixing", "resolving"].includes(ts.status);
    const w = active ? activeWorker(ts) : undefined;
    return {
      id: ts.ticket.id,
      title: ts.ticket.title,
      status: ts.status,
      attempts: ts.attemptCount,
      maxAttempts: ts.maxAttempts,
      lastError: ts.errorMessage,
      worker: w
        ? {
            role: ts.status === "reviewing" ? ("reviewer" as const) : ("implementer" as const),
            agentName: w.agentName,
            paneId: w.paneId,
          }
        : undefined,
    };
  });
}

function buildResult(
  action: string,
  state: DispatchState,
  events: DispatchEvent[],
  message?: string
): DispatchResult {
  return {
    action,
    runStatus: state.runStatus,
    events,
    summary: summarize(state),
    tickets: ticketRows(state),
    message,
  };
}

/** Where a ticket's git worktree lives: a sibling dot-dir, one folder per repo. */
export function worktreePathFor(state: DispatchState, ticketId: string): string {
  return path.join(
    path.dirname(state.targetRepo),
    ".ticket-worktrees",
    path.basename(state.targetRepo),
    `ticket-${sanitizeId(ticketId)}`
  );
}

/** One bounded progression of the run. */
export async function dispatchAdvance(
  state: DispatchState,
  input: { waitMs?: number; ticketIds?: string[] },
  depsIn: DispatcherDeps
): Promise<DispatchResult> {
  const deps = defaultDeps(depsIn);
  const now = deps.now;
  const sleep = deps.sleep;
  const events: DispatchEvent[] = [];
  const only = input.ticketIds;

  if (state.runStatus === "completed" || state.runStatus === "failed") {
    return buildResult("advance", state, [
      { type: "state_unchanged", reason: `run already in terminal state ${state.runStatus}` },
    ]);
  }
  if (state.runStatus === "waiting_human") {
    return buildResult("advance", state, [
      {
        type: "state_unchanged",
        reason: `run is waiting for a human decision: ${state.statusMessage ?? "see status"}`,
      },
    ]);
  }
  if (state.runStatus === "paused") {
    return buildResult("advance", state, [
      { type: "state_unchanged", reason: `run is paused; use action "resume"` },
    ]);
  }

  state.runStatus = "running";
  state.statusMessage = undefined;

  const waitMs = Math.min(input.waitMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
  const deadline = now() + waitMs;

  // Phase 1: cascade until stable (reap -> integrate -> launch). Not bounded
  // by the deadline: it always runs to a stable state or a waiting_human stop.
  // waitMs only bounds Phase 2 (waiting for the next worker event).
  const waiting = () =>
    (state as { runStatus: DispatchState["runStatus"] }).runStatus === "waiting_human";
  while (!deps.signal?.aborted && !waiting()) {
    const before = fingerprint(state);
    const ctx: ReapContext = { events, changed: false, only };
    reapWorkers(state, ctx, deps);
    if (!waiting()) integrateReady(state, ctx, deps);
    if (!waiting()) await launchWorkers(state, ctx, deps);
    const progressed = ctx.changed || fingerprint(state) !== before;
    if (progressed) saveState(state);
    if (!progressed) break;
    assertAborted(deps.signal);
  }

  // Phase 2: nothing observable happened; wait for the next worker completion.
  if (events.length === 0 && now() < deadline && !deps.signal?.aborted) {
    const running = Object.values(state.tickets).some(
      (ts) => ["implementing", "reviewing", "fixing", "resolving"].includes(ts.status) && activeWorker(ts)?.paneId
    );
    if (running) {
      while (now() < deadline && !deps.signal?.aborted) {
        const ctx: ReapContext = { events, changed: false, only };
        reapWorkers(state, ctx, deps);
        if (ctx.changed) {
          integrateReady(state, ctx, deps);
          await launchWorkers(state, ctx, deps);
          saveState(state);
          break;
        }
        const remaining = deadline - now();
        if (remaining <= 0) break;
        await sleep(Math.min(POLL_INTERVAL_MS, remaining));
      }
    }
  }

  assertAborted(deps.signal);

  // Terminal check.
  if (isRunComplete(state)) {
    state.runStatus = "completed";
    state.statusMessage = undefined;
    saveState(state);
    events.push({ type: "run_completed" });
  } else if (events.length === 0) {
    const idle = Object.values(state.tickets).some(
      (ts) => ["implementing", "reviewing", "fixing", "resolving"].includes(ts.status) && activeWorker(ts)?.paneId
    );
    events.push({
      type: "state_unchanged",
      reason: idle
        ? "workers are still running; no state change within the wait window"
        : getReadyTickets(state).length === 0
          ? "no tickets are running or ready to start (blocked tickets await integrated dependencies)"
          : "no state change",
    });
    saveState(state);
  } else {
    saveState(state);
  }

  return buildResult("advance", state, events);
}

// ---------------------------------------------------------------------------
// Public actions
// ---------------------------------------------------------------------------

/** Initialize a dispatch run from to-tickets output. */
export async function dispatchStart(
  input: Extract<DispatchInput, { action: "start" }>,
  _depsIn: DispatcherDeps
): Promise<DispatchResult> {
  const targetRepo = path.resolve(input.targetRepo);
  assertGitRepo(targetRepo);
  if (stateExists(targetRepo)) {
    throw new Error(
      `Dispatch state already exists at ${stateDir(targetRepo)}. Use action "resume" to continue, or delete the directory to start over.`
    );
  }

  const tickets = input.ticketsFile
    ? loadTicketsFromFile(input.ticketsFile)
    : parseTickets(input.ticketsSource ?? "");
  validateTickets(tickets);
  if (tickets.length === 0) {
    throw new Error("No tickets found in the provided source.");
  }

  const baseBranch = input.baseBranch ?? git.getCurrentBranch(targetRepo);
  const state = initState({
    targetRepo,
    tickets,
    baseBranch,
    maxParallel: input.maxParallel ?? DEFAULT_MAX_PARALLEL,
    useReviewer: input.useReviewer ?? false,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  });

  ensureStateDirGitignored(targetRepo);
  saveState(state);

  return buildResult(
    "start",
    state,
    [],
    `Dispatch run ${state.runId} initialized with ${tickets.length} tickets against base branch ${baseBranch}. Call advance to start workers.`
  );
}

/**
 * Migrate state written by the pre-interactive worker model (commit before
 * 56c3528): that schema had no per-ticket `round` and used exit-code-file
 * workers. Returns true when anything changed.
 */
export function migrateLegacyState(state: DispatchState): boolean {
  let changed = false;
  for (const ts of Object.values(state.tickets)) {
    const migrated = { ...ts } as TicketState & { round?: unknown };
    if (typeof migrated.round !== "number" || Number.isNaN(migrated.round)) {
      migrated.round = 0;
      changed = true;
    }
    // Legacy worker records (exit-file model) are incompatible with the
    // interactive model; clear them so advance relaunches with new workers.
    // Non-terminal tickets keep their attempt counts and status.
    if (!["integrated", "failed", "cancelled"].includes(migrated.status)) {
      if (migrated.implementer || migrated.reviewer) {
        migrated.implementer = undefined;
        migrated.reviewer = undefined;
        changed = true;
      }
    }
    state.tickets[ts.ticket.id] = migrated as TicketState;
  }
  if (state.runStatus === "starting") {
    state.runStatus = "running";
    changed = true;
  }
  return changed;
}

/** Load an existing run from disk (clears "paused", migrates legacy state). */
export function dispatchResume(
  input: Extract<DispatchInput, { action: "resume" }>,
  _depsIn: DispatcherDeps
): DispatchResult {
  const state = loadState(path.resolve(input.targetRepo));

  // Migrate state written by older worker models (pre-56c3528: one-shot
  // `pi -p` workers detected via exit-code files). The new model uses
  // interactive Pi workers with Herdr status-based completion, so stale worker records
  // must be cleared (advance relaunches them) and the round counter seeded.
  const migrated = migrateLegacyState(state);
  if (migrated) saveState(state);

  const wasPaused = state.runStatus === "paused";
  if (wasPaused) {
    state.runStatus = "running";
    saveState(state);
  }
  return buildResult(
    "resume",
    state,
    migrated
      ? [
          {
            type: "state_unchanged",
            reason:
              "resumed a run written by an older dispatcher: stale worker records were cleared " +
              "(advance will relaunch workers with the interactive model); progress on integrated " +
              "tickets and attempt counts are preserved",
          },
        ]
      : [],
    migrated ? "State migrated from the legacy worker model; call advance to continue." : undefined
  );
}

/** Advance the run (async; may wait up to waitMs). */
export function dispatchAdvanceAction(
  input: Extract<DispatchInput, { action: "advance" }>,
  depsIn: DispatcherDeps
): Promise<DispatchResult> {
  const state = loadState(path.resolve(input.targetRepo));
  return dispatchAdvance(state, { waitMs: input.waitMs, ticketIds: input.ticketIds }, depsIn);
}

/** Report run state without side effects. */
export function dispatchStatus(
  input: Extract<DispatchInput, { action: "status" }>,
  _depsIn: DispatcherDeps
): DispatchResult {
  const state = loadState(path.resolve(input.targetRepo));
  const running = Object.values(state.tickets)
    .filter((ts) => ["implementing", "reviewing", "fixing", "resolving"].includes(ts.status))
    .map((ts) => {
      const w = activeWorker(ts);
      return w
        ? `${ts.ticket.id} -> ${ts.status} (${w.agentName}, pane ${w.paneId})`
        : `${ts.ticket.id} -> ${ts.status} (no worker)`;
    });
  return buildResult(
    "status",
    state,
    [],
    running.length > 0 ? `Running workers:\n${running.join("\n")}` : "No workers currently running."
  );
}

/** Resolve a waiting_human decision. */
export function dispatchResolve(
  input: Extract<DispatchInput, { action: "resolve" }>,
  depsIn: DispatcherDeps
): DispatchResult {
  const state = loadState(path.resolve(input.targetRepo));
  const choice = input.choice;
  const events: DispatchEvent[] = [];

  if (choice === "retry_launch") {
    if (state.runStatus !== "waiting_human") {
      throw new Error('resolve choice "retry_launch" requires a waiting_human run.');
    }
    // Close and clear every active worker so the next advance relaunches it.
    for (const ts of Object.values(state.tickets)) {
      if (!["implementing", "reviewing", "fixing", "resolving"].includes(ts.status)) continue;
      for (const worker of [ts.implementer, ts.reviewer]) {
        if (worker?.paneId) depsIn.herdr.closePane(worker.paneId);
      }
      state.tickets[ts.ticket.id] = {
        ...ts,
        implementer: undefined,
        reviewer: undefined,
      };
    }
    state.runStatus = "running";
    state.statusMessage = undefined;
    saveState(state);
    return buildResult("resolve", state, events, "Workers cleared; call advance to relaunch.");
  }

  if (choice === "cancel_run") {
    for (const ts of Object.values(state.tickets)) {
      if (!["integrated", "failed", "cancelled"].includes(ts.status)) {
        state.tickets[ts.ticket.id] = { ...ts, status: "cancelled", errorMessage: undefined };
      }
    }
    state.runStatus = "completed";
    state.statusMessage = "Run cancelled by user.";
    events.push({ type: "run_completed" });
    saveState(state);
    return buildResult("resolve", state, events, "Run cancelled; remaining tickets marked cancelled.");
  }

  if (choice === "fail_ticket") {
    const ticketId = input.ticketId;
    if (!ticketId || !state.tickets[ticketId]) {
      throw new Error('resolve choice "fail_ticket" requires a valid ticketId.');
    }
    const ticket = state.tickets[ticketId];
    const failed = { ...ticket, status: "failed" as const, errorMessage: "failed by user decision" };
    state.tickets[ticketId] = failed;
    events.push({ type: "ticket_failed", ticketId, reason: "failed by user decision" });
    if (isRunComplete(state)) {
      state.runStatus = "completed";
      events.push({ type: "run_completed" });
    }
    state.statusMessage = undefined;
    saveState(state);
    return buildResult("resolve", state, events, `Ticket ${ticketId} marked failed.`);
  }

  throw new Error(`Unknown resolve choice "${choice}". Expected one of: retry_launch, fail_ticket, cancel_run.`);
}

/** Clean up worktrees, panes, and artifacts. */
export function dispatchCleanup(
  input: Extract<DispatchInput, { action: "cleanup" }>,
  depsIn: DispatcherDeps
): DispatchResult {
  const state = loadState(path.resolve(input.targetRepo));
  const removeIntegrated = input.removeIntegrated ?? true;
  const removeFailed = input.removeFailed ?? false;
  const removeArtifacts = input.removeArtifacts ?? true;
  const removeState = input.removeState ?? false;

  const cleaned: string[] = [];
  for (const ts of Object.values(state.tickets)) {
    const shouldRemove =
      (ts.status === "integrated" && removeIntegrated) ||
      (ts.status === "failed" && removeFailed);
    if (!shouldRemove) continue;

    for (const worker of [ts.implementer, ts.reviewer]) {
      if (worker?.paneId) depsIn.herdr.closePane(worker.paneId);
    }
    if (ts.tabId) depsIn.herdr.closeTab(ts.tabId);
    // Legacy layout (pre-tab): close the per-ticket workspace if one exists.
    if (ts.workspaceId) depsIn.herdr.closeWorkspace(ts.workspaceId);
    if (ts.worktreePath) {
      git.removeWorktree(state.targetRepo, ts.worktreePath);
      git.gitRun(state.targetRepo, ["branch", "-D", ts.branchName]);
    }
    cleaned.push(ts.ticket.id);
  }

  if (removeArtifacts) {
    for (const id of cleaned) {
      fs.rmSync(ticketWorkDir(state, id), { recursive: true, force: true });
    }
  }

  if (removeState) {
    fs.rmSync(stateDir(state.targetRepo), { recursive: true, force: true });
  } else if (cleaned.length > 0) {
    saveState(state);
  }

  return buildResult(
    "cleanup",
    state,
    [],
    cleaned.length > 0
      ? `Cleaned up worktrees/panes for: ${cleaned.join(", ")}`
      : "Nothing to clean up (no integrated tickets with removeIntegrated=true, no failed tickets with removeFailed=true)."
  );
}

/** Dispatch an arbitrary tool input to the right action. */
export async function dispatch(
  input: DispatchInput,
  deps: DispatcherDeps
): Promise<DispatchResult> {
  switch (input.action) {
    case "start":
      return dispatchStart(input, deps);
    case "resume":
      return dispatchResume(input, deps);
    case "advance":
      return dispatchAdvanceAction(input, deps);
    case "status":
      return dispatchStatus(input, deps);
    case "resolve":
      return dispatchResolve(input, deps);
    case "cleanup":
      return dispatchCleanup(input, deps);
  }
}
