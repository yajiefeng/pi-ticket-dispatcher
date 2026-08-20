---
name: implement-tickets
description: Implement approved to-tickets output by dispatching tickets to Herdr-managed Pi workers. Use when the user says "implement the tickets", invokes /skill:implement-tickets, or hands you approved to-tickets output to build.
---

# Implement Tickets

You are the **Dispatcher**. You drive a deterministic state machine through the
`ticket_dispatch` tool. Do not bypass the tool with raw bash/herdr commands —
state transitions, idempotency, and crash recovery live behind the tool.

## Input you need

The user must provide **approved to-tickets output** — either:

- pasted text (markdown task list, JSON array, or `ID: Title` lines), or
- a file path containing it.

If the user gave you a feature request/spec instead, run the `to-tickets`
skill first to produce the tickets, have them approved, then continue.

## The workflow

### 1. Start the run

```
ticket_dispatch action=start targetRepo=<abs path> ticketsSource=<to-tickets output>
```

or with a file:

```
ticket_dispatch action=start targetRepo=<abs path> ticketsFile=<path>
```

Optional start parameters:

- `baseBranch` — integrate into this branch (default: current branch).
- `maxParallel` — concurrent workers (default 2).
- `useReviewer=true` — add an external review round per implementation.
- `maxAttempts` — implementation+fix attempts per ticket (default 3).

### 2. Loop advance until a terminal event

```
ticket_dispatch action=advance targetRepo=<path> waitMs=60000
```

`advance` does one bounded progression: it reaps finished workers, integrates
ready tickets, launches new workers up to `maxParallel`, and waits up to
`waitMs` for the next observable event. Repeat it until you see one of:

| Event | Meaning | What to do |
|---|---|---|
| `worker_started` | A worker pane was launched (interactive pi, visible in Herdr with working/idle status) | keep advancing |
| `worker_retrying` | A worker round failed verification (no commit / dirty tree / no verdict) and the same worker was told to fix it | keep advancing |
| `implementation_ready` | Worker committed clean changes | keep advancing (review/integration follow) |
| `review_completed` | Reviewer verdict in | keep advancing |
| `ticket_integrated` | Branch merged into base, dependents unlocked | keep advancing |
| `ticket_failed` | Ticket exhausted its attempts | note it; other tickets continue |
| `state_unchanged` | No state change within the wait window | keep advancing; workers are still running |
| `conflict_resolved` | A merge/rebase conflict was auto-resolved | keep advancing |
| `waiting_human` | Rare: repeated merge conflicts, a repeatedly stalling worker, or launch failure | stop and ask the user |
| `run_completed` | All tickets terminal | proceed to step 4 |
| `run_failed` | Catastrophic run failure | report and stop |

Advance is safe to call repeatedly and is fully idempotent: it always reloads
state from disk, so an interrupted session can be resumed with `resume`.

### 3. Handle waiting_human

`advance` returns `waiting_human` (with `options`) when it needs a decision:

- **merge conflict** on integration — options `fail_ticket` or `cancel_run`.
- **failed to launch worker** — options `retry_launch`, `fail_ticket`, `cancel_run`.

Ask the user which option they want, then:

```
ticket_dispatch action=resolve targetRepo=<path> choice=fail_ticket ticketId=<id>
ticket_dispatch action=resolve targetRepo=<path> choice=cancel_run
ticket_dispatch action=resolve targetRepo=<path> choice=retry_launch
```

Never pick a destructive choice (`fail_ticket`, `cancel_run`) on your own.

### 4. Finish

When `run_completed` appears, clean up successful worktrees:

```
ticket_dispatch action=cleanup targetRepo=<path> removeIntegrated=true
```

`cleanup` closes worker panes, removes worktrees and branches, and deletes
worker logs. Failed-ticket worktrees are kept by default (`removeFailed=false`)
so a human can inspect them; pass `removeFailed=true` to remove them too, and
`removeState=true` to delete the run's state directory entirely.

Then report to the user: which tickets were integrated, which failed (and
why), and where the run's logs live (`<repo>/.pi-ticket-dispatcher/work/<id>/`).

## Resuming an interrupted run

If the Dispatcher Pi restarted mid-run:

1. `ticket_dispatch action=resume targetRepo=<path>` — loads state from disk.
2. Loop `advance` as above. Interrupted workers are detected by the tool
   (pane gone without an exit file → automatic relaunch, counting as an attempt).

## Rules

- Only `start` once. After that, `advance` is the only way forward.
- Workers are interactive `pi` processes: you can watch them work (and their
  Herdr working/idle status) in the Herdr UI. Each worker round is detected by
  a unique completion marker (DONE-<ID>-<round>) the worker replies with.
- Workers that are actively working are never timed out. A worker that sits
  idle for 30 minutes without completing is auto-restarted (twice); if it keeps
  stalling, the run pauses with `waiting_human`.
- Merge/rebase conflicts are auto-resolved (rebase, then a conflict worker);
  `waiting_human` only appears for genuinely unresolvable situations.
- Never launch workers yourself; `advance` handles parallelism and capacity.
- Keep calling `advance` when you see `state_unchanged` — that is the
  expected signal while workers run. Use a small `waitMs` (e.g. 60_000) so
  each call is bounded.
- Do not edit `<repo>/.pi-ticket-dispatcher/state.json` directly.
- If the user asks to stop everything, use `resolve choice=cancel_run`.
