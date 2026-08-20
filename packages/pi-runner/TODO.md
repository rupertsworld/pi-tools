# pi-runner — future work

`spec/pi-runner/index.md` covers what runner does today: `{trigger, action, deliverAs}` jobs with `cron`/`once`/`now` triggers and `prompt`/`command`/`subagent` actions, per-job logs + `peek`, per-session persistence, and rendered per-action tools. This doc holds intended expansions. None are built.

## Direction

- **Pure-scheduler trajectory.** Execution is migrating to environment capabilities (bellhop endpoints reached via pi-http); `command` and `subagent` are transitional conveniences for trusted sessions. Runner's irreplaceable half is injection — time → message into the session with delivery semantics. `runner.json` action gating (`spec/pi-runner/index.md`, Configuration) is how a locked-down session runs prompt-only today.
- **Multi-agent revisit trigger.** The scheduler stays in-session because the owning agent is one always-open session with a stable session id. A second long-lived agent is the point where a server-hosted (bellhop) cron becomes right and this decision gets reopened.

## More triggers

- **interval** — "every N elapsed time" (`"90m"`, `"45s"`), for periods that don't fit a cron expression. Cron covers wall-clock recurrence ("9am daily"); interval covers arbitrary elapsed durations. Kept out because the driving use is time-of-day recurrence, which is cron's job.

## Action options

- Per-command timeout (subagents have `maxMinutes`; commands have no cap).
- Subagent context options: inherit conversation context, richer tool restriction (`--tools`), session resume of finished children.
(A human-only "notify" action was considered and rejected — notifying a person is a `prompt` over a real channel or a `command` to a push service, not a delivery mode.)

## Log rotation

Job logs (`runner/logs/<jobId>.log`) are append-only with no rotation or size cap. A chatty cron job grows its file indefinitely; add rotation or a per-file cap when it starts to matter.

## Persistence

Implemented as specified in `spec/pi-runner/index.md` ("Session scope and persistence") — per-session files at `~/.pi/agent/runner/<sessionId>.json`, restored on `session_start`.

- Consider an instance- or global-scoped store for standing background jobs. Telegram follows the live Pi instance across session replacement, while runner currently leaves recurring jobs attached to the previous session. Define ownership, migration, duplicate prevention, and how prompt results attach to the active session.

## Durable daemon (bigger fork)

A background process that outlives any session, so cron fires even when no pi is open. Only command/subagent actions are self-contained enough to run headless; prompt and result injection need a live session, so injected outputs would queue until a session attaches. This is the original pino "kernel" roadmap (cross-session cron + background-agent orchestration) and cannot be a pure extension.

## Misc

- Tool naming: resolved for creators (`prompt`/`process`/`subagent` are distinctive); `cancel`/`steer`/`peek`/`list` remain generic-ish — revisit only if a real collision appears.
