# pi-runner

Runner schedules **jobs** in the active pi session. The agent registers a job — a **trigger** (when) paired with an **action** (what) — and when the trigger fires, runner performs the action and routes any result back into the session.

Actions today are **prompt** (inject a message so the current agent acts on it) and **command** (run a shell command and inject its output). This drives recurring, self-directed work: a morning review, a periodic check, an hourly `git fetch`.

## Loading

pi-runner is an ordinary pi package:

```sh
pi install npm:@telepath-computer/pi-runner
```

It loads through the `packages` array of pi's settings like any other package. It has no dependency on any other pi package.

## Jobs

A job is a **trigger** (when) plus an **action** (what), with an optional **`deliverAs`** mode (how the result is delivered — pi's own `sendMessage` vocabulary). The three are independent — any action can run on any trigger with any delivery mode.

### Triggers (when)

- **cron** — `{ "kind": "cron", "cron": "0 0 9 * * 1-5", "timeZone": "America/Los_Angeles" }`. A 6-field cron expression (`second minute hour day-of-month month day-of-week`), firing repeatedly (`"0 0 9 * * 1-5"` = 9:00am every weekday). `timeZone` (IANA name) is optional and defaults to the host zone; an invalid zone is **rejected** rather than falling back, so a schedule never fires at an unintended wall-clock time. An unparseable expression is rejected.
- **once** — `{ "kind": "once", "at": "+10m" }`. A single future time: relative (`"+10m"`, `"+2h"`, `"+1d"`) or absolute ISO (`"2026-07-24T09:00:00Z"`). Fires exactly once. A non-future or unparseable time is rejected.

### Actions (what)

- **prompt** — `{ "kind": "prompt", "message": "..." }`. Delivers `message` into the current session.
- **command** — `{ "kind": "command", "command": "...", "cwd": "..." }`. Runs `command` through a shell, captures its stdout/stderr and exit code, and delivers the result. `cwd` is optional and defaults to the pi process's working directory.

### Delivery (`deliverAs`)

`deliverAs` is an optional top-level string on the job, applying to any action. Its values are pi's `sendMessage` delivery modes, passed through:

- **`"followUp"`** *(default)* — the result enters the session and wakes the agent: if idle, a turn starts immediately (runner sets `triggerTurn: true`); if mid-turn, it waits for the current turn to finish, never interrupting.
- **`"nextTurn"`** — the result enters the transcript and the agent's context but does not trigger a turn; the agent sees it on its next natural turn.
- **`"steer"`** — the result is delivered mid-run, after the agent's current tool calls and before its next LLM call, redirecting in-progress work (`triggerTurn: true` when idle, so it behaves like `followUp` on an idle agent). Use only for jobs whose point is interruption.

There is deliberately no human-only "notify" mode: notifying a person is agent work over a real channel (a `prompt` action telling the agent to message you) or a `command` (e.g. `curl` to a push service), not a delivery mode.

## Tools

Jobs are created and managed exclusively by the agent, through tools. There is no human-facing command.

### `schedule`

Register a job. Input: a `trigger` (see [Triggers](#triggers-when)) and an `action` (see [Actions](#actions-what)), both required, plus an optional `deliverAs` (see [Delivery](#delivery-deliveras)). Returns `{ jobId, trigger, action, deliverAs, nextRunAt }`. Rejected input (the "rejected" cases in the trigger definitions above) is returned as a tool error rather than silently accepted.

### `cancel`

Stop a job. Input: `{ jobId }`. Returns whether a matching job was found and cancelled.

### `list`

List active jobs. Returns an array of `{ jobId, trigger, action, deliverAs, nextRunAt }`.

## Firing

When a trigger fires, runner performs the action and produces a result:

- **prompt** — the result is the `message` itself.
- **command** — runner runs the command and the result is a message containing the command line, its exit code, and its captured stdout/stderr. The agent receives this result like any other delivered message — command output always feeds back into the session.

### Command execution

- **Spawning** — the command runs via Node's `spawn(command, { shell: true, detached: true })`. Pi's exported local-bash backend (`createLocalBashOperations`) was considered and rejected: it merges stdout/stderr into one stream and does not expose the child process or PID, which this spec's separate-stream capture and process-tree kill require. Environment is inherited from the pi process; stdin is closed.
- **`cwd`** — defaults to the pi process's working directory. A `cwd` that doesn't exist at fire time produces a spawn-failure result (delivered normally) rather than a schedule-time error — the directory may legitimately exist later.
- **Overlap** — command jobs run with croner's `protect` option: a firing is skipped while the previous run of the same job is still executing, so a slow command under a fast cron never piles up.
- **Failure** — a nonzero exit delivers normally (the exit code is the news); a spawn failure delivers an error result the same way. A cron job keeps its schedule after failures.
- **Truncation** — each stream is capped (8 KiB); over the cap, the tail is kept — errors and summaries live at the end — with a marker noting how many bytes were dropped. The full structured result (command, exit code, truncated streams) also rides in the message `details`.
- **Lifecycle** — a child still running at `session_shutdown`, or whose job is `cancel`led mid-run, is killed as a process tree (SIGTERM, short grace, SIGKILL). There is no per-command timeout yet; with overlap protection a hung command cannot pile up runs.

The result is then delivered via `pi.sendMessage({ customType: "runner", content, display: true }, { deliverAs, triggerTurn })`, where `deliverAs` is the job's delivery mode and `triggerTurn` is `true` for `followUp` and `steer` (pi ignores it for `nextTurn`). Runner does not expose `triggerTurn` as a separate job field: the unbundled combinations are degenerate for a scheduler (a `followUp` that never starts a turn is just a worse `nextTurn`), so each mode carries its only sensible pairing.

A **cron** job fires each time its expression matches, until cancelled. A **once** job fires a single time, then is removed automatically.

## Session scope and persistence

Jobs belong to the session that created them. Each session owns its own set of jobs, so an independent session (say, a coding session with a 15-minute `git fetch`) and a long-lived session holding standing daily crons do not interfere.

Jobs persist per session, keyed by session id:

- Each session's jobs are stored in `~/.pi/agent/runner/<sessionId>.json` (under `$PI_CODING_AGENT_DIR`), where `<sessionId>` is the current session id (`ctx.sessionManager.getSessionId()`). One file per session, so concurrent sessions never write over each other.
- The file is written on every `schedule` and `cancel`.
- On `session_start`, runner reads the current session's file and reschedules its jobs. So `/resume` restores that session's jobs across restarts; `/new` starts empty; each resumed session restores exactly what it had.
- On `session_shutdown`, runner stops the in-memory timers (and kills any running command child) but keeps the file — that is what survives.
- Each job stores only its definition (`jobId`, `trigger`, `action`, `deliverAs`); live `croner` timers are reconstructed on load. A job persisted by an earlier version as a top-level `message` with no `action` is loaded as a `prompt` action with `followUp` delivery.

On reload, a `once` job whose time already passed while the session was closed is dropped (a reminder firing hours late is noise). A `cron` job simply resumes its normal schedule — missed ticks are not caught up.

Runner is still session-scoped, not a daemon: jobs only fire while their owning session is running, and injecting a result needs a live session. Firing while no session is open remains out of scope (see [TODO.md](TODO.md)).

## Status

Scheduling, firing, and per-session persistence are implemented for the generalized `{ trigger, action, deliverAs }` model, including **prompt** and **command** actions and the `followUp`, `nextTurn`, and `steer` delivery modes, with unit and end-to-end tests.
