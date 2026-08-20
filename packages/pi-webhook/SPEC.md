# pi-webhook

The webhook extension gives a running pi session an HTTP ingress. An external sender — a CLI, a script, a cron job, another agent — POSTs to a local URL, and the message is injected into the active session's main thread.

## Loading

pi-webhook is an ordinary pi package:

```sh
pi install npm:@rupertsworld/pi-webhook
```

It loads through the `packages` array of pi's settings like any other package. No pi fork, wrapper, or special launcher is required.

## Behavior

- There is exactly **one webhook**, described entirely by `webhook.json`: where it binds (`bind`, `port`), who may send (`allowedOrigins`), and **which session receives** (`sessionId`). Messages land in whichever session serves the port, so the receiver is explicit, recorded state — not a race.
- A session becomes the receiver by **attaching**: `/webhook attach [port]` writes the current session's id to `sessionId` in `webhook.json` (a port argument also updates `port` in the config — the config stays the single truth) and starts the server. `/webhook detach` stops the server and clears `sessionId`. `/webhook status` (or bare `/webhook`) reports listen address, server state, the attached session, and how to send.
- Attachment is **sticky**: on `session_start`, the session whose id matches `sessionId` starts the server automatically — `/resume`, restarts, and `/reload` bring the webhook back without re-typing. Other sessions never bind. Ephemeral sessions (`pi -p`, subagent children) have fresh ids and thus never match.
- Attaching from a new session takes over ownership in the config immediately; if the previous receiver is still live and holding the port, the bind fails with a notice (the old session releases it on shutdown or `/webhook detach`, after which the new owner's next `/webhook attach` — or its next `session_start` — binds). A failed bind never clears `sessionId`.
- The server closes on `session_shutdown` (covering `/new`, `/resume`, `/reload`, and exit); `sessionId` is left in place so the owning session reattaches when it returns.
- The server runs in-process: request handlers call pi's message-injection API directly on the running session. There is no separate daemon; if no pi session is running (or none has started the webhook), nothing is listening.
- `POST /message` with body `{"message": "..."}` injects the message into the session and responds `202` with a small JSON acknowledgement. A missing or empty message is a `400`. The request never waits for the agent's reply.
- Requests must send `Content-Type: application/json` (`415` otherwise). The body is capped at 1 MB (`413`).
- Browser senders are governed by an **origin allowlist** (`allowedOrigins` in config). A request carrying an `Origin` header is checked server-side against the allowlist: no match → `403`. Requests without an `Origin` header (curl, scripts, other agents) are unaffected. The server-side check — not CORS — is the enforcement, so a DNS-rebound page that looks same-origin to its browser is still rejected, and the JSON-only rule already blocks preflight-less "simple" browser requests.
- `OPTIONS /message` preflights are answered with `Access-Control-Allow-Origin`/`-Methods`/`-Headers` only for allowlisted origins (`204`), and `403` otherwise, so allowlisted web apps pass browser CORS while everything else is never sent.
- `allowedOrigins` defaults to empty — no browser origins allowed, equivalent to the previous blanket browser rejection. `"*"` allows any origin: on a tailnet-only bind this makes the tailnet itself the sole boundary.
- Injection uses pi's custom-message API (`pi.sendMessage`) with `customType: "webhook"` and `display: true`: the message is shown in the transcript, included in LLM context, and recorded as arriving via webhook rather than as user-typed input.
- If the agent is idle, the injection triggers a turn (`triggerTurn: true`). If the agent is mid-turn, the message waits until the current turn finishes (`deliverAs: "followUp"`) — an external message never interrupts in-progress work.
- The webhook is session-local: one session owns the port. A `/webhook attach` that cannot bind notifies and the session continues without the webhook. It does not crash.
- Sessions without command entry (print mode, RPC) cannot start the webhook. Automatic startup is deliberately not provided; ingress for headless runs is out of scope for now.
- The receiving session shows its attach state in pi's footer status (`ctx.ui.setStatus`), styled like the telegram/runner status chips (accent label, colored value, no colon): `webhook <bind>:<port>` with the address in the success color while listening, and `webhook port held` in the warning color when this session is attached but the bind failed (another session still holds the port). Sessions that are not attached show nothing — the status is cleared on detach and never set elsewhere. Updated on attach, detach, `session_start` reattach, bind failure, post-listen server error, and shutdown; skipped without a UI (`ctx.hasUI`).

## Configuration

Configuration lives in `webhook.json` in the coding-agent home (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). The extension creates the file with defaults on first `/webhook attach`; the user edits it to override. The `sessionId` field is written by attach/detach; the rest is user-owned.

Defaults: bind `127.0.0.1`, port `3729`, `allowedOrigins: []`, no `sessionId`.

- `bind` — set to a Tailscale IP to accept senders from other tailnet devices; the tailnet then authenticates machines.
- `allowedOrigins` — array of exact origins (scheme + host + port, e.g. `"http://100.101.102.103:8080"`) permitted as browser senders, or `["*"]` for any origin.

An unreadable or invalid config warns and falls back to defaults.

There is no token authentication, deliberately: machine access is bounded by the bind address (localhost or tailnet), and browser access by the origin allowlist. A token shipped to a browser app would be readable by anything that compromises that app, so it adds no boundary the allowlist doesn't.

There is no CLI. Sending is a plain HTTP POST (`curl`).

## Status

`index.ts` implements this spec.
