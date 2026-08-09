/**
 * Pi Ticket Dispatcher — tool-type extension.
 *
 * Registers a single deep `ticket_dispatch` tool that drives a deterministic
 * state machine for implementing approved tickets with Herdr-managed Pi
 * workers. The Parent Pi invokes this via /skill:implement-tickets.
 *
 * This extension is not a daemon: no timers, no background processes, no
 * workflow started at load time. All side effects happen inside tool calls.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { dispatch } from "../../src/dispatch.ts";
import { herdrAdapter } from "../../src/herdr.ts";

const ACTIONS = ["start", "resume", "advance", "status", "resolve", "cleanup"] as const;

const toolSchema = Type.Object(
  {
    action: StringEnum(ACTIONS, {
      description:
        "Which dispatcher action to run. " +
        "start initializes a run from to-tickets output. " +
        "resume loads existing state. " +
        "advance makes one bounded, idempotent progression (reap finished workers, integrate ready tickets, launch new workers) and optionally waits up to waitMs for the next observable event. " +
        "status reports state with no side effects. " +
        "resolve answers a waiting_human decision with a choice. " +
        "cleanup removes worktrees/panes/artifacts for integrated or failed tickets.",
    }),
    targetRepo: Type.String({
      description:
        "Absolute path to the target git repository where the tickets are implemented. State lives in <repo>/.pi-ticket-dispatcher/.",
    }),
    // start
    ticketsSource: Type.Optional(
      Type.String({
        description: "Raw to-tickets output (markdown task list, JSON array, or 'ID: title' lines).",
      })
    ),
    ticketsFile: Type.Optional(
      Type.String({ description: "Path to a file containing to-tickets output." })
    ),
    baseBranch: Type.Optional(
      Type.String({ description: "Base branch to integrate into (default: current branch)." })
    ),
    maxParallel: Type.Optional(
      Type.Integer({ description: "Max concurrent workers (default 2)." })
    ),
    useReviewer: Type.Optional(
      Type.Boolean({ description: "Run an external review round per implementation (default false)." })
    ),
    maxAttempts: Type.Optional(
      Type.Integer({ description: "Max implementation+fix attempts per ticket (default 3)." })
    ),
    // advance
    ticketIds: Type.Optional(
      Type.Array(Type.String(), {
        description: "Only advance these ticket ids (default: all).",
      })
    ),
    waitMs: Type.Optional(
      Type.Integer({
        description:
          "Max ms advance may wait for the next observable event (default 60000, max 600000, 0 = no waiting).",
      })
    ),
    // resolve
    choice: Type.Optional(
      Type.String({
        description:
          'For resolve: one of "retry_launch", "fail_ticket", "cancel_run". ' +
          "retry_launch retries a failed worker launch. " +
          "fail_ticket marks the given ticketId failed (use for merge conflicts). " +
          "cancel_run marks every non-terminal ticket cancelled and ends the run.",
      })
    ),
    ticketId: Type.Optional(
      Type.String({ description: "Ticket id for resolve fail_ticket." })
    ),
    // cleanup
    removeIntegrated: Type.Optional(
      Type.Boolean({ description: "Cleanup: remove integrated worktrees (default true)." })
    ),
    removeFailed: Type.Optional(
      Type.Boolean({ description: "Cleanup: also remove failed worktrees (default false)." })
    ),
    removeArtifacts: Type.Optional(
      Type.Boolean({ description: "Cleanup: remove worker logs/prompts (default true)." })
    ),
    removeState: Type.Optional(
      Type.Boolean({ description: "Cleanup: delete the entire dispatch state dir (default false)." })
    ),
  },
  { additionalProperties: false }
);

export default function ticketDispatchExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ticket_dispatch",
    label: "Ticket Dispatch",
    description:
      "Drive the ticket dispatcher: implements approved tickets with Herdr-managed Pi workers, " +
      "reviews their committed changes, runs bounded fix/review loops, integrates successful branches, " +
      "unlocks downstream tickets, and recovers interrupted runs. All state is persisted in " +
      "<targetRepo>/.pi-ticket-dispatcher/state.json and all actions are idempotent. " +
      "Typical flow: start (init from to-tickets output), then call advance repeatedly until the " +
      "run_completed / run_failed / waiting_human events appear, then resolve or cleanup as needed.",
    promptSnippet:
      "Drive ticket implementation with ticket_dispatch (start, then loop advance until terminal, then cleanup)",
    promptGuidelines: [
      "Use ticket_dispatch when the user asks to implement approved to-tickets output or invokes /skill:implement-tickets.",
      "Call ticket_dispatch with action start once, then loop action advance until you see run_completed, run_failed, or waiting_human. advance returns state_unchanged while workers run; keep calling it (it waits bounded).",
      "On waiting_human, ask the user which option to resolve with; never guess a destructive choice.",
    ],
    parameters: toolSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await dispatch(params as any, {
        herdr: herdrAdapter,
        signal: signal ?? ctx.signal,
      });

      const text = formatResult(result);
      return {
        content: [{ type: "text", text }],
        details: result as unknown as Record<string, unknown>,
      };
    },
  });
}

/** Render a DispatchResult as compact markdown for the model. */
function formatResult(result: {
  action: string;
  runStatus: string;
  events: Array<{ type: string; [k: string]: unknown }>;
  summary: Record<string, number>;
  tickets: Array<{ id: string; status: string; attempts: number; lastError?: string; worker?: { agentName: string; paneId: string } }>;
  message?: string;
}): string {
  const lines: string[] = [];
  lines.push(`## ticket_dispatch ${result.action} — run ${result.runStatus}`);

  if (result.message) lines.push(result.message);

  if (result.events.length > 0) {
    lines.push("", "### events");
    for (const ev of result.events) {
      const detail = Object.entries(ev)
        .filter(([k]) => k !== "type")
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(", ");
      lines.push(`- ${ev.type}${detail ? ` (${detail})` : ""}`);
    }
  }

  const statusLine = Object.entries(result.summary)
    .map(([s, n]) => `${s}: ${n}`)
    .join(", ");
  lines.push("", `### summary — ${statusLine}`);

  const active = result.tickets.filter((t) => t.status !== "integrated" && t.status !== "failed" && t.status !== "cancelled");
  if (active.length > 0) {
    lines.push("", "### active tickets");
    for (const t of active) {
      const worker = t.worker ? ` [${t.worker.agentName} pane ${t.worker.paneId}]` : "";
      lines.push(`- ${t.id} ${t.status}${worker}${t.lastError ? ` — ${t.lastError}` : ""}`);
    }
  }

  return lines.join("\n");
}
