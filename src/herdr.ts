/**
 * Herdr adapter for the ticket dispatcher.
 *
 * The dispatcher drives Herdr-managed Pi workers entirely through the
 * `herdr` CLI (client -> server socket). Keeping this behind a narrow
 * interface lets the dispatch state machine be unit-tested with a fake.
 *
 * Worker lifecycle facts this adapter relies on (verified empirically):
 * - `herdr agent start <name> --cwd <dir> --no-focus -- <argv>` returns a
 *   JSON envelope with the new pane id.
 * - When the started process exits, Herdr releases the agent and closes the
 *   pane. That is why workers write their output and exit code to files
 *   (via `sh -c` redirection) before the pane disappears.
 * - `herdr agent wait --status done` is a UI-only state; CLI completion
 *   waits use `idle`. We never rely on agent status: completion is detected
 *   by the exit-code file, crashes by a missing pane.
 */

import { spawnSync } from "node:child_process";

/** Result of starting a Herdr agent. */
export interface StartAgentResult {
  paneId: string;
  workspaceId: string;
  tabId: string;
  terminalId: string;
  name: string;
}

/** Narrow interface the dispatch state machine depends on. */
export interface HerdrAdapter {
  startAgent(opts: {
    name: string;
    argv: string[];
    cwd?: string;
    workspaceId?: string;
    focus?: boolean;
  }): StartAgentResult;
  /** True if the pane still exists in Herdr. */
  paneExists(paneId: string): boolean;
  /** Close a pane. Errors are swallowed (the pane may already be gone). */
  closePane(paneId: string): void;
  /** Create a dedicated workspace for a ticket's worker. */
  createWorkspace(opts: { label: string; cwd?: string }): { workspaceId: string };
  /** Close a workspace we created. Errors are swallowed. */
  closeWorkspace(workspaceId: string): void;
}

/** Parse the herdr CLI JSON envelope: {"id":..., "result": {...}}. */
function parseEnvelope<T>(raw: string): T {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Herdr returned non-JSON output: ${raw.slice(0, 200)}`);
  }
  if (parsed && parsed.error) {
    const err = parsed.error as { code?: string; message?: string };
    throw new Error(`Herdr error ${err.code ?? ""}: ${err.message ?? JSON.stringify(err)}`);
  }
  return parsed?.result as T;
}

const HERDR_BIN = process.env.HERDR_BIN ?? "herdr";

/** Run a herdr CLI command and return parsed JSON (or null for text commands). */
export function herdrJson<T>(args: string[]): T {
  const result = spawnSync(HERDR_BIN, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`Failed to run ${HERDR_BIN} ${args[0]}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${HERDR_BIN} ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout || "").trim()}`
    );
  }
  return parseEnvelope<T>(result.stdout);
}

/** A structured herdr command that may fail with a non-zero exit (e.g. pane missing). */
function herdrMaybe(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(HERDR_BIN, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ok: result.status === 0, output: result.stdout };
}

/** Real adapter backed by the herdr CLI. */
export const herdrAdapter: HerdrAdapter = {
  startAgent({ name, argv, cwd, workspaceId, focus }) {
    const args = ["agent", "start", name];
    if (cwd) args.push("--cwd", cwd);
    if (workspaceId) args.push("--workspace", workspaceId);
    args.push(focus === false ? "--no-focus" : "--focus");
    args.push("--");
    args.push(...argv);

    const result = herdrJson<{
      agent: {
        pane_id: string;
        workspace_id: string;
        tab_id: string;
        terminal_id: string;
        name: string;
      };
    }>(args);

    return {
      paneId: result.agent.pane_id,
      workspaceId: result.agent.workspace_id,
      tabId: result.agent.tab_id,
      terminalId: result.agent.terminal_id,
      name: result.agent.name,
    };
  },

  paneExists(paneId) {
    if (!paneId) return false;
    // `herdr pane get` exits non-zero when the pane is gone (auto-closed).
    const { ok } = herdrMaybe(["pane", "get", paneId]);
    return ok;
  },

  closePane(paneId) {
    if (!paneId) return;
    herdrMaybe(["pane", "close", paneId]);
  },

  createWorkspace({ label, cwd }) {
    const args = ["workspace", "create", "--label", label, "--no-focus"];
    if (cwd) args.push("--cwd", cwd);
    const result = herdrJson<{ workspace: { workspace_id: string } }>(args);
    return { workspaceId: result.workspace.workspace_id };
  },

  closeWorkspace(workspaceId) {
    if (!workspaceId) return;
    herdrMaybe(["workspace", "close", workspaceId]);
  },
};

export { HERDR_BIN };
