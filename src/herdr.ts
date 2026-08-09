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

/** The herdr CLI binary; read lazily so tests can override via HERDR_BIN. */
function herdrBin(): string {
  return process.env.HERDR_BIN ?? "herdr";
}

/**
 * Herdr 0.8+ changed `agent start` from "launch a process" (0.7.x: --cwd/
 * --workspace/--no-focus) to "declare an existing pane as an agent"
 * (--kind KIND --pane ID). The 0.8 form also quotes every argument for the
 * interactive shell, so our `sh -c '... > log; echo $? > exit'` worker
 * scripts can no longer be launched through it. On 0.8+ we therefore start
 * workers via `pane split`/`pane list` + `pane run` instead.
 */
function herdrVersion(): string {
  const r = spawnSync(herdrBin(), ["--version"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return r.status === 0 ? (r.stdout || "").trim() : "";
}

/** True when the herdr CLI uses the 0.8+ agent API (or the version is unknown). */
export function usesNewAgentApi(version?: string): boolean {
  const v = version ?? herdrVersion();
  const m = v.match(/0\.(\d+)/);
  if (!m) return true; // unknown -> assume new API (the old one only exists in 0.7.x)
  return parseInt(m[1], 10) >= 8;
}

/** Run a herdr CLI command and return parsed JSON (or null for text commands). */
export function herdrJson<T>(args: string[]): T {
  const result = spawnSync(herdrBin(), args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`Failed to run ${herdrBin()} ${args[0]}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${herdrBin()} ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout || "").trim()}`
    );
  }
  return parseEnvelope<T>(result.stdout);
}

/** A structured herdr command that may fail with a non-zero exit (e.g. pane missing). */
function herdrMaybe(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(herdrBin(), args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ok: result.status === 0, output: result.stdout };
}

/**
 * Herdr 0.8+ worker launch: find or create a pane whose shell will run the
 * worker script, then submit the script via `pane run`.
 *
 * Note: unlike 0.7.x (where herdr auto-closes the pane when the process
 * exits), the pane here keeps its shell alive after the script finishes, so
 * completion is detected purely via the exit-code file and crash detection
 * (pane-gone) does not apply; cleanup closes the pane.
 */
function startAgentV8(opts: {
  name: string;
  argv: string[];
  cwd?: string;
  workspaceId?: string;
}): StartAgentResult {
  const { name, argv, cwd, workspaceId } = opts;

  // Extract the worker script. Workers are launched as sh -c '<script>';
  // the pane's interactive shell executes the script body directly.
  const script =
    argv.length === 3 && argv[0] === "sh" && argv[1] === "-c"
      ? argv[2]
      : argv.join(" ");

  let paneId: string;
  let wsId = workspaceId;
  if (wsId) {
    const listed = herdrJson<{ panes: Array<{ pane_id: string }> }>([
      "pane",
      "list",
      "--workspace",
      wsId,
    ]);
    const panes = listed.panes ?? [];
    if (panes.length === 0) {
      throw new Error(`startAgent (v8): no pane in workspace ${wsId}`);
    }
    paneId = panes[0].pane_id;
  } else if (cwd) {
    const split = herdrJson<{ pane: { pane_id: string; workspace_id: string } }>([
      "pane",
      "split",
      "--direction",
      "right",
      "--cwd",
      cwd,
    ]);
    paneId = split.pane.pane_id;
    wsId = split.pane.workspace_id;
  } else {
    throw new Error("startAgent (v8) requires a workspaceId or cwd");
  }

  const run = spawnSync(herdrBin(), ["pane", "run", paneId, script], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (run.status !== 0) {
    throw new Error(
      `${herdrBin()} pane run exited ${run.status}: ${(run.stderr || run.stdout || "").trim()}`
    );
  }

  return {
    paneId,
    workspaceId: wsId ?? "",
    tabId: "",
    terminalId: "",
    name,
  };
}

/** Real adapter backed by the herdr CLI. */
export const herdrAdapter: HerdrAdapter = {
  startAgent({ name, argv, cwd, workspaceId, focus }) {
    if (usesNewAgentApi()) {
      return startAgentV8({ name, argv, cwd, workspaceId });
    }

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

