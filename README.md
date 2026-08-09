# Pi Ticket Dispatcher

A [Pi](https://pi.dev) package that implements approved **to-tickets** output by
dispatching tickets to **Herdr-managed Pi workers**: implement, review, fix,
integrate, unlock dependents, recover from interruptions, and clean up.

A dedicated Parent Pi is the **Dispatcher**. The user invokes
`/skill:implement-tickets`; the skill drives a single deep `ticket_dispatch`
tool that owns all state transitions, idempotency, and crash recovery.

## Architecture

```text
Herdr
├─ Dispatcher workspace
│  └─ Dispatcher Pi
│     ├─ /skill:implement-tickets
│     └─ ticket_dispatch tool
├─ Ticket 01 worktree workspace   ── worker: pi -p (one-shot implementer)
└─ Ticket 02 worktree workspace   ── worker: pi -p (implementer + optional reviewer)
```

- **No daemon.** The extension registers one tool and does nothing at load
  time. All side effects happen inside `ticket_dispatch` calls.
- **Workers are one-shot `pi -p` processes** launched by Herdr into per-ticket
  git worktrees (each in its own Herdr workspace). They write their output and
  exit code to files because Herdr closes the pane when the process exits.
- **State lives in `<targetRepo>/.pi-ticket-dispatcher/state.json`** and is
  written atomically around every side effect, so interrupted runs resume
  cleanly (interrupted workers are detected and relaunched, counting as an
  attempt).

## Install

```bash
pi install /path/to/pi-ticket-dispatcher     # or git/npm source
```

Requires the `herdr` CLI on `PATH` (see [herdr.dev](https://herdr.dev)) and a
configured Pi provider for the workers.

## Usage

1. Produce approved **to-tickets** output (or run the `to-tickets` skill first
   and get the tickets approved).
2. Invoke the skill:
   ```
   /skill:implement-tickets <to-tickets output or file path>
   ```
3. The Dispatcher Pi runs:
   ```
   ticket_dispatch action=start targetRepo=<repo> ticketsSource=<...>
   ticket_dispatch action=advance targetRepo=<repo> waitMs=60000   # repeat
   ticket_dispatch action=cleanup targetRepo=<repo>
   ```

### Actions

| Action | Purpose |
|---|---|
| `start` | Validate repo, parse tickets, init + persist state (gitignores `.pi-ticket-dispatcher/`). |
| `resume` | Load existing state (clears `paused`). |
| `advance` | One bounded, idempotent progression: reap finished workers → integrate ready branches → launch new workers (up to `maxParallel`); optionally waits up to `waitMs` for the next observable event. |
| `status` | Report state, no side effects. |
| `resolve` | Answer a `waiting_human` decision: `retry_launch`, `fail_ticket`, or `cancel_run`. |
| `cleanup` | Close panes, remove worktrees/branches for integrated (and optionally failed) tickets; remove worker logs and (optionally) all state. |

### Options

- `baseBranch` — branch to integrate into (default: current branch)
- `maxParallel` — concurrent workers (default 2)
- `useReviewer=true` — external review round per implementation (bounded fix loop)
- `maxAttempts` — implementation + fix attempts per ticket (default 3)
- `waitMs` — per-`advance` wait window (default 60s, max 10min, `0` = no wait)
- `ticketIds` — restrict `advance` to specific tickets

## What the Dispatcher guarantees

- **Deterministic transitions** — ticket status is a typed state machine; the
  model cannot corrupt it (see `src/types.ts`, `src/state.ts`).
- **Idempotent progress** — `advance` always reloads state; repeated calls are
  safe. Worktree/worker creation is deduplicated by canonical path / pane id.
- **Crash recovery** — worker artifacts are per-round files (`round-N.*`) so a
  crashed worker can never corrupt a live one; a pane that vanished without an
  exit file is detected and relaunched, counting as a failed attempt.
- **Bounded fix loops** — `maxAttempts` caps implement + fix rounds; reviewers
  are capped the same way.
- **Safe integration** — merges are `--no-ff` into the base branch; conflicts
  pause the run with a `waiting_human` event instead of guessing.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # node --test (unit tests with a fake Herdr + real git)
node test/integration.mjs   # manual end-to-end run against real Herdr + pi workers
```

## Layout

```
extensions/ticket-dispatch/index.ts   # registers the ticket_dispatch tool
skills/implement-tickets/SKILL.md     # user-invoked skill
src/dispatch.ts                       # state machine (start/advance/resolve/cleanup)
src/herdr.ts                          # Herdr CLI adapter (narrow, fakeable)
src/workers.ts                        # worker prompts, artifacts, verdict parsing
src/state.ts                          # durable state + valid transitions
src/git.ts                            # worktrees, branches, merge integration
src/tickets.ts                        # to-tickets parsing (JSON/markdown/text)
src/types.ts                          # ticket/state/event types
```

## Notes and limitations (V1)

- Workers use whatever provider/model the Dispatcher Pi is configured with.
- A worker that commits nothing, exits non-zero, or leaves a dirty tree counts
  as a failed attempt (strict; retry/fail per `maxAttempts`).
- No rebasing of ticket branches onto a moved base before merging; conflicts
  surface at integration time as `waiting_human`.
- The state directory is added to the target repo's `.gitignore` on `start`.

## Herdr version compatibility

Herdr **0.8+** changed `herdr agent start` from "launch a process"
(`--cwd/--workspace/--no-focus`, 0.7.x) to "declare an existing pane as an
agent" (`--kind KIND --pane ID`), and it shell-quotes all arguments, so worker
scripts can no longer be launched through it. The dispatcher detects the herdr
version automatically:

- **0.7.x** — workers are launched with `agent start`; Herdr auto-closes the
  pane when the worker exits, so crashes are detected by a vanished pane.
- **0.8+** — workers are launched via `pane split --cwd` (or an existing
  ticket workspace's pane) + `pane run <script>`. The pane's shell stays
  alive after the script exits, so completion is detected purely via the
  exit-code file and crash detection is not available on this path; worker
  panes are closed by `cleanup`.
