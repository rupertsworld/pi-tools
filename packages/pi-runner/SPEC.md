# pi-runner

Runner schedules **prompts** to be injected into the active pi session. The agent registers a prompt together with a schedule — a cron expression or a one-shot future time — and when it fires, the prompt is injected into the current conversation and the agent acts on it.

This drives recurring, self-directed work: a morning review, a periodic check, a follow-up reminder. The agent schedules the prompt; runner delivers it on time, into the session it is running in.

## Loading

pi-runner is an ordinary pi package:

```sh
pi install npm:@telepath-computer/pi-runner
```

It loads through the `packages` array of pi's settings like any other package. It has no dependency on any other pi package.

## Scheduled prompts

A scheduled prompt is a **message** plus a **trigger**.

Triggers:

- **cron** — a 6-field cron expression (`second minute hour day-of-month month day-of-week`). Fires repeatedly. Example: `"0 0 9 * * 1-5"` = 9:00am every weekday. Evaluated in the trigger's optional `timeZone` (IANA name), or the host time zone if omitted.
- **once** — a single future time, either relative (`"+10m"`, `"+2h"`, `"+1d"`) or an absolute ISO timestamp (`"2026-07-24T09:00:00Z"`). Fires exactly once.

## Tools

Scheduled prompts are created and managed exclusively by the agent, through tools. There is no human-facing command.

### `schedule`

Register a scheduled prompt.

Input:

- `message` (string, required) — the prompt text to inject when the schedule fires.
- `trigger` (required), one of:
  - `{ "kind": "cron", "cron": "0 0 9 * * 1-5", "timeZone": "America/Los_Angeles" }` — `timeZone` optional, defaults to host zone
  - `{ "kind": "once", "at": "+10m" }` — relative or ISO

Returns: `{ jobId, message, trigger, nextRunAt }`.

Invalid input is returned as a tool error rather than silently accepted: an invalid or non-future one-shot time, an unparseable cron expression, and an invalid `timeZone` each fail the call. An invalid `timeZone` is rejected rather than falling back to the host zone, so a schedule never fires at an unintended wall-clock time.

### `cancel`

Stop a scheduled prompt. Input: `{ jobId }`. Returns whether a matching job was found and cancelled.

### `list`

List active scheduled prompts. Returns an array of `{ jobId, message, trigger, nextRunAt }`.

## Firing

When a schedule fires, runner injects the message into the active session:

```js
pi.sendMessage(
	{ customType: "runner", content: message, display: true },
	{ triggerTurn: true, deliverAs: "followUp" },
);
```

- `display: true` — the injected prompt appears in the transcript and enters the agent's context.
- `triggerTurn: true` — if the agent is idle, the injection starts a turn immediately.
- `deliverAs: "followUp"` — if the agent is mid-turn, the injection waits until the current turn finishes rather than interrupting it. A scheduled prompt never hijacks in-progress work.

A **cron** schedule fires each time its expression matches, until cancelled. A **once** schedule fires a single time, then is removed automatically.

## Session scope and persistence

Schedules belong to the session that created them. Each session owns its own set of scheduled prompts, so an independent session (say, a coding session with a 15-minute timer) and a long-lived session holding standing daily crons do not interfere.

Schedules persist per session, keyed by session id:

- Each session's jobs are stored in `~/.pi/agent/runner/<sessionId>.json` (under `$PI_CODING_AGENT_DIR`), where `<sessionId>` is the current session id (`ctx.sessionManager.getSessionId()`). One file per session, so concurrent sessions never write over each other.
- The file is written on every `schedule` and `cancel`.
- On `session_start`, runner reads the current session's file and reschedules its jobs. So `/resume` restores that session's schedules across restarts; `/new` starts empty; each resumed session restores exactly what it had.
- On `session_shutdown`, runner stops the in-memory timers but keeps the file — that is what survives.
- Each job stores only its definition (`jobId`, `message`, `trigger`); live `croner` timers are reconstructed on load.

On reload, a `once` job whose time already passed while the session was closed is dropped (a reminder firing hours late is noise). A `cron` job simply resumes its normal schedule — missed ticks are not caught up.

Runner is still session-scoped, not a daemon: cron and one-shot schedules only fire while their owning session is running, and a scheduled prompt needs a live session to inject into. Firing while no session is open remains out of scope (see [TODO.md](TODO.md)).

## Status

Scheduling and firing are implemented in `index.ts`, covered by unit tests plus an end-to-end test that loads the extension through a real pi session and validates the registered tool schemas. Per-session persistence (the "Session scope and persistence" section) is specified but not yet implemented.
