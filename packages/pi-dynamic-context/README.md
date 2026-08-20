# @rupertsworld/pi-dynamic-context

Keeps a [pi](https://github.com/earendil-works/pi-mono) session's context live. Vanilla pi reads `SYSTEM.md`, `APPEND_SYSTEM.md`, and context files (`AGENTS.md`/`CLAUDE.md`) once at startup; this extension re-reads them before **every agent turn**, so mid-session edits take effect without `/reload` — and renders template variables in your prompt files.

```sh
pi install npm:@rupertsworld/pi-dynamic-context
```

## Surface

- Template variables in `SYSTEM.md`/`APPEND_SYSTEM.md`: `{{DATE}}`, `{{TIME}}`, `{{TZ}}`, `{{AGENT_DIR}}`, `{{CWD}}` — re-rendered each turn, always in the host time zone (no configuration, by design). Unknown `{{VARS}}` warn once and stay verbatim.
- Context files are re-read from disk each turn; edited content replaces stale content. Discovery doesn't re-run — new files still need `/reload`.
- `/dynamic-context` — reports each variable's current value and each watched file's status.

Implementation constraint: exact-content substitution via `before_agent_start` — it never pattern-matches pi's prompt layout, and leaves pieces alone that another extension rewrote.

[`spec/pi-dynamic-context/index.md`](https://github.com/rupertsworld/pi-tools/blob/main/spec/pi-dynamic-context/index.md) is the authority on behavior.
