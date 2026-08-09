/**
 * Core types for the Pi Ticket Dispatcher.
 *
 * All state transitions are typed here so the extension enforces
 * deterministic state rather than relying on the model's memory.
 */

/** Ticket status values for the lifecycle. */
export type TicketStatus =
  | "pending"       // ticket loaded, not yet started
  | "blocked"       // depends on other unfinished tickets
  | "implementing"  // worker is implementing
  | "reviewing"     // reviewer is reviewing (optional)
  | "fixing"        // worker is addressing review feedback
  | "ready"         // implementation approved, ready to integrate
  | "integrated"    // merged into main / base branch
  | "failed"        // exceeded retry limits or human cancelled
  | "cancelled";    // explicitly cancelled by user

/** A single ticket parsed from to-tickets output. */
export interface Ticket {
  id: string;
  title: string;
  description: string;
  /** IDs of tickets that must be integrated before this one can start. */
  dependsOn: string[];
  /** Optional file paths the ticket touches (from to-tickets hints). */
  files?: string[];
  /** Estimated complexity level from to-tickets. */
  complexity?: "low" | "medium" | "high";
}

/** Metadata about a Herdr-managed worker or reviewer pane. */
export interface WorkerInfo {
  paneId: string;
  agentName: string;
  workspace: string;
  worktreePath: string;
  branchName: string;
  startedAt: number;
  status: "starting" | "working" | "idle" | "done" | "failed" | "blocked";
  lastStatusMessage?: string;
  sessionPath?: string;
  /** The ticket's round counter when this worker was launched (for artifact lookup). */
  round?: number;
  /** The Herdr workspace this worker pane lives in, if the dispatcher created one. */
  workspaceId?: string;
}

/** Attempt record for a single implementation or review attempt. */
export interface AttemptRecord {
  type: "implement" | "review" | "fix";
  startedAt: number;
  endedAt?: number;
  outcome?: "success" | "failure" | "cancelled";
  notes?: string;
  workerName: string;
}

/** Per-ticket state persisted on disk. */
export interface TicketState {
  ticket: Ticket;
  status: TicketStatus;
  branchName: string;
  worktreePath?: string;
  /** The Herdr workspace dedicated to this ticket's workers, if the dispatcher created one. */
  workspaceId?: string;
  implementer?: WorkerInfo;
  reviewer?: WorkerInfo;
  attempts: AttemptRecord[];
  /** How many implementation attempts have been made (implement + fix rounds). */
  attemptCount: number;
  /** Monotonic counter incremented on every worker launch (impl, fix, or review).
   *  Used to name per-round artifacts so a crashed launch can never corrupt a live one. */
  round: number;
  /** Maximum allowed implementation attempts before failing. */
  maxAttempts: number;
  /** Review feedback from the most recent review, if any. */
  reviewFeedback?: string;
  /** Commit SHA of the last successful implementation. */
  lastCommit?: string;
  /** Human-readable error if status is failed. */
  errorMessage?: string;
  updatedAt: number;
  createdAt: number;
}

/**
 * Top-level dispatch run state.
 * Stored as JSON in the target repo's .pi-ticket-dispatcher/state.json.
 */
export interface DispatchState {
  runId: string;
  /** Path to the target repository where tickets are being implemented. */
  targetRepo: string;
  /** Base branch to integrate into. */
  baseBranch: string;
  /** All tickets loaded from the to-tickets source. */
  tickets: Record<string, TicketState>;
  /** Ticket IDs in the order they should be dispatched (topological). */
  dispatchOrder: string[];
  /** Maximum number of parallel workers. */
  maxParallel: number;
  /** Whether an optional reviewer is used. */
  useReviewer: boolean;
  /** Current run status. */
  runStatus: "starting" | "running" | "waiting_human" | "completed" | "failed" | "paused";
  /** When the run was started. */
  startedAt: number;
  /** When the run last had a state change. */
  updatedAt: number;
  /** Human message explaining waiting_human or failure state. */
  statusMessage?: string;
  /** Version of this state schema, for future migrations. */
  schemaVersion: 1;
}

/** Actions accepted by the ticket_dispatch tool. */
export type DispatchAction =
  | "start"      // initialize a new dispatch run from tickets
  | "resume"     // load existing state from disk
  | "advance"    // make bounded, idempotent progress
  | "status"     // return current state summary (no side effects)
  | "resolve"    // resolve a human-decision state with a choice
  | "cleanup";   // clean up worktrees and resources after completion

/** Structured events returned by advance/start actions. */
export type DispatchEvent =
  | { type: "worker_started"; ticketId: string; workerName: string }
  | { type: "worker_retrying"; ticketId: string; round: number; reason: string }
  | { type: "implementation_ready"; ticketId: string; commitSha: string }
  | { type: "reviewer_started"; ticketId: string }
  | { type: "review_completed"; ticketId: string; approved: boolean; feedback?: string }
  | { type: "ticket_integrated"; ticketId: string }
  | { type: "ticket_failed"; ticketId: string; reason: string }
  | { type: "run_completed" }
  | { type: "run_failed"; reason: string }
  | { type: "waiting_human"; reason: string; ticketId?: string; options: string[] }
  | { type: "state_unchanged"; reason: string };

/** Input for the start action. */
export interface StartInput {
  action: "start";
  /** Path to the target repository. */
  targetRepo: string;
  /** Raw to-tickets output to parse. */
  ticketsSource?: string;
  /** Or a file path containing the tickets. */
  ticketsFile?: string;
  /** Base branch name, defaults to current branch. */
  baseBranch?: string;
  /** Max parallel workers, default 2. */
  maxParallel?: number;
  /** Whether to use a reviewer, default false. */
  useReviewer?: boolean;
  /** Max attempts per ticket, default 3. */
  maxAttempts?: number;
}

/** Input for the resume action. */
export interface ResumeInput {
  action: "resume";
  targetRepo: string;
}

/** Input for the advance action. */
export interface AdvanceInput {
  action: "advance";
  targetRepo: string;
  /** Optional: only advance specific ticket IDs. */
  ticketIds?: string[];
  /** Wait at most this many ms for progress. Default 30000. */
  waitMs?: number;
}

/** Input for the status action. */
export interface StatusInput {
  action: "status";
  targetRepo: string;
}

/** Input for the resolve action (human decisions). */
export interface ResolveInput {
  action: "resolve";
  targetRepo: string;
  ticketId?: string;
  /** The choice the human made. */
  choice: string;
}

/** Input for the cleanup action. */
export interface CleanupInput {
  action: "cleanup";
  targetRepo: string;
  /** Also remove successfully integrated worktrees. Default true. */
  removeIntegrated?: boolean;
  /** Also remove failed worktrees. Default false. */
  removeFailed?: boolean;
  /** Also remove the run's worker artifacts (logs, prompts, verdicts). Default true. */
  removeArtifacts?: boolean;
  /** Also delete the entire dispatch state directory. Default false. */
  removeState?: boolean;
}

/** Union of all tool inputs. */
export type DispatchInput =
  | StartInput
  | ResumeInput
  | AdvanceInput
  | StatusInput
  | ResolveInput
  | CleanupInput;
