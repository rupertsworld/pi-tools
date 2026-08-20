# @rupertsworld/pi-runner

A job engine for the active [pi](https://github.com/earendil-works/pi-mono) session. The agent registers jobs — a **trigger** (`cron` / `once` / `now`) paired with an **action** (`prompt` / `command` / `subagent`) — and runner performs them on time, routing every result back into the conversation.

```sh
pi install npm:@rupertsworld/pi-runner
```

## Surface

Agent-callable tools (there is no human-facing command):

- `prompt` — schedule a message the agent acts on when it fires.
- `process` — run or schedule a shell command; output is delivered back.
- `subagent` — run or schedule an isolated, steerable `pi --mode rpc` child; its final answer is delivered back.
- `cancel` / `steer` / `peek` / `list` — manage jobs, redirect a running subagent, tail any job's log, see what's active.

Jobs persist per session (restored on `/resume`), every job keeps a full log under `runner/logs/`, and the footer shows `runner N scheduled · M running`. Cron evaluates in the host time zone by design. A `runner.json` in the agent home can gate which action kinds register — a locked-down session can run `prompt`-only.

`SPEC.md` is the authority on behavior.
