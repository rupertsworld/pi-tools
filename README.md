# pi-tools

Extensions for [pi](https://github.com/earendil-works/pi-mono), the minimal terminal coding agent. These packages grew out of using pi as a daily, always-on assistant: they give a live session a scheduler, an HTTP ingress, always-fresh context, and an ACP endpoint — each as an ordinary pi package you install into your own setup.

Each package is independently published to npm under the `@rupertsworld` scope and is **spec-driven**: its `SPEC.md` is the authority on desired behavior, written before the code and kept true to it.

## Packages

| Package | Description |
|---|---|
| [`@rupertsworld/pi-runner`](packages/pi-runner) | Job engine for the active session: schedule prompts, shell commands, and steerable subagents (`cron`/`once`/`now`), with per-job logs, `peek`, and persistence |
| [`@rupertsworld/pi-webhook`](packages/pi-webhook) | HTTP ingress for injecting messages into the receiving session — origin-allowlisted for browser senders, attach/detach lifecycle recorded in `webhook.json` |
| [`@rupertsworld/pi-dynamic-context`](packages/pi-dynamic-context) | Per-turn refresh of system prompt and context files, with `{{DATE}}`/`{{TIME}}`/`{{TZ}}`-style template variables |
| [`@rupertsworld/pi-acp`](packages/pi-acp) | ACP endpoint for driving a live pi session over a unix socket, plus a stdio↔socket relay bin |
| [`@rupertsworld/pi-http`](packages/pi-http) | Structured HTTP calling tool — typed requests, rendered responses, no curl quoting hazards |

## Install

```sh
pi install npm:@rupertsworld/pi-runner
pi install npm:@rupertsworld/pi-webhook
pi install npm:@rupertsworld/pi-dynamic-context
pi install npm:@rupertsworld/pi-acp
pi install npm:@rupertsworld/pi-http
```

For local development, install a package by path — pi references it in place, so edits go live on `/reload`:

```sh
pi install /path/to/pi-tools/packages/pi-runner
```

## Development

No build step: pi loads each extension's TypeScript directly. From the repo root:

```sh
npm install
npm test            # all workspace test suites
npm run typecheck   # strict tsc across packages
```

pi-runner and pi-dynamic-context also carry registration-level e2e tests that load the extension through a real pi session. For pi-dynamic-context there is additionally a manual live smoke (real model call, so not part of `npm test`) worth running after pi upgrades:

```sh
node scripts/smoke-dynamic-context.mjs
```

Time zones, by design: nothing in these packages takes a timezone setting — cron schedules and template variables evaluate in the host zone. The box's clock is the single source of truth.

These packages are young and move fast; the specs are the contract, and behavior not in a SPEC.md shouldn't be relied on.

## License

MIT
