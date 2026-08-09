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
 * Workers are Herdr-managed one-shot `pi -p` processes. Their completion is
 * detected by per-round exit-code files; crashes by a missing pane.
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
  buildWorkerScript,
  exitFile,
  logFile,
  parseVerdict,
  promptFile,
  readIfExists,
  sanitizeId,
  tailFile,
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

function failOrRetryImplementer(
  state: DispatchState,
  ticket: TicketState,
  reason: string,
  ctx: ReapContext
): void {
  const attempt = {
    type: ticket.status === "fixing" ? ("fix" as const) : ("implement" as const),
    startedAt: ticket.implementer?.startedAt ?? Date.now(),
    endedAt: Date.now(),
    outcome: "failure" as const,
    notes: reason,
    workerName: ticket.implementer?.agentName ?? "unknown",
  };
  const updated = addAttempt(ticket, attempt);
  updated.implementer = undefined;

  if (updated.attemptCount < updated.maxAttempts) {
    // Stay implementing/fixing; launch() will start the next round.
    state.tickets[ticket.ticket.id] = updated;
    ctx.changed = true;
    // We will report worker_started when the relaunch happens; nothing yet.
    return;
  }

  const failed = { ...updated, status: "failed" as const, errorMessage: reason };
  state.tickets[ticket.ticket.id] = failed;
  ctx.events.push({
    type: "ticket_failed",
    ticketId: ticket.ticket.id,
    reason: `exceeded ${ticket.maxAttempts} implementation attempts: ${reason}`,
  });
  ctx.changed = true;
}

/** Detect finished/crashed workers and apply transitions. */
function reapWorkers(state: DispatchState, ctx: ReapContext, deps: ResolvedDeps): void {
  for (const id of activeTicketsToProcess(state, ctx.only)) {
    const ticket = state.tickets[id];
    if (!["implementing", "reviewing", "fixing"].includes(ticket.status)) continue;
    const worker = activeWorker(ticket);
    if (!worker?.paneId) continue;
    const round = worker.round ?? ticket.round;

    const exitPath = exitFile(state, id, round);
    const exitContent = readIfExists(exitPath);

    if (exitContent !== undefined) {
      // Worker finished. Process the outcome.
      const exitCode = parseInt(exitContent.trim(), 10);
      const workerLog = tailFile(logFile(state, id, round), 10);
      const isReviewer = ticket.status === "reviewing";
      if (isReviewer) {
        reapReviewerDone(state, ticket, worker, round, exitCode, workerLog, ctx);
      } else {
        reapImplementerDone(state, ticket, worker, round, exitCode, workerLog, ctx);
      }
      continue;
    }

    // No exit file yet. Is the pane still alive?
    if (deps.herdr.paneExists(worker.paneId)) {
      // Still running; nothing to do.
      continue;
    }

    // Pane is gone and no exit file: the worker died (crash/kill). Relaunch
    // or fail, counting as a failed attempt.
    if (ticket.status === "reviewing") {
      reviewerCrashed(state, ticket, worker, ctx);
    } else {
      failOrRetryImplementer(
        state,
        ticket,
        `worker ${worker.agentName} died without completing (pane ${worker.paneId} is gone, no exit file)`,
        ctx
      );
    }
  }
}

function reviewerCrashed(
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
    notes: `reviewer ${worker.agentName} died without a verdict`,
    workerName: worker.agentName,
  });
  if (countAttempts(updated, "review") < ticket.maxAttempts) {
    updated.reviewer = undefined;
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

function reapImplementerDone(
  state: DispatchState,
  ticket: TicketState,
  worker: WorkerInfo,
  _round: number,
  exitCode: number,
  workerLog: string,
  ctx: ReapContext
): void {
  const id = ticket.ticket.id;
  const worktree = ticket.worktreePath ?? worker.worktreePath;

  if (
    exitCode === 0 &&
    worktree &&
    git.hasNewCommits(worktree, state.baseBranch) &&
    !git.isWorktreeDirty(worktree)
  ) {
    // Success: implementation committed and clean.
    const commitSha = git.getHeadCommit(worktree);
    const attempt = {
      type: ticket.status === "fixing" ? ("fix" as const) : ("implement" as const),
      startedAt: worker.startedAt,
      endedAt: Date.now(),
      outcome: "success" as const,
      notes: commitSha,
      workerName: worker.agentName,
    };
    const updated = addAttempt(ticket, attempt);
    updated.lastCommit = commitSha;
    updated.reviewFeedback = undefined;

    if (state.useReviewer) {
      updated.status = "reviewing";
    } else {
      updated.status = "ready";
    }
    state.tickets[id] = updated;
    ctx.events.push({ type: "implementation_ready", ticketId: id, commitSha });
    ctx.changed = true;
    return;
  }

  // Failure: bad exit, no commits, or dirty tree.
  const reason =
    exitCode !== 0
      ? `worker exited with code ${exitCode}; ${workerLog.slice(0, 150)}`
      : !worktree
        ? "worker worktree missing"
        : git.isWorktreeDirty(worktree)
          ? "worker left uncommitted changes"
          : "worker made no commits";
  failOrRetryImplementer(state, ticket, reason, ctx);
}

function reapReviewerDone(
  state: DispatchState,
  ticket: TicketState,
  worker: WorkerInfo,
  round: number,
  exitCode: number,
  workerLog: string,
  ctx: ReapContext
): void {
  const id = ticket.ticket.id;
  const verdict = parseVerdict(readIfExists(verdictFile(state, id, round)));

  const attempt = {
    type: "review" as const,
    startedAt: worker.startedAt,
    endedAt: Date.now(),
    outcome: verdict?.approved ? ("success" as const) : ("failure" as const),
    notes: verdict?.feedback?.slice(0, 200) ?? workerLog.slice(0, 200),
    workerName: worker.agentName,
  };
  const updated = addAttempt(ticket, attempt);

  if (verdict?.approved) {
    updated.status = "ready";
    state.tickets[id] = updated;
    ctx.events.push({ type: "review_completed", ticketId: id, approved: true });
    ctx.changed = true;
    return;
  }

  const feedback = verdict?.feedback ?? "(no actionable feedback provided)";
  if (exitCode !== 0 || verdict === undefined) {
    // Reviewer did not produce a usable verdict. Retry the reviewer (bounded).
    if (countAttempts(updated, "review") < ticket.maxAttempts) {
      updated.reviewer = undefined;
      state.tickets[id] = updated;
      ctx.changed = true;
      return;
    }
    const failed = {
      ...updated,
      status: "failed" as const,
      errorMessage: `reviewer did not produce a verdict after ${ticket.maxAttempts} attempts`,
    };
    state.tickets[id] = failed;
    ctx.events.push({
      type: "ticket_failed",
      ticketId: id,
      reason: "reviewer produced no verdict",
    });
    ctx.changed = true;
    return;
  }

  // Reviewer rejected with feedback. Bound by implementation attempts.
  if (ticket.attemptCount < ticket.maxAttempts) {
    updated.status = "fixing";
    updated.reviewFeedback = feedback;
    updated.reviewer = undefined; // clear stale reviewer record for the next review round
    updated.implementer = undefined; // launch() starts the fix round
    state.tickets[id] = updated;
    ctx.events.push({ type: "review_completed", ticketId: id, approved: false, feedback });
    ctx.changed = true;
    return;
  }

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
}

// ---------------------------------------------------------------------------
// Phase: integrate ready tickets
// ---------------------------------------------------------------------------

/** Apply unblockDependents in place (unblockDependents returns a new object). */
function applyUnblock(state: DispatchState, integratedTicketId: string): void {
  const next = unblockDependents(state, integratedTicketId);
  state.tickets = next.tickets;
  state.updatedAt = next.updatedAt;
}

function integrateReady(state: DispatchState, ctx: ReapContext, _deps: ResolvedDeps): void {
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
      // Merge conflict: ask the human.
      state.runStatus = "waiting_human";
      state.statusMessage = `Merge conflict integrating ticket ${id} into ${state.baseBranch}`;
      ctx.events.push({
        type: "waiting_human",
        reason: `merge conflict integrating ticket ${id} into ${state.baseBranch}; resolve with "fail_ticket" or "cancel_run"`,
        ticketId: id,
        options: ["fail_ticket", "cancel_run"],
      });
      ctx.changed = true;
      return; // stop integrating further tickets until resolved
    }

    const integrated = { ...ticket, status: "integrated" as const, lastCommit: mergeSha };
    state.tickets[id] = integrated;
    ctx.events.push({ type: "ticket_integrated", ticketId: id });
    ctx.changed = true;
    applyUnblock(state, id);
  }
}

// ---------------------------------------------------------------------------
// Phase: launch workers
// ---------------------------------------------------------------------------

function launchWorkerFor(
  state: DispatchState,
  ticket: TicketState,
  role: "implementer" | "reviewer",
  ctx: ReapContext,
  deps: ResolvedDeps
): void {
  const id = ticket.ticket.id;
  const round = ticket.round + 1;
  const workDir = ticketWorkDir(state, id);
  fs.mkdirSync(workDir, { recursive: true });

  const isReviewer = role === "reviewer";
  const promptPath = promptFile(state, id, round);
  const logPath = logFile(state, id, round);
  const exitPath = exitFile(state, id, round);
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

  // Build the prompt file.
  const prompt = isReviewer
    ? buildReviewerPrompt({ state, ticket, verdict: verdictPath })
    : buildImplementerPrompt({
        state,
        ticket,
        feedback: ticket.reviewFeedback,
      });
  fs.writeFileSync(promptPath, prompt, "utf-8");

  const script = buildWorkerScript(promptPath, logPath, exitPath);
  const agentName = workerAgentName(id, round, isReviewer ? "review" : "impl");
  const workspaceLabel = `ticket ${id}`;

  // Reuse the ticket's existing Herdr workspace; create one only if needed.
  let workspaceId = ticket.workspaceId;
  if (!workspaceId) {
    try {
      workspaceId = deps.herdr.createWorkspace({ label: workspaceLabel, cwd: worktree }).workspaceId;
    } catch (err) {
      workspaceId = undefined;
      deps.log?.(`workspace create failed for ${id}: ${(err as Error).message}; using default workspace`);
    }
  }

  let started: ReturnType<HerdrAdapter["startAgent"]>;
  try {
    started = deps.herdr.startAgent({
      name: agentName,
      argv: ["sh", "-c", script],
      cwd: worktree,
      workspaceId,
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
    workspaceId: started.workspaceId,
  };

  // Attempts are recorded on completion (reap), not at launch, so the
  // attemptCount bound reflects completed attempts. round/worktree/worker
  // are persisted immediately for crash recovery.
  const updated: TicketState = {
    ...ticket,
    round,
    worktreePath: worktree,
    workspaceId: workspaceId ?? ticket.workspaceId,
  };
  if (isReviewer) {
    updated.reviewer = workerInfo;
  } else {
    updated.implementer = workerInfo;
    if (updated.status === "pending") updated.status = "implementing";
  }

  state.tickets[id] = updated;
  ctx.events.push(
    isReviewer
      ? { type: "reviewer_started", ticketId: id }
      : { type: "worker_started", ticketId: id, workerName: agentName }
  );
  ctx.changed = true;
  // Persist immediately after each launch so a crash can't orphan a pane
  // while the state still says "pending".
  saveState(state);
}

function launchWorkers(state: DispatchState, ctx: ReapContext, deps: ResolvedDeps): void {
  const running = Object.values(state.tickets).filter(
    (ts) => ["implementing", "reviewing", "fixing"].includes(ts.status) && activeWorker(ts)?.paneId
  ).length;
  let capacity = state.maxParallel - running;

  if (capacity <= 0) return;

  // 1) Start reviewers for implementations waiting to be reviewed.
  for (const id of activeTicketsToProcess(state, ctx.only)) {
    if (capacity <= 0) return;
    const ticket = state.tickets[id];
    if (ticket.status === "reviewing" && !ticket.reviewer?.paneId) {
      launchWorkerFor(state, ticket, "reviewer", ctx, deps);
      capacity -= 1;
    }
  }

  // 2) Relaunch implementers for tickets whose worker was cleared (retry/fix).
  for (const id of activeTicketsToProcess(state, ctx.only)) {
    if (capacity <= 0) return;
    const ticket = state.tickets[id];
    if (
      (ticket.status === "implementing" || ticket.status === "fixing") &&
      !ticket.implementer?.paneId
    ) {
      launchWorkerFor(state, ticket, "implementer", ctx, deps);
      capacity -= 1;
    }
  }

  // 3) Start new tickets, in dispatch order.
  for (const id of getReadyTickets(state)) {
    if (capacity <= 0) return;
    if (ctx.only && !ctx.only.includes(id)) continue;
    launchWorkerFor(state, state.tickets[id], "implementer", ctx, deps);
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
    const active = ["implementing", "reviewing", "fixing"].includes(ts.status);
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
    if (!waiting()) launchWorkers(state, ctx, deps);
    const progressed = ctx.changed || fingerprint(state) !== before;
    if (progressed) saveState(state);
    if (!progressed) break;
    assertAborted(deps.signal);
  }

  // Phase 2: nothing observable happened; wait for the next worker completion.
  if (events.length === 0 && now() < deadline && !deps.signal?.aborted) {
    const running = Object.values(state.tickets).some(
      (ts) => ["implementing", "reviewing", "fixing"].includes(ts.status) && activeWorker(ts)?.paneId
    );
    if (running) {
      while (now() < deadline && !deps.signal?.aborted) {
        const ctx: ReapContext = { events, changed: false, only };
        reapWorkers(state, ctx, deps);
        if (ctx.changed) {
          integrateReady(state, ctx, deps);
          launchWorkers(state, ctx, deps);
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
      (ts) => ["implementing", "reviewing", "fixing"].includes(ts.status) && activeWorker(ts)?.paneId
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

/** Load an existing run from disk (clears "paused"). */
export function dispatchResume(
  input: Extract<DispatchInput, { action: "resume" }>,
  _depsIn: DispatcherDeps
): DispatchResult {
  const state = loadState(path.resolve(input.targetRepo));
  const wasPaused = state.runStatus === "paused";
  if (wasPaused) {
    state.runStatus = "running";
    saveState(state);
  }
  return buildResult(
    "resume",
    state,
    [],
    wasPaused ? "Run resumed." : `Run ${state.runId} loaded.`
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
    .filter((ts) => ["implementing", "reviewing", "fixing"].includes(ts.status))
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
  _depsIn: DispatcherDeps
): DispatchResult {
  const state = loadState(path.resolve(input.targetRepo));
  const choice = input.choice;
  const events: DispatchEvent[] = [];

  if (choice === "retry_launch") {
    if (state.runStatus !== "waiting_human") {
      throw new Error('resolve choice "retry_launch" requires a waiting_human run.');
    }
    state.runStatus = "running";
    state.statusMessage = undefined;
    saveState(state);
    return buildResult("resolve", state, events, "Launch retry queued; call advance to retry.");
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
