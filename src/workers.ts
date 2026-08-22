/**
 * Worker prompts and artifacts for the ticket dispatcher.
 *
 * A worker is an interactive Pi agent launched by Herdr inside the ticket's
 * git worktree. Per-round prompts and reviewer verdicts live in the dispatcher
 * state directory, outside the worktree so the repository stays clean.
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
    "- Reply with a short summary and a final `COMMIT: <sha>` line for the commit you created.",
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

/** Build the Pi skill command for one worker round. */
export function buildTaskInstruction(params: {
  role: "implementer" | "reviewer";
  promptFile: string;
  baseBranch: string;
  verdictFile?: string;
}): string {
  const { role, promptFile, baseBranch, verdictFile } = params;
  if (role === "implementer") {
    return `/skill:implement Implement only the ticket specified in ${promptFile}. Follow that file as the ticket spec.`;
  }
  return (
    `/skill:code-review ${baseBranch}. Review only the ticket specified in ${promptFile}. ` +
    `Use that file as the spec and write the required structured verdict to ${verdictFile}.`
  );
}

/** Commit ids explicitly reported on commit/SHA lines in Pi's response. */
export function reportedCommitIds(paneText: string): string[] {
  const ids = paneText
    .split("\n")
    .filter((line) => /\b(commit(?:ted)?|sha)\b/i.test(line))
    .flatMap((line) => line.match(/\b[0-9a-f]{7,40}\b/gi) ?? []);
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}
