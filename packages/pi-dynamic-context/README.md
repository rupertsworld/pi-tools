# @rupertsworld/pi-dynamic-context

Keeps a [pi](https://github.com/earendil-works/pi-mono) session's system prompt live and appends user-configured context files. It re-reads prompt resources before every agent turn, so edits and template values take effect without `/reload`.

```sh
pi install npm:@rupertsworld/pi-dynamic-context
```

## Template variables

The extension renders variables in `SYSTEM.md`, `APPEND_SYSTEM.md`, startup-loaded `AGENTS.md`/`CLAUDE.md` files, and configured additional files:

- `{{ DATE }}` — local date as `YYYY-MM-DD`
- `{{ TIME }}` — local time as `HH:mm:ss`
- `{{ TZ }}` — host IANA time zone, or its UTC offset when no name is available
- `{{ CWD }}` — session working directory

Whitespace inside the braces is optional. Unknown uppercase variable names warn once per session and remain unchanged. Other brace content is not treated as a token. Pi's default system prompt is not rendered.

## Additional context files

Declare files in `<agent-dir>/dynamic-context.json` and, for trusted projects, `<cwd>/<pi-config-dir>/dynamic-context.json` (`.pi` by default):

```json
{
  "files": [
    "docs/conventions.md",
    "~/notes/global-style.md",
    "/abs/path/also-fine.md"
  ]
}
```

Relative paths resolve from the agent directory for the global config and from the session working directory for the project config. Global files come first, followed by project files; duplicate resolved paths are included only at their first position.

Both configs and their files are re-read each turn. Readable files are appended to the system prompt in a `<dynamic_context>` section. A missing config is treated as empty, a malformed config warns once and is treated as empty, and an unreadable configured file warns once and is omitted for that turn.

## Refresh and status

Startup-loaded prompt and context files are re-read each turn. If one becomes unreadable, the extension warns once and keeps its last successfully read content. If a startup-loaded file was empty and later gains content, the extension warns once and suggests `/reload` to pick it up. Pi's startup discovery does not re-run, so a new `AGENTS.md` or `CLAUDE.md` still requires `/reload` or a new session.

`/dynamic-context` reports current variable values and the last-read result for startup-loaded and configured additional files.

Implementation constraint: exact-content substitution via `before_agent_start` — it never pattern-matches pi's prompt layout, and leaves pieces alone that another extension rewrote.

[`spec/pi-dynamic-context/index.md`](https://github.com/rupertsworld/pi-tools/blob/main/spec/pi-dynamic-context/index.md) is the authority on behavior.
