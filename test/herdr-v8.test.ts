/**
 * Tests for the Herdr 0.8+ adapter path (startAgentV8), driven through a
 * fake `herdr` CLI that mimics the 0.8.0 command surface:
 *   agent start -> --kind/--pane form (rejected for our worker scripts)
 *   pane list --workspace / pane split --cwd / pane run / pane get / pane close
 *   workspace create/close
 *
 * The fake records the argv it receives so we can assert exactly what the
 * adapter sends on 0.8+ (pane list for an existing workspace, pane split as a
 * fallback, pane run with the raw worker script).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { herdrAdapter } from "../src/herdr.ts";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-v8-"));
const fakeBin = path.join(temp, "bin", "herdr");
const logFile = path.join(temp, "calls.log");

after(() => {
  fs.rmSync(temp, { recursive: true, force: true });
  delete process.env.HERDR_BIN;
});

function installFakeHerdr(): void {
  fs.rmSync(logFile, { force: true });
  fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
  fs.writeFileSync(
    fakeBin,
    `#!/bin/bash
FAKE_LOG="${logFile}"
case "$1" in
  --version) echo "herdr 0.8.0"; exit 0;;
  pane)
    case "$2" in
      list)  echo "PANERUN:$*" >> "$FAKE_LOG"; echo '{"id":"cli:pane:list","result":{"panes":[{"pane_id":"w9:p1","workspace_id":"w9"}]},"type":"pane_list"}'; exit 0;;
      run)   echo "PANERUN:$*" >> "$FAKE_LOG"; echo '{"id":"cli:pane:run","result":{"type":"ok"}}'; exit 0;;
      split) echo "PANERUN:$*" >> "$FAKE_LOG"; echo '{"id":"cli:pane:split","result":{"pane":{"pane_id":"w9:p2","workspace_id":"w9"}},"type":"pane_info"}'; exit 0;;
      get)   echo '{"id":"cli:pane:get","result":{"pane":{"pane_id":"w9:p1"}}}'; exit 0;;
      close) echo '{"id":"cli:pane:close","result":{"type":"ok"}}'; exit 0;;
    esac;;
  workspace)
    case "$2" in
      create) echo '{"id":"cli:workspace:create","result":{"workspace":{"workspace_id":"w9"},"root_pane":{"pane_id":"w9:p1"}},"type":"workspace_created"}'; exit 0;;
      close)  echo '{"id":"cli:workspace:close","result":{"type":"ok"}}'; exit 0;;
    esac;;
esac
echo "UNHANDLED: $*" >&2
exit 1
`,
    { mode: 0o755 }
  );
  process.env.HERDR_BIN = fakeBin;
}

const SCRIPT = `pi -p "$(cat "/tmp/wt/prompt.md")" > "/tmp/wt/round-1.log" 2>&1; echo $? > "/tmp/wt/round-1.exit"`;

function calls(): string[] {
  return fs.readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
}

test("v8 adapter: existing workspace -> pane list + pane run with the raw script", () => {
  installFakeHerdr();
  const result = herdrAdapter.startAgent({
    name: "ticket-x-impl-1",
    argv: ["sh", "-c", SCRIPT],
    cwd: "/tmp/wt",
    workspaceId: "w9",
    focus: false,
  });
  assert.equal(result.paneId, "w9:p1");
  assert.equal(result.workspaceId, "w9");
  const [listCall, runCall] = calls();
  assert.ok(listCall.includes("pane list --workspace w9"), `pane list call: ${listCall}`);
  assert.ok(runCall.includes("pane run w9:p1"), `pane run call: ${runCall}`);
  assert.ok(runCall.includes(SCRIPT), "script must be passed verbatim to pane run");
});

test("v8 adapter: no workspace -> pane split --cwd fallback then pane run", () => {
  installFakeHerdr();
  const result = herdrAdapter.startAgent({
    name: "ticket-y-impl-1",
    argv: ["sh", "-c", SCRIPT],
    cwd: "/tmp/wt2",
  });
  assert.equal(result.paneId, "w9:p2");
  assert.equal(result.workspaceId, "w9");
  const callsList = calls();
  assert.ok(callsList[0].includes("pane split --direction right --cwd /tmp/wt2"), callsList[0]);
  assert.ok(callsList[1].includes("pane run w9:p2"), callsList[1]);
});

test("v8 adapter: pane run failure throws (-> waiting_human upstream)", () => {
  installFakeHerdr();
  // Break pane run by making the fake fail on it.
  const orig = fs.readFileSync(fakeBin, "utf-8");
  fs.writeFileSync(
    fakeBin,
    orig.replace(
      'run)   echo "PANERUN:$*" >> "$FAKE_LOG"; echo \'{"id":"cli:pane:run","result":{"type":"ok"}}\'; exit 0;;',
      'run)   echo "PANERUN:$*" >> "$FAKE_LOG"; echo "boom" >&2; exit 1;;'
    ),
    { mode: 0o755 }
  );
  assert.throws(
    () =>
      herdrAdapter.startAgent({
        name: "ticket-z-impl-1",
        argv: ["sh", "-c", SCRIPT],
        cwd: "/tmp/wt3",
        workspaceId: "w9",
      }),
    /pane run exited 1/
  );
});

test("v8 adapter: agent start (0.8 form) is never used for workers", () => {
  // The fake has no agent-start handler; if the adapter ever tried the old
  // 0.7 form on a 0.8 CLI it would fail. The two tests above prove startAgent
  // routes through pane list/split + pane run, never "agent start".
  assert.equal(spawnSync(fakeBin, ["agent", "start", "x", "--cwd", "/tmp"], { encoding: "utf-8" }).status, 1);
});
