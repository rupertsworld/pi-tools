# @rupertsworld/pi-webhook

An HTTP ingress for a running [pi](https://github.com/earendil-works/pi-mono) session. An external sender — a CLI, a cron job, a web app, another agent — POSTs to a local URL and the message lands in the receiving session (delivered politely: it never interrupts in-progress work).

```sh
pi install npm:@rupertsworld/pi-webhook
```

## Surface

- `/webhook attach [port]` — make **this** session the receiver (recorded as `sessionId` in `webhook.json`; reattaches automatically on resume/restart/reload).
- `/webhook detach` / `/webhook status` — release, or inspect state. The footer shows `webhook <addr>:<port>` while listening.
- `POST /message` with `{"message": "..."}` (JSON only, 1 MB cap) → `202`, injected into the session.

Configuration lives in `webhook.json` (`bind`, `port`, `allowedOrigins`). Browser senders are governed by the origin allowlist (server-side enforcement + CORS preflight; `"*"` supported). No token auth by design — bind address bounds machines, the allowlist bounds browser origins.

`SPEC.md` is the authority on behavior.
