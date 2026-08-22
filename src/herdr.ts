/**
 * Herdr adapter for the ticket dispatcher.
 *
 * The dispatcher drives Herdr-managed Pi workers entirely through the
 * `herdr` CLI (client -> server socket). Keeping this behind a narrow
 * interface lets the dispatch state machine be unit-tested with a fake.
 *
 * Worker lifecycle facts this adapter relies on:
 * - `herdr agent start` returns the worker pane id.
 * - Herdr reports interactive Pi as `working` while handling a command and
 *   `idle` after it settles.
 * - Pane disappearance is treated as a worker crash.
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
    tabId?: string;
    /** Explicit pane (0.8+ path: the tab's root pane). */
    paneId?: string;
    focus?: boolean;
  }): StartAgentResult;
  /** True if the pane still exists in Herdr. */
  paneExists(paneId: string): boolean;
  /** Close a pane. Errors are swallowed (the pane may already be gone). */
  closePane(paneId: string): void;
  /** Send literal text to an agent (no Enter). */
  sendText(target: string, text: string): void;
  /** Send a key (e.g. "Enter") to a pane. */
  sendKey(paneId: string, key: string): void;
  /** Read recent pane content (plain text, may include TUI rendering). */
  readPane(paneId: string, lines?: number): string;
  /** True if the agent reports idle (started up, waiting for input). */
  waitAgentIdle(target: string, timeoutMs: number): boolean;
  /** Current agent status ("idle" | "working" | ...) or undefined if unknown/gone. */
  agentStatus(target: string): string | undefined;
  /** Create a dedicated workspace for a ticket's worker (legacy layout). */
  createWorkspace(opts: { label: string; cwd?: string }): { workspaceId: string };
  /** Close a workspace we created. Errors are swallowed. */
  closeWorkspace(workspaceId: string): void;
  /** Create a tab (with its root pane) in the dispatcher's workspace for a ticket. */
  createTab(opts: { label: string; cwd?: string }): { tabId: string; paneId: string };
  /** Close a tab we created. Errors are swallowed. */
  closeTab(tabId: string): void;
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
 * Herdr 0.8+ worker launch: the `agent start` CLI changed to
 * "declare an existing pane as an agent" (--kind KIND --pane ID). For an
 * interactive worker we create a pane (pane split --cwd) and then declare it
 * as a pi agent with no extra args, which starts `pi` in that pane. This
 * keeps herdr's agent detection + status reporting for both versions.
 */
function startAgentV8(opts: {
  name: string;
  cwd?: string;
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
}): StartAgentResult {
  const { name, cwd, workspaceId, tabId, paneId } = opts;

  // The 0.8 `agent start` targets an existing pane. With the per-ticket tab
  // layout the tab's root pane is provided by the dispatcher; otherwise fall
  // back to pane list (workspace) or pane split (cwd).
  let targetPaneId = paneId;
  let wsId = workspaceId;
  if (targetPaneId) {
    // nothing more to resolve
  } else if (wsId) {
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
    targetPaneId = panes[0].pane_id;
  } else if (cwd) {
    const split = herdrJson<{ pane: { pane_id: string; workspace_id: string } }>([
      "pane",
      "split",
      "--direction",
      "right",
      "--cwd",
      cwd,
    ]);
    targetPaneId = split.pane.pane_id;
    wsId = split.pane.workspace_id;
  } else {
    throw new Error("startAgent (v8) requires a workspaceId or cwd");
  }
  if (!targetPaneId) {
    throw new Error("startAgent (v8): could not resolve a target pane");
  }

  const result = herdrJson<{
    agent: {
      pane_id: string;
      workspace_id: string;
      tab_id: string;
      terminal_id: string;
      name: string;
    };
  }>(["agent", "start", name, "--kind", "pi", "--pane", targetPaneId]);

  return {
    paneId: result.agent.pane_id,
    workspaceId: result.agent.workspace_id,
    tabId: result.agent.tab_id,
    terminalId: result.agent.terminal_id,
    name: result.agent.name,
  };
}

/** Real adapter backed by the herdr CLI. */
export const herdrAdapter: HerdrAdapter = {
  startAgent({ name, argv, cwd, workspaceId, tabId, paneId, focus }) {
    if (usesNewAgentApi()) {
      return startAgentV8({ name, cwd, workspaceId, tabId, paneId });
    }

    const args = ["agent", "start", name];
    if (cwd) args.push("--cwd", cwd);
    if (workspaceId) args.push("--workspace", workspaceId);
    if (tabId) args.push("--tab", tabId);
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

  sendText(target, text) {
    const r = spawnSync(herdrBin(), ["agent", "send", target, text], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status !== 0) {
      throw new Error(
        `${herdrBin()} agent send exited ${r.status}: ${(r.stderr || r.stdout || "").trim()}`
      );
    }
  },

  sendKey(paneId, key) {
    herdrMaybe(["pane", "send-keys", paneId, key]);
  },

  readPane(paneId, lines = 80) {
    const r = spawnSync(
      herdrBin(),
      ["pane", "read", paneId, "--source", "recent", "--lines", String(lines)],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
    );
    if (r.status !== 0) return "";
    try {
      const parsed = JSON.parse(r.stdout);
      return parsed?.result?.read?.text ?? "";
    } catch {
      return r.stdout;
    }
  },

  waitAgentIdle(target, timeoutMs) {
    const r = spawnSync(
      herdrBin(),
      ["agent", "wait", target, "--status", "idle", "--timeout", String(timeoutMs)],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
    );
    if (r.status !== 0) return false;
    // `agent wait` returns exit 0 even when the target is not idle yet, so we
    // must inspect the reported agent_status ourselves.
    try {
      const parsed = JSON.parse(r.stdout);
      return parsed?.result?.agent?.agent_status === "idle";
    } catch {
      return false;
    }
  },

  agentStatus(target) {
    const r = spawnSync(herdrBin(), ["agent", "get", target], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status !== 0) return undefined;
    try {
      const parsed = JSON.parse(r.stdout);
      return parsed?.result?.agent?.agent_status;
    } catch {
      return undefined;
    }
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

  createTab({ label, cwd }) {
    const args = ["tab", "create", "--label", label];
    if (cwd) args.push("--cwd", cwd);
    const result = herdrJson<{
      tab: { tab_id: string };
      root_pane: { pane_id: string };
    }>(args);
    return { tabId: result.tab.tab_id, paneId: result.root_pane.pane_id };
  },

  closeTab(tabId) {
    if (!tabId) return;
    herdrMaybe(["tab", "close", tabId]);
  },
};

