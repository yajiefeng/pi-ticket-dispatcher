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
│  ├─ Dispatcher Pi
│  │  ├─ /skill:implement-tickets
│  │  └─ ticket_dispatch tool
│  ├─ Tab "ticket 01" ── interactive pi worker
│  └─ Tab "ticket 02" ── interactive pi worker (optional reviewer)
```

- **No daemon.** The extension registers one tool and does nothing at load
  time. All side effects happen inside `ticket_dispatch` calls.
- **Workers are interactive `pi` processes** launched by Herdr into per-ticket
  git worktrees, each in its own tab (`ticket <id>`) inside the Dispatcher's
  workspace — the workspace list stays clean. Workers start Pi with
  `-ne --approve`: project extensions are disabled inside generated worktrees
  and the user-selected repository is approved for this session, avoiding
  extension startup failures and an unattended trust prompt. Implementers run Matt's
  `/skill:implement`; optional reviewers run `/skill:code-review`. Herdr's
  `working` → `idle` transition indicates that a round settled. Implementers
  then pass only when the commit id they reported resolves to a new commit on
  the ticket branch and the worktree is clean; reviewers write a verdict file.
- **State lives in `<targetRepo>/.pi-ticket-dispatcher/state.json`** and is
  written atomically around every side effect, so interrupted runs resume
  cleanly (a vanished worker pane is detected and relaunched, counting as an
  attempt).

## Install

```bash
pi install /path/to/pi-ticket-dispatcher     # or git/npm source
```

Requires the `herdr` CLI on `PATH` (see [herdr.dev](https://herdr.dev)), a
configured Pi provider, and Matt's `implement` and `code-review` skills enabled
for the worker Pi processes.

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
| `cleanup` | Close panes, remove worktrees/branches for integrated (and optionally failed) tickets; remove worker artifacts and (optionally) all state. |

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
- **Crash recovery** — prompts and verdicts are per-round files (`round-N.*`),
  and a vanished worker pane is detected and relaunched, counting as a failed
  attempt.
- **Bounded fix loops** — `maxAttempts` caps implement + fix rounds; reviewers
  are capped the same way.
- **Safe integration** — merges are `--no-ff` into the base branch. Conflicts
  are auto-resolved: the ticket branch is rebased onto the base, and a worker
  resolves any remaining rebase conflicts; only after repeated failures does
  the run pause with `waiting_human`.
- **No age-based worker killing** — elapsed idle/working time never causes a
  live worker to be closed, relaunched, or charged an attempt. Automatic crash
  recovery requires the Herdr agent or pane to disappear.

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
- An implementer that does not report a valid new commit id from its round, or
  leaves a dirty tree, counts as a failed attempt (strict; retry/fail per
  `maxAttempts`).
- The state directory is added to the target repo's `.gitignore` on `start`.
- `waiting_human` is reserved for genuinely unresolvable situations such as
  repeated merge conflicts or a worker that fails to launch.

## Herdr version compatibility

Herdr **0.8+** changed `herdr agent start` from "launch a process"
(`--cwd/--workspace/--no-focus`, 0.7.x) to "declare an existing pane as an
agent" (`--kind KIND --pane ID`), and it shell-quotes all arguments, so worker
scripts can no longer be launched through it. The dispatcher detects the herdr
version automatically:

- **0.7.x** — workers are launched with `agent start <name> --cwd <worktree> -- pi`.
- **0.8+** — `agent start` changed to `--kind KIND --pane ID`; the dispatcher
  uses the ticket tab's root pane and declares it as a pi agent, which starts
  the same interactive worker.

Either way the worker is a real interactive `pi`, so Herdr reports
`working`/`idle` and the TUI is visible. Herdr status determines when a round
settles; reported commit verification or the reviewer verdict determines
whether it succeeded.
