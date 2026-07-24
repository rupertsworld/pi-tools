# pi-tools TODO

Monorepo of pi packages. Each package is spec-driven — `SPEC.md` is authoritative.

## Packages

### pi-webhook — DONE
HTTP ingress for injecting messages into the receiving session. Delivery is `followUp` (never interrupts, #6). Browser access via `allowedOrigins` in `webhook.json` — server-side origin enforcement + CORS preflight, `"*"` supported, no token by design (#7). Lifecycle is attach semantics: `/webhook attach [port] | detach | status`, receiver recorded as `sessionId` in `webhook.json`, auto-reattach on session start (#7). 33 tests. Rupert's install: bind `100.80.116.2`, `allowedOrigins ["*"]`; the Today artifact pings it on task check-off (convention in the tv-tasks skill).

### pi-dynamic-context — IN PROGRESS
Per-turn refresh of system prompt + context files, with template variables (`{{DATE}}`, `{{TIME}}`, `{{TZ}}`, `{{AGENT_DIR}}`, `{{CWD}}`). Exact-content substitution via `before_agent_start` (no pi internals, no prompt-layout matching). SPEC written; implementation underway.

### pi-runner — IMPLEMENTED (uncommitted, branch `pi-runner`)
Scoped to one thing: **schedule prompts to be injected into the active session**. Agent-callable tools `schedule` / `cancel` / `list`; triggers `cron` (6-field, `croner`, timezone-aware) and `once` (relative/ISO); fired prompts inject via `pi.sendMessage(..., {triggerTurn:true, deliverAs:"followUp"})`. Session-scoped, no daemon, in-memory. Full spec in `packages/pi-runner/SPEC.md`; deferred scope in `packages/pi-runner/TODO.md`.
- Implemented via codex (`gpt-5.6-sol`), test-first. Real TypeBox tool schemas via `@earendil-works/pi-ai` (peer dep). `croner` runtime dep.
- Tests: 12 pass across 3 suites — unit (stubbed pi) + an **e2e** that loads the extension through a real pi session (`createAgentSession` + `DefaultResourceLoader`) and validates the registered schemas via TypeBox `Value.Check`. Independently verified the e2e catches a plain-object schema regression. `tsc` clean.
- Invalid cron / invalid timeZone / past one-shot → tool error (SPEC reconciled to match).
- **Not committed** — awaiting go. Branch `pi-runner` is off `main`.

### pi-local-first (name TBD) — IDEA (no spec)
Use pi locally on your own machine, and keep pi state synced to remote machines, so you can move between local and remote and pick up where you left off. Sync mechanism tentative — CRDTs floated for conflict-free merge of concurrently-edited state ("or something").

Open questions before any design:
- **What state syncs**: sessions (append-mostly logs) vs settings (small JSON) vs auth vs skills vs the whole `PI_CODING_AGENT_DIR`. These have very different merge needs — sessions may only ever append; settings can genuinely conflict.
- **Merge model**: CRDT (heavy, true conflict-free) vs simpler options (git, last-writer-wins per file). Pick per state-type rather than one mechanism for all.
- **Transport**: Tailscale mesh is already the network between machines here — sync could ride it directly rather than a hosted service, keeping it local-first/self-hosted.
- Connects to: the earlier `PI_CODING_AGENT_DIR` state-isolation discussion, and the existing Tailscale topology.

## Repo infrastructure
- Root `tsconfig.json` (strict, NodeNext, noEmit) + `npm run typecheck`.
- `npm test` fans out across workspaces (`--if-present`).
- `@earendil-works/pi-coding-agent` pinned as devDependency for types only (packages declare it as `*` peer).

## Not doing (yet)
- pi-setup / installer package — deferred.
- Context-file filtering in pi-dynamic-context — explicitly declined for now.
