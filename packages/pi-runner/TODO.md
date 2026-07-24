# pi-runner — future work

`SPEC.md` covers what runner does today: `{trigger, action, deliverAs}` jobs with `cron`/`once`/`now` triggers and `prompt`/`command`/`subagent` actions, per-job logs + `peek`, per-session persistence, and rendered per-action tools. This doc holds intended expansions. None are built.

## More triggers

- **interval** — "every N elapsed time" (`"90m"`, `"45s"`), for periods that don't fit a cron expression. Cron covers wall-clock recurrence ("9am daily"); interval covers arbitrary elapsed durations. Kept out because the driving use is time-of-day recurrence, which is cron's job.

## Action options

- Per-command timeout (subagents have `maxMinutes`; commands have no cap).
- Subagent context options: inherit conversation context, richer tool restriction (`--tools`), session resume of finished children.
(A human-only "notify" action was considered and rejected — notifying a person is a `prompt` over a real channel or a `command` to a push service, not a delivery mode.)

## Log rotation

Job logs (`runner/logs/<jobId>.log`) are append-only with no rotation or size cap. A chatty cron job grows its file indefinitely; add rotation or a per-file cap when it starts to matter.

## Persistence

Implemented as specified in `SPEC.md` ("Session scope and persistence") — per-session files at `~/.pi/agent/runner/<sessionId>.json`, restored on `session_start`.

## Durable daemon (bigger fork)

A background process that outlives any session, so cron fires even when no pi is open. Only command/subagent actions are self-contained enough to run headless; prompt and result injection need a live session, so injected outputs would queue until a session attaches. This is the original pino "kernel" roadmap (cross-session cron + background-agent orchestration) and cannot be a pure extension.

## Misc

- Tool naming: resolved for creators (`prompt`/`process`/`subagent` are distinctive); `cancel`/`steer`/`peek`/`list` remain generic-ish — revisit only if a real collision appears.
