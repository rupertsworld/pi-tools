# pi-webhook

The webhook extension gives a running pi session an HTTP ingress. An external sender — a CLI, a script, a cron job, another agent — POSTs to a local URL, and the message is injected into the active session's main thread.

## Loading

pi-webhook is an ordinary pi package:

```sh
pi install npm:@telepath-computer/pi-webhook
```

It loads through the `packages` array of pi's settings like any other package. No pi fork, wrapper, or special launcher is required.

## Behavior

- Nothing listens until asked: the server starts only via `/webhook start`. There is no automatic startup.
- `/webhook start [port]` starts the server for the current session, on the configured bind and port unless a port argument overrides it. `/webhook stop` stops it. `/webhook status` (or bare `/webhook`) reports listen address, server state, and how to send.
- The server closes on `session_shutdown`. This covers `/new`, `/resume`, `/reload`, and exit: the server belongs to exactly one live session runtime at all times, and a replacement session does not inherit it — starting the webhook is an explicit act of the session that owns it.
- The server runs in-process: request handlers call pi's message-injection API directly on the running session. There is no separate daemon; if no pi session is running (or none has started the webhook), nothing is listening.
- `POST /message` with body `{"message": "..."}` injects the message into the session and responds `202` with a small JSON acknowledgement. A missing or empty message is a `400`. The request never waits for the agent's reply.
- Requests must send `Content-Type: application/json` (`415` otherwise) and must not carry an `Origin` header (`403`): browsers are not valid senders, which closes cross-origin injection from web pages without requiring auth. The body is capped at 1 MB (`413`).
- Injection uses pi's custom-message API (`pi.sendMessage`) with `customType: "webhook"` and `display: true`: the message is shown in the transcript, included in LLM context, and recorded as arriving via webhook rather than as user-typed input.
- If the agent is idle, the injection triggers a turn (`triggerTurn: true`). If the agent is streaming, the message queues as steering (`deliverAs: "steer"`).
- The webhook is session-local: one session owns the port. A `/webhook start` that cannot bind notifies and the session continues without the webhook. It does not crash.
- Sessions without command entry (print mode, RPC) cannot start the webhook. Automatic startup is deliberately not provided; ingress for headless runs is out of scope for now.

## Configuration

Configuration lives in `webhook.json` in the coding-agent home (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). The extension creates the file with defaults on first `/webhook start`; the user edits it to override.

Defaults: bind `127.0.0.1`, port `3729`.

An unreadable or invalid config warns and falls back to defaults.

There is no authentication: the server binds localhost only. Authentication is future work.

There is no CLI. Sending is a plain HTTP POST (`curl`).

## Status

`index.ts` implements this spec.
