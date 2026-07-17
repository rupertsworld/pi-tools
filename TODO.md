# pi-tools TODO

Monorepo of pi packages. Each package is spec-driven — `SPEC.md` is authoritative.

## Packages

### pi-webhook — DONE
HTTP ingress for injecting messages into the active session. Command-driven lifecycle (`/webhook start [port] | stop | status`), no auto-start. Implemented, 24 tests passing. Installed into global `~/.pi/agent` via local path for live-edit use.

### pi-dynamic-context — IN PROGRESS
Per-turn refresh of system prompt + context files, with template variables (`{{DATE}}`, `{{TIME}}`, `{{TZ}}`, `{{AGENT_DIR}}`, `{{CWD}}`). Exact-content substitution via `before_agent_start` (no pi internals, no prompt-layout matching). SPEC written; implementation underway.

### runner — UNDER DISCUSSION (no spec yet)
Intended scope: run sub-agents AND general sub-processes, both one-off and on a schedule.

Open design question before any code:
- Prior art already installed and mature: `@tintinweb/pi-subagents` (subagents foreground/background/parallel/scheduled via cron/interval/one-shot + RPC bus) and `@aliou/pi-processes` (background subprocess manager, `/ps` panel). Together they cover most of the intended scope.
- Decision fork: **orchestrate** the existing packages (thin layer, unify UX, cheap) vs **replace** (own the codebase, reimplement a lot) vs **don't build**.
- Deeper fork: both existing packages are session-scoped (die on shutdown / reset on `/new`). If runner must deliver durable, cross-session cron + background-agent orchestration (pino's original kernel roadmap), that cannot be a pure extension — it wants a small persistent daemon with an in-session extension client. Decide session-scoped vs durable before designing.

Not decided: name, scope boundary, integrate-vs-replace, session-scoped-vs-durable. Do not author a runner SPEC until these are settled.

## Repo infrastructure
- Root `tsconfig.json` (strict, NodeNext, noEmit) + `npm run typecheck`.
- `npm test` fans out across workspaces (`--if-present`).
- `@earendil-works/pi-coding-agent` pinned as devDependency for types only (packages declare it as `*` peer).

## Not doing (yet)
- pi-setup / installer package — deferred.
- Context-file filtering in pi-dynamic-context — explicitly declined for now.
