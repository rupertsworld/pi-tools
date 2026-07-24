# pi-tools

A monorepo of [pi](https://github.com/earendil-works/pi-mono) packages. Each package is independently published to npm under the `@telepath-computer` scope and is spec-driven: its `SPEC.md` is the authority on desired behavior.

## Packages

| Package | Description |
|---|---|
| [`@telepath-computer/pi-acp`](packages/pi-acp) | ACP endpoint for driving a live pi session over a unix socket |
| [`@telepath-computer/pi-runner`](packages/pi-runner) | Job engine for the active session: schedule prompts, shell commands, and steerable subagents (`cron`/`once`/`now`), with per-job logs, `peek`, and persistence |
| [`@telepath-computer/pi-webhook`](packages/pi-webhook) | HTTP ingress for injecting messages into the receiving session — origin-allowlisted for browser senders, attach/detach lifecycle recorded in `webhook.json` |
| [`@telepath-computer/pi-dynamic-context`](packages/pi-dynamic-context) | Per-turn refresh of system prompt and context files, with `{{DATE}}`/`{{TIME}}`/`{{TZ}}`-style template variables |

## Install

```sh
pi install npm:@telepath-computer/pi-runner
pi install npm:@telepath-computer/pi-webhook
pi install npm:@telepath-computer/pi-dynamic-context
pi install npm:@telepath-computer/pi-acp
```

For local development, install a package by path — pi references it in place, so edits go live on `/reload`:

```sh
pi install /root/dev/pi-tools/packages/pi-runner
```

## Development

No build step: pi loads each extension's TypeScript directly. From the repo root:

```sh
npm test            # all workspace test suites
npm run typecheck   # strict tsc across packages
```

Time zones, by design: nothing in these packages takes a timezone setting — cron schedules and template variables evaluate in the host zone. The box's clock is the single source of truth.
