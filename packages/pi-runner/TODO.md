# pi-runner — future work

`SPEC.md` covers what runner does today: schedule **prompts** into the active session (cron / once). This doc holds intended expansions. None are built.

## More triggers

- **interval** — "every N elapsed time" (`"90m"`, `"45s"`), for periods that don't fit a cron expression. Cron covers wall-clock recurrence ("9am daily"); interval covers arbitrary elapsed durations. Kept out of v1 because the driving use is time-of-day recurrence, which is cron's job.

## More actions

Generalize a scheduled job from "a prompt" to `{ trigger, action }`, adding:

- **command** — run a subprocess when the schedule fires; capture stdout/stderr and inject the result into the session. Kill any live child on `session_shutdown`.
- **subagent** — spawn a `pi --mode rpc` child that runs a prompt in its own isolated session; steerable while it runs (pi's RPC `steer`); inject its final result on `agent_settled`. A subagent is just a `pi` subprocess — no dependency on pi-subagents.

When actions are added, the `schedule` tool input generalizes from `{ message, trigger }` to `{ trigger, action }` with a `kind`-discriminated action. Agent-callable tools have no stored callers, so the signature change is cheap.

## Persistence

Specified in `SPEC.md` ("Session scope and persistence") — per-session files at `~/.pi/agent/runner/<sessionId>.json`, restored on `session_start`. Implementation in progress.

## Durable daemon (bigger fork)

A background process that outlives any session, so cron fires even when no pi is open. Only command/subagent actions are self-contained enough to run headless; prompt and result injection need a live session, so injected outputs would queue until a session attaches. This is the original pino "kernel" roadmap (cross-session cron + background-agent orchestration) and cannot be a pure extension.

## Misc

- Tool naming: `schedule` / `cancel` / `list` are generic and may collide with other extensions' tools; consider namespacing.
