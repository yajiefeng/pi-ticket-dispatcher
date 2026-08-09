/**
 * Worker prompts and artifacts for the ticket dispatcher.
 *
 * A "worker" is a one-shot `pi -p` process launched by Herdr inside the
 * ticket's git worktree. Because Herdr closes the pane when the process
 * exits, every worker writes its prompt, log, and exit code to files in the
 * dispatcher state dir (outside the worktree, so the repo stays clean).
 *
 * Artifacts are per-round (round-N.*) so a crashed worker can never
 * overwrite a live one's files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DispatchState, TicketState, WorkerInfo } from "./types.ts";
import { stateDir } from "./state.ts";

/** Sanitize a ticket id for use in file paths, agent names, and labels. */
export function sanitizeId(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "ticket";
}

/** Directory holding all per-ticket worker artifacts. */
export function ticketWorkDir(state: DispatchState, ticketId: string): string {
  return path.join(stateDir(state.targetRepo), "work", sanitizeId(ticketId));
}

function roundFile(state: DispatchState, ticketId: string, round: number, kind: string): string {
  return path.join(ticketWorkDir(state, ticketId), `round-${round}.${kind}`);
}

export function promptFile(state: DispatchState, ticketId: string, round: number): string {
  return roundFile(state, ticketId, round, "prompt.md");
}

export function logFile(state: DispatchState, ticketId: string, round: number): string {
  return roundFile(state, ticketId, round, "log");
}

export function exitFile(state: DispatchState, ticketId: string, round: number): string {
  return roundFile(state, ticketId, round, "exit");
}

export function verdictFile(state: DispatchState, ticketId: string, round: number): string {
  return roundFile(state, ticketId, round, "verdict.txt");
}

/** Read a file if it exists, else undefined. */
export function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

/** Tail of a file (last `lines` lines). */
export function tailFile(file: string, lines = 15): string {
  const content = readIfExists(file);
  if (content === undefined) return "";
  const all = content.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length > 0);
  return all.slice(-lines).join("\n");
}

/** The shell script that runs a one-shot worker and persists its result. */
export function buildWorkerScript(prompt: string, log: string, exit: string): string {
  const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
  return [
    `pi -p "$(cat ${q(prompt)})" > ${q(log)} 2>&1`,
    `echo $? > ${q(exit)}`,
  ].join("; ");
}

/** Build the implementer (or fix) prompt for a ticket. */
export function buildImplementerPrompt(params: {
  state: DispatchState;
  ticket: TicketState;
  feedback?: string;
}): string {
  const { ticket, feedback } = params;
  const t = ticket.ticket;
  const lines = [
    `You are implementing ticket ${t.id} in a git worktree.`,
    "",
    `## Ticket: ${t.title}`,
    "",
    t.description || "(no description provided)",
    "",
    "## Requirements",
    "- Work only inside this worktree. Read the existing code first to understand project conventions.",
    "- Implement the ticket completely and correctly.",
    "- If the project has a test setup, add or update tests for your changes and run them if practical.",
    "- Commit your changes on the current branch with a clear message referencing the ticket id.",
    "- Do not commit unrelated changes or generated artifacts.",
    "",
    "## Done criteria",
    "- Your changes are committed and the working tree is clean (no uncommitted changes).",
    "- Reply with a short summary of what you changed and the commit SHA(s).",
  ];

  if (feedback) {
    lines.push(
      "",
      "## Review feedback from the previous attempt (address EVERY point)",
      "",
      feedback
    );
  }

  return lines.join("\n");
}

/** Build the reviewer prompt for a ticket. */
export function buildReviewerPrompt(params: {
  state: DispatchState;
  ticket: TicketState;
  verdict: string;
}): string {
  const { state, ticket, verdict } = params;
  const t = ticket.ticket;
  const base = state.baseBranch;
  return [
    `You are reviewing the implementation of ticket ${t.id} in a git worktree.`,
    "",
    `## Ticket: ${t.title}`,
    "",
    t.description || "(no description provided)",
    "",
    "## What to review",
    `The implementation is committed on the current branch (${ticket.branchName}).`,
    "Inspect it with:",
    `- git diff ${base}...HEAD`,
    `- git log --oneline ${base}..HEAD`,
    "Read the changed files fully. Evaluate:",
    "1. Does the implementation fully satisfy the ticket requirements?",
    "2. Is the code correct, idiomatic, and consistent with the existing codebase?",
    "3. Are tests included and passing?",
    "",
    "## Verdict",
    `Create the verdict file at exactly this path:`,
    verdict,
    "",
    "The file must contain EXACTLY this format (one APPROVED line, then FEEDBACK lines):",
    "",
    "APPROVED: yes",
    "FEEDBACK: <actionable feedback line 1>",
    "FEEDBACK: <actionable feedback line 2, if any>",
    "",
    "Rules:",
    "- APPROVED: yes ONLY if the implementation fully satisfies the ticket.",
    "- If not approved, write specific, actionable feedback the implementer can act on without ambiguity.",
    "- Do NOT modify any files in the worktree and do NOT commit anything.",
    "- You MUST create the verdict file. Then reply with a one-line summary.",
  ].join("\n");
}

/** Parse a reviewer verdict file. */
export function parseVerdict(content: string | undefined): {
  approved: boolean;
  feedback?: string;
} | undefined {
  if (content === undefined) return undefined;
  let approved: boolean | undefined;
  const feedback: string[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    const approvedMatch = line.match(/^APPROVED\s*:\s*(yes|no|true|false)$/i);
    if (approvedMatch) {
      approved = ["yes", "true"].includes(approvedMatch[1].toLowerCase());
      continue;
    }
    const feedbackMatch = line.match(/^FEEDBACK\s*:\s*(.*)$/i);
    if (feedbackMatch && feedbackMatch[1].trim().length > 0) {
      feedback.push(feedbackMatch[1].trim());
    }
  }
  if (approved === undefined) return undefined;
  return {
    approved,
    feedback: feedback.length > 0 ? feedback.join("\n") : undefined,
  };
}

/** A name Herdr can display for a worker pane. */
export function workerAgentName(ticketId: string, round: number, role: "impl" | "review"): string {
  return `ticket-${sanitizeId(ticketId).toLowerCase()}-${role}-${round}`;
}

/** Which worker record is active for a ticket's current status. */
export function activeWorker(ticket: TicketState): WorkerInfo | undefined {
  if (ticket.status === "reviewing") return ticket.reviewer;
  return ticket.implementer;
}

/**
 * Unique completion marker for one worker round. The worker must reply with
 * exactly this token when finished, so completion detection is unambiguous
 * even after retries/resumes (old markers from earlier rounds are ignored).
 */
export function roundMarker(ticketId: string, round: number): string {
  return `DONE-${sanitizeId(ticketId).toUpperCase()}-${round}`;
}

/**
 * The single-line instruction sent to an interactive worker. The full task
 * brief lives in a file (written by the dispatcher); the worker reads it,
 * executes, and replies with the marker when done.
 */
export function buildTaskInstruction(params: {
  promptFile: string;
  marker: string;
  extra?: string;
}): string {
  const { promptFile, marker, extra } = params;
  const lines = [
    `Read the file ${promptFile} and follow its instructions completely.`,
    ...(extra ? [extra] : []),
    `When you are done, reply on a single line with exactly: ${marker}`,
  ];
  return lines.join(" ");
}
