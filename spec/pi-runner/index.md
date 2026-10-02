# pi-runner

Runner schedules **jobs** in the active pi session. The agent registers a job — a **trigger** (when) paired with an **action** (what) — and when the trigger fires, runner performs the action and routes any result back into the session.

Actions today are **prompt** (inject a message so the current agent acts on it), **command** (run a shell command and inject its output), and **subagent** (run isolated agent work and inject its result). This drives recurring, self-directed work: a morning review, a periodic check, an hourly `git fetch`, or a background investigation.

## Loading

pi-runner is an ordinary pi package:

```sh
pi install npm:@rupertsworld/pi-runner
```

It loads through the `packages` array of pi's settings like any other package. It has no dependency on any other pi package.

## Configuration

Runner reads `runner.json` from the coding-agent home (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) once, at extension load:

```json
{ "actions": ["prompt", "command", "subagent"] }
```

`actions` lists the action kinds whose creator tools register (the kind `command` is created by the `process` tool). A missing file or a missing `actions` field enables all three kinds. An empty array is valid: no creator tools register. An invalid config — an unreadable file, invalid JSON, a top-level value that isn't an object (a bare `["prompt"]` array is a forgotten `actions` wrapper, not a permission grant), `actions` not an array, or an entry that isn't one of the three kinds — enables `prompt` only and warns once at session start: a config file present at all signals a lock was intended, so failure falls toward the safe subset.

## Jobs

A job is a **trigger** (when) plus an **action** (what), with an optional **`deliverAs`** mode (how the result is delivered — pi's own `sendMessage` vocabulary). The three are independent — any action can run on any trigger with any delivery mode.

### Triggers (when)

- **cron** — `{ "kind": "cron", "cron": "0 0 9 * * 1-5" }`. A 6-field cron expression (`second minute hour day-of-month month day-of-week`), firing repeatedly (`"0 0 9 * * 1-5"` = 9:00am every weekday). Cron expressions always evaluate in the host time zone. There is deliberately no per-job time-zone option: the host's zone is the single source of truth, while an agent-settable option can pin individual jobs to stale or incorrect zones. An unparseable expression is rejected.
- **once** — `{ "kind": "once", "at": "+10m" }`. A single future time: relative (`"+10m"`, `"+2h"`, `"+1d"`) or absolute ISO (`"2026-07-24T09:00:00Z"`). Fires exactly once. A non-future or unparseable time is rejected.
- **now** — `{ "kind": "now" }`. Fires immediately on registration, once. Useful mainly with the `subagent` action ("go do this in the background right now"); valid with any action. A `now` job is never persisted — it fires and is gone.

### Actions (what)

- **prompt** — `{ "kind": "prompt", "message": "..." }`. Delivers `message` into the current session.
- **command** — `{ "kind": "command", "command": "...", "cwd": "..." }`. Runs `command` through a shell, captures its stdout/stderr and exit code, and delivers the result. `cwd` is optional and defaults to the pi process's working directory.
- **subagent** — `{ "kind": "subagent", "prompt": "...", "model": "...", "cwd": "...", "appendSystemPrompt": "...", "maxMinutes": 30 }`. Spawns a fresh, isolated pi agent (`pi --mode rpc`) that runs `prompt` in its own session, steerable while it runs; its final answer is delivered when it settles. Only `prompt` is required. `model` is a pi model pattern (as for `pi --model`); `cwd` defaults to the pi process's working directory; `appendSystemPrompt` appends to the child's system prompt; `maxMinutes` caps the run — at the deadline the child is killed and whatever final text exists is delivered with a timed-out note. Unset means no cap.

### Delivery (`deliverAs`)

`deliverAs` is an optional top-level string on the job, applying to any action. Its values are pi's `sendMessage` delivery modes, passed through:

- **`"followUp"`** *(default)* — the result enters the session and wakes the agent: if idle, a turn starts immediately (runner sets `triggerTurn: true`); if mid-turn, it waits for the current turn to finish, never interrupting.
- **`"nextTurn"`** — the result enters the transcript and the agent's context but does not trigger a turn; the agent sees it on its next natural turn.
- **`"steer"`** — the result is delivered mid-run, after the agent's current tool calls and before its next LLM call, redirecting in-progress work (`triggerTurn: true` when idle, so it behaves like `followUp` on an idle agent). Use only for jobs whose point is interruption.

There is deliberately no human-only "notify" mode: notifying a person is agent work over a real channel (a `prompt` action telling the agent to message you) or a `command` (e.g. `curl` to a push service), not a delivery mode.

## Tools

Jobs are created and managed exclusively by the agent, through tools. There is no human-facing command.

Three creator tools, one per action kind. Only the creators for kinds enabled in [Configuration](#configuration) register — a gated kind's tool is absent from the tool list entirely, not present-but-erroring. `steer` registers only when `subagent` is enabled (it is meaningless otherwise); `cancel`, `peek`, and `list` always register. Each creator returns `{ jobId, trigger, action, deliverAs, nextRunAt }` and takes an optional `deliverAs` (see [Delivery](#delivery-deliveras)). Rejected input (the "rejected" cases in the trigger definitions above) is returned as a tool error rather than silently accepted. The persisted job model stays `{ trigger, action, deliverAs }`; the tools are entry points over it, and the stored action kind for `process` remains `command` (existing persisted jobs load unchanged).

Pi's TypeBox validation permits unknown object fields. A creator call that still includes the removed `timeZone` field therefore passes schema validation, but runner ignores the field and stores only the canonical host-zone cron trigger. `timeZone` is absent from all creator schemas and is not part of the tool surface.

### `prompt`

Schedule a prompt. Input: `{ message, trigger, deliverAs? }` — `trigger` is **required** (an immediate prompt is pointless; scheduling is the point). Creates a job with action `{ kind: "prompt", message }`.

### `process`

Run or schedule a shell command. Input: `{ command, cwd?, trigger?, deliverAs? }` — `trigger` is optional and **defaults to `{ "kind": "now" }`**, so "run this command" just runs. Creates a job with action `{ kind: "command", ... }`.

### `subagent`

Run or schedule a subagent. Input: `{ prompt, model?, cwd?, appendSystemPrompt?, maxMinutes?, trigger?, deliverAs? }` — `trigger` optional, **defaults to `{ "kind": "now" }`**. Creates a job with action `{ kind: "subagent", ... }`.

### `cancel`

Stop a job. Input: `{ jobId }`. Returns whether a matching job was found and cancelled. Cancelling a job whose subagent (or command) is mid-run kills the child.

### `steer`

Redirect a running subagent. Input: `{ jobId, message }`. Forwards `message` to the child over pi's RPC `steer` command (delivered after the child's current tool calls, before its next LLM call). A tool error if the job doesn't exist, isn't a subagent, or isn't currently running.

### `peek`

Read a job's log. Input: `{ jobId, lines? }`, where `jobId` is a non-empty ID without path separators and `lines` is a positive integer — returns the last `lines` lines (default 50) of the job's log file, with details `{ jobId, lines, totalBytes }`. Works while the job is running and after it has finished. Unknown or invalid `jobId`, or a job with no log yet, is a tool error.

### `list`

List active jobs. Returns an array of `{ jobId, trigger, action, deliverAs, nextRunAt }`. Jobs whose action is currently executing (a running command or subagent) additionally report `running: true` and `startedAt`.

## Tool rendering

All seven tools set `renderShell: "self"` and define `renderCall`/`renderResult` in the house style — accent tool name, muted detail, no raw JSON in the transcript. Pi adds one blank row before the rendered output but does not add the default box, background, or vertical padding:

- **Calls** render as one line: the tool name plus a compact summary — a ~60-char preview of the prompt/message/command, the trigger as `now` / the relative time / the cron string, `maxMinutes` when set, jobIds as their first 8 characters. Examples: `subagent · "summarize the last 3 commits" · max 5m`, `process · git fetch --all · cron 0 */15 * * * *`, `steer · a7953fc5 · "focus on pi-tools only"`.
- **Results** render compact by default and fuller when expanded (the pi expanded rendering option): creators as a one-line confirmation with the short jobId and humanized next run (`· running` for now-jobs); `list` as one line per job (short id, kind, preview, next run, running age) instead of a JSON array; `cancel`/`steer` as one-line confirmations; failures in the error color.
- **`peek` result** renders as one muted line, `<N> log lines`, followed by the `app.tools.expand` key hint while collapsed. `N` is the number of returned log lines. Expanded rendering shows the log lines in the existing muted block. Errors keep the existing error rendering in both states.

## Delivered message rendering

Runner registers a message renderer for the `runner` custom message type. Pi adds one blank row before the component.

Collapsed rendering uses one or two lines:

- **subagent** — line 1 is a status glyph followed by muted `subagent · <first 8 characters of jobId> · <status> · <duration>` and the `app.tools.expand` key hint. Settled uses `✓` in the success color. Timed out uses `✗` in the warning color. Failed uses `✗` in the error color. Duration is calculated from `startedAt` and `endedAt` and rendered as `42s`, `4m 12s`, or `1h 3m`. Line 2 is the first non-empty report line after removing the trailing `Subagent …` status line, indented by two spaces and muted. Line 2 is omitted when the report has no body text.
- **command** — line 1 is `✓` in the success color for exit code zero or `✗` in the error color for a nonzero or null exit code, followed by muted `process · <first 8 characters of jobId> · exit <code> · <command preview>` and the expand hint. The command preview uses the same approximately 60-character limit as the call renderer. Line 2 is the last non-empty output line, indented by two spaces and muted. It comes from stderr when the exit code is nonzero and stderr contains text, and from stdout otherwise. Line 2 is omitted when the selected output is empty.
- **prompt** — one muted line, `prompt · <first 8 characters of jobId> · "<preview>"`, followed by the expand hint.
- **no details** — messages stored before delivery details were added render as one line: `runner` in the accent color, muted ` · <first non-empty content line>`, then the expand hint.

Every collapsed line is cut to one terminal row with `truncateToWidth` at render time.

Expanded rendering uses the same first line without the expand hint, then renders the full unchanged message `content` as Markdown. The Markdown component uses the horizontal `outputPad` supplied by pi.

## Firing

When a trigger fires, runner performs the action and produces a result:

- **prompt** — the result is the `message` itself.
- **command** — runner runs the command and the result is a message containing the command line, its exit code, and its captured stdout/stderr. The agent receives this result like any other delivered message — command output always feeds back into the session.
- **subagent** — runner spawns the child, runs the prompt to settlement, and the result is a message containing the child's final assistant text (plus a status line: settled, timed out, or failed). Subagent output always feeds back into the session.

### Command execution

- **Spawning** — the command runs via Node's `spawn(command, { shell: true, detached: true })`. Pi's exported local-bash backend (`createLocalBashOperations`) was considered and rejected: it merges stdout/stderr into one stream and does not expose the child process or PID, which this spec's separate-stream capture and process-tree kill require. Environment is inherited from the pi process; stdin is closed.
- **`cwd`** — defaults to the pi process's working directory. A `cwd` that doesn't exist at fire time produces a spawn-failure result (delivered normally) rather than a schedule-time error — the directory may legitimately exist later.
- **Overlap** — command jobs run with croner's `protect` option: a firing is skipped while the previous run of the same job is still executing, so a slow command under a fast cron never piles up.
- **Failure** — a nonzero exit delivers normally (the exit code is the news); a spawn failure delivers an error result the same way. A cron job keeps its schedule after failures.
- **Truncation** — each stream is capped (8 KiB); over the cap, the tail is kept — errors and summaries live at the end — with a marker noting how many bytes were dropped. The structured message `details` keeps the existing `command`, `exitCode`, `stdout`, `stderr`, and `truncated` fields and adds `kind: "command"` and `jobId`. Message `content` is unchanged. Pi stores `details` in the session for rendering and does not send it to the model.
- **Lifecycle** — a child still running at `session_shutdown`, or whose job is `cancel`led mid-run, is killed as a process tree (SIGTERM, short grace, SIGKILL). There is no per-command timeout yet; with overlap protection a hung command cannot pile up runs.

### Subagent execution

- **Spawning** — the child is `pi --mode rpc`, spawned like a command child (detached, env inherited, `cwd` from the action). It is deliberately **lean**: `--no-extensions --no-context-files`, so children carry no telegram/webhook/runner extensions (no port fights, no recursive scheduling) and no workspace context beyond what the prompt and `appendSystemPrompt` provide. `model` maps to `--model`. The child shares the coding-agent home, so provider auth works.
- **Protocol** — newline-delimited JSON over stdin/stdout (pi's RPC mode). Runner sends `{"type":"prompt","message":<prompt>}`, tracks events, and treats `agent_settled` as completion; the result text is the last assistant message of the run. `steer` tool calls forward as `{"type":"steer","message":...}`.
- **Completion** — on settle, deliver the final text and close the child. On child exit/error before settling, deliver a failure note. On `maxMinutes` expiry, kill the child and deliver whatever assistant text exists with a timed-out note. Delivery is suppressed for cancelled/shutdown children (same as commands).
- **Overlap** — like commands, cron-scheduled subagents use croner's `protect`: a firing is skipped while the previous run is still going.
- **Lifecycle** — running children are killed (process tree, SIGTERM → grace → SIGKILL) on `cancel` and `session_shutdown`. A `now`/`once` subagent job leaves the job list when its run finishes (`once` semantics); a cron subagent job stays scheduled.

The result is then delivered via `pi.sendMessage({ customType: "runner", content, display: true, details }, { deliverAs, triggerTurn })`. Delivery `details` depends on the action:

- **subagent** — `{ kind: "subagent", jobId, status, startedAt, endedAt }`, where `status` is `"settled"`, `"timed out"`, or `"failed"`, and both times are ISO strings. `startedAt` records when the child was spawned.
- **command** — the fields defined under [Command execution](#command-execution).
- **prompt** — `{ kind: "prompt", jobId }`.

Message `content` remains exactly the action result described under [Firing](#firing). Pi stores `details` in the session for rendering and does not send it to the model. `deliverAs` is the delivery mode of the job and `triggerTurn` is `true` for `followUp` and `steer` (pi ignores it for `nextTurn`). Runner does not expose `triggerTurn` as a separate job field: the unbundled combinations are degenerate for a scheduler (a `followUp` that never starts a turn is just a worse `nextTurn`), so each mode carries its only sensible pairing.

A **cron** job fires each time its expression matches, until cancelled. A **once** job fires a single time, then is removed automatically.

## Job logs

Every job appends a full log to `$PI_CODING_AGENT_DIR/runner/logs/<jobId>.log` — plain timestamped text lines, readable by the agent via `peek` and by a human via `cat`:

- **all jobs** — creation with a trigger summary and cancellation.
- **subagent** — spawn line (model and `cwd` when set), each `tool_execution_start` as a one-liner with the tool name and a compact argument summary, assistant text from `message_end`, steer messages, settle/timeout/failure/kill, and the delivered result.
- **command** — start line with command and `cwd`, the **full uncapped** stdout/stderr as it streams (delivery still truncates to its 8 KiB tails; the log holds everything), and the exit or kill status.
- **prompt** — a fired/delivered line, so `peek` is uniform across action kinds.

Each physical line starts with an ISO timestamp. Logs are append-only and never auto-deleted or rotated (rotation is future work — see [TODO.md](TODO.md)). Logging failures warn and continue; they never affect the job itself. To avoid notification spam when a path stays unwritable, runner emits one warning per job on its first failed log write and suppresses later log-write warnings for that job.

## Status line

Runner shows its state in pi's footer status (`ctx.ui.setStatus`): `runner 3 scheduled`, with ` · 1 running` appended (warning color) while any command or subagent is mid-run. The count covers **scheduled jobs only** (`cron`/`once`) — a running `now` job shows purely as `runner 1 running` with no scheduled count. The `runner` label uses the theme accent color and the count uses the success color, matching the telegram extension's status style. The status updates whenever the counts change — on load at `session_start`, job creation, `cancel`, a `once` job firing, and action start/finish — and is **cleared entirely when nothing is scheduled or running**, so sessions that don't use runner carry no footer noise. Sessions without a UI skip the status (guarded by `ctx.hasUI`).

## Session scope and persistence

Jobs belong to the session that created them. Each session owns its own set of jobs, so an independent session (say, a coding session with a 15-minute `git fetch`) and a long-lived session holding standing daily crons do not interfere.

Jobs persist per session, keyed by session id:

- Each session's jobs are stored in `~/.pi/agent/runner/<sessionId>.json` (under `$PI_CODING_AGENT_DIR`), where `<sessionId>` is the current session id (`ctx.sessionManager.getSessionId()`). One file per session, so concurrent sessions never write over each other.
- The file is written on every `schedule` and `cancel`.
- On `session_start`, runner reads the current session's file and reschedules its jobs. So `/resume` restores that session's jobs across restarts; `/new` starts empty; each resumed session restores exactly what it had.
- On `session_shutdown`, runner stops the in-memory timers (and kills any running command child) but keeps the file — that is what survives.
- Each job stores only its definition (`jobId`, `trigger`, `action`, `deliverAs`); live `croner` timers are reconstructed on load. A job persisted by an earlier version as a top-level `message` with no `action` is loaded as a `prompt` action with `followUp` delivery.
- A persisted cron trigger from an earlier version may still contain `timeZone`. Runner loads the job without that field, schedules it in the host time zone, and emits one warning per session regardless of how many stale jobs were found. Loading alone does not rewrite the file; the next normal persistence write stores the canonical trigger without `timeZone`.

On reload, a `once` job whose time already passed while the session was closed is dropped (a reminder firing hours late is noise). A `cron` job simply resumes its normal schedule — missed ticks are not caught up.

A persisted job whose action kind is gated by `runner.json` (see [Configuration](#configuration)) is likewise not restored: runner warns once, naming the dropped job(s), and removes them from the file on the next write. Restoring such a job inert would misreport in `list`; executing it would defeat the gate.

Runner is still session-scoped, not a daemon: jobs only fire while their owning session is running, and injecting a result needs a live session. Firing while no session is open remains out of scope (see [TODO.md](TODO.md)).

## Status

Everything in this spec is implemented in `index.ts`. Triggers (`cron`, `once`, `now`), actions (`prompt`, `command`, `subagent`), delivery modes, the `steer` and `peek` tools, job logs, running state, persistence, config-gated tool registration, and the status line are covered by unit tests (including a scripted RPC fake child exercising the real pipe/kill paths) and an end-to-end schema test through a real pi session.
