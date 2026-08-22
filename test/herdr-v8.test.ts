/**
 * Tests for the Herdr 0.8+ adapter path (startAgentV8), driven through a
 * fake `herdr` CLI that mimics the 0.8.0 command surface:
 *   agent start -> --kind/--pane form (declares an existing pane as an agent)
 *   pane list --workspace / pane split --cwd / pane get / pane close
 *   workspace create/close
 *
 * The fake records the argv it receives so we can assert exactly what the
 * adapter sends on 0.8+ (pane list for an existing workspace, pane split as a
 * fallback, then agent start --kind pi --pane <id>).
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
  agent)
    case "$2" in
      start) echo "CALL:$*" >> "$FAKE_LOG"; echo '{"id":"cli:agent:start","result":{"agent":{"pane_id":"w9:p1","workspace_id":"w9","tab_id":"w9:t1","terminal_id":"term_x","name":"ticket-x-impl-1"},"argv":["pi"],"type":"agent_started"}}'; exit 0;;
      wait)   echo "CALL:$*" >> "$FAKE_LOG"; echo '{"id":"cli:agent:wait","result":{"agent":{"agent_status":"idle"},"type":"ok"}}'; exit 0;;
      prompt) echo "CALL:$*" >> "$FAKE_LOG"; echo '{"id":"cli:agent:prompt","result":{"type":"ok"}}'; exit 0;;
    esac;;
  pane)
    case "$2" in
      list)   echo "CALL:$*" >> "$FAKE_LOG"; echo '{"id":"cli:pane:list","result":{"panes":[{"pane_id":"w9:p1","workspace_id":"w9"}]},"type":"pane_list"}'; exit 0;;
      split)  echo "CALL:$*" >> "$FAKE_LOG"; echo '{"id":"cli:pane:split","result":{"pane":{"pane_id":"w9:p2","workspace_id":"w9"}},"type":"pane_info"}'; exit 0;;
      get)    echo '{"id":"cli:pane:get","result":{"pane":{"pane_id":"w9:p1"}}}'; exit 0;;
      close)  echo '{"id":"cli:pane:close","result":{"type":"ok"}}'; exit 0;;
      send-keys) echo '{"id":"cli:pane:send-keys","result":{"type":"ok"}}'; exit 0;;
      read)   echo '{"id":"cli:pane:read","result":{"read":{"text":"pi tui placeholder"}}}'; exit 0;;
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

function calls(): string[] {
  return fs.readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
}

test("v8 adapter: existing workspace -> pane list + agent start --kind pi --pane", () => {
  installFakeHerdr();
  const result = herdrAdapter.startAgent({
    name: "ticket-x-impl-1",
    argv: ["pi", "-ne", "--approve"],
    cwd: "/tmp/wt",
    workspaceId: "w9",
    focus: false,
  });
  assert.equal(result.paneId, "w9:p1");
  assert.equal(result.workspaceId, "w9");
  const callsList = calls();
  assert.ok(callsList[0].includes("pane list --workspace w9"), callsList[0]);
  assert.ok(
    callsList[1].includes("agent start ticket-x-impl-1 --kind pi --pane w9:p1 -- -ne --approve"),
    callsList[1]
  );
});

test("v8 adapter: waits with the current --until flags", () => {
  installFakeHerdr();
  assert.equal(herdrAdapter.waitAgentIdle("ticket-x-impl-1", 5000), true);
  assert.deepEqual(calls(), [
    "CALL:agent wait ticket-x-impl-1 --until idle --until done --timeout 5000",
  ]);
});

test("v8 adapter: submits prompts atomically with agent prompt", () => {
  installFakeHerdr();
  herdrAdapter.submitPrompt("ticket-x-impl-1", "w9:p1", "do the ticket");
  assert.deepEqual(calls(), ["CALL:agent prompt ticket-x-impl-1 do the ticket"]);
});

test("v8 adapter: no workspace -> pane split --cwd fallback then agent start", () => {
  installFakeHerdr();
  const result = herdrAdapter.startAgent({
    name: "ticket-y-impl-1",
    argv: ["pi"],
    cwd: "/tmp/wt2",
  });
  assert.equal(result.paneId, "w9:p1");
  assert.equal(result.workspaceId, "w9");
  const callsList = calls();
  assert.ok(callsList[0].includes("pane split --direction right --cwd /tmp/wt2"), callsList[0]);
  assert.ok(callsList[1].includes("agent start ticket-y-impl-1 --kind pi --pane w9:p2"), callsList[1]);
});

test("v8 adapter: pane list with no panes throws (-> waiting_human upstream)", () => {
  installFakeHerdr();
  const orig = fs.readFileSync(fakeBin, "utf-8");
  fs.writeFileSync(
    fakeBin,
    orig.replace(
      'list)   echo "CALL:$*" >> "$FAKE_LOG"; echo \'{"id":"cli:pane:list","result":{"panes":[{"pane_id":"w9:p1","workspace_id":"w9"}]},"type":"pane_list"}\'; exit 0;;',
      'list)   echo "CALL:$*" >> "$FAKE_LOG"; echo \'{"id":"cli:pane:list","result":{"panes":[],"type":"pane_list"}}\'; exit 0;;'
    ),
    { mode: 0o755 }
  );
  assert.throws(
    () =>
      herdrAdapter.startAgent({
        name: "ticket-z-impl-1",
        argv: ["pi"],
        cwd: "/tmp/wt3",
        workspaceId: "w9",
      }),
    /no pane in workspace w9/
  );
});

test("v8 adapter: retries agent_pane_busy while a new pane shell becomes ready", () => {
  installFakeHerdr();
  const orig = fs.readFileSync(fakeBin, "utf-8");
  const busyOnceFile = path.join(temp, "busy-once");
  fs.rmSync(busyOnceFile, { force: true });
  fs.writeFileSync(
    fakeBin,
    orig.replace(
      'start) echo "CALL:$*" >> "$FAKE_LOG"; echo \'{"id":"cli:agent:start","result":{"agent":{"pane_id":"w9:p1","workspace_id":"w9","tab_id":"w9:t1","terminal_id":"term_x","name":"ticket-x-impl-1"},"argv":["pi"],"type":"agent_started"}}\'; exit 0;;',
      `start) echo "CALL:$*" >> "$FAKE_LOG"; if [ ! -f "${busyOnceFile}" ]; then touch "${busyOnceFile}"; echo 'agent_pane_busy' >&2; exit 1; fi; echo '{"id":"cli:agent:start","result":{"agent":{"pane_id":"w9:p1","workspace_id":"w9","tab_id":"w9:t1","terminal_id":"term_x","name":"ticket-x-impl-1"},"argv":["pi"],"type":"agent_started"}}'; exit 0;;`
    ),
    { mode: 0o755 }
  );

  const result = herdrAdapter.startAgent({
    name: "ticket-x-impl-1",
    argv: ["pi"],
    cwd: "/tmp/wt",
    workspaceId: "w9",
  });

  assert.equal(result.paneId, "w9:p1");
  assert.equal(calls().filter((call) => call.includes("agent start")).length, 2);
});

test("v8 adapter: agent start failure throws", () => {
  installFakeHerdr();
  const orig = fs.readFileSync(fakeBin, "utf-8");
  fs.writeFileSync(
    fakeBin,
    orig.replace(
      'start) echo "CALL:$*" >> "$FAKE_LOG"; echo \'{"id":"cli:agent:start","result":{"agent":{"pane_id":"w9:p1","workspace_id":"w9","tab_id":"w9:t1","terminal_id":"term_x","name":"ticket-x-impl-1"},"argv":["pi"],"type":"agent_started"}}\'; exit 0;;',
      'start) echo "boom" >&2; exit 1;;'
    ),
    { mode: 0o755 }
  );
  assert.throws(
    () =>
      herdrAdapter.startAgent({
        name: "ticket-z-impl-1",
        argv: ["pi"],
        cwd: "/tmp/wt4",
        workspaceId: "w9",
      }),
    /agent start/
  );
});
