# pi-dynamic-context

Keeps the system prompt live during a session and extends it with user-configured context files. Vanilla pi reads `SYSTEM.md`, `APPEND_SYSTEM.md`, and context files (`AGENTS.md`/`CLAUDE.md`) once at startup and offers no way to add other files to the system prompt. This extension re-reads all of them before every agent turn, renders template variables in them, and appends additional files declared in a config — so file edits, config edits, and the passage of time take effect without restarting the session or running `/reload`.

## Loading

pi-dynamic-context is an ordinary pi package:

```sh
pi install npm:@rupertsworld/pi-dynamic-context
```

It loads through the `packages` array of pi's settings like any other package. No pi fork, wrapper, or special launcher is required.

## Template variables

Template variables render in every piece the extension touches: the system prompt files pi has loaded (`SYSTEM.md` and `APPEND_SYSTEM.md`, global or project), the context files pi discovered (`AGENTS.md`/`CLAUDE.md`), and the additional context files described below. They never render inside pi's default system prompt.

| Variable | Value |
|---|---|
| `{{ DATE }}` | Current date in the host time zone, `YYYY-MM-DD` |
| `{{ TIME }}` | Current time in the host time zone, `HH:mm:ss` |
| `{{ TZ }}` | Host IANA time zone name (or a `UTC±HH:MM` offset when no name is known) |
| `{{ CWD }}` | The directory the session is running in |

Variables render fresh before each agent turn, so time and timezone changes take effect turn by turn without restart.

Date and time variables always use the host time zone. There is no extension-specific time zone configuration: the host is the single source of truth, avoiding a setting that can silently disagree with the rest of the system.

A token is `{{ NAME }}` where `NAME` is uppercase letters, digits, and underscores; whitespace inside the braces is tolerated. A token whose name is not in the table warns once per session and is left verbatim in the prompt — a typo in a prompt file must not break the agent. Brace content that does not match the token grammar (lowercase, punctuation, anything else) is not a token and passes through untouched with no warning, so code samples in watched files survive rendering byte-for-byte.

The syntax is Liquid-compatible on purpose: richer templating (filters, environment access, shell) can be added later without changing existing prompt files.

## Additional context files

Users declare extra files to inject into the system prompt in two optional config files:

- **Global**: `<agent-dir>/dynamic-context.json` (agent dir is `$PI_CODING_AGENT_DIR`, default `~/.pi/agent`)
- **Project**: `<cwd>/.pi/dynamic-context.json` (the `.pi` segment follows pi's `CONFIG_DIR_NAME`, so rebranded distributions work) — honored only when the project is trusted

Structure — an object with one key, leaving room to grow:

```json
{
  "files": [
    "docs/conventions.md",
    "~/notes/global-style.md",
    "/abs/path/also/fine.md"
  ]
}
```

Path resolution: `~/` expands to the home directory; absolute paths are used as-is; relative paths resolve against the config's own base — the project root (session cwd) for the project config, the agent dir for the global one. A path that resolves to the same absolute path more than once (listed twice, or in both configs) is injected once, at its first position.

Each turn, the readable configured files are appended to the end of the system prompt as one section, global files first, then project files, each in list order:

```
<dynamic_context>

Additional context files:

<context_file path="/abs/path/docs/conventions.md">
...file content, template variables rendered...
</context_file>

</dynamic_context>
```

The section is emitted only when at least one configured file is readable that turn. The `path` attribute is the resolved absolute path.

Failure behavior: a missing config file means no files from that source; a malformed config warns once per session and is treated as empty; a listed file that is missing or unreadable warns once per session and its block is omitted that turn.

## Per-turn refresh

Before each agent turn:

- The system prompt files pi loaded at startup are re-read from disk. Edited content replaces the previously loaded content in the system prompt for that turn onward.
- Context files pi loaded at startup (`AGENTS.md`/`CLAUDE.md` at their discovered paths) are re-read from disk and their current content replaces the stale content.
- A startup-loaded file that has become unreadable warns once and its last successfully read content is kept.
- A startup-loaded file that was empty when pi loaded it cannot be refreshed by substitution — there is no text to locate. When the extension finds such a file non-empty on disk, it warns once per file, naming the file and suggesting `/reload` to pick it up. (pi exposes its reload flow only to user-initiated commands, so the extension cannot reload automatically.)
- pi's own resource discovery does not re-run: startup-loaded files that did not exist at session start are not picked up mid-session, and adding a new `AGENTS.md` still requires `/reload` or a new session.
- Both `dynamic-context.json` configs and every file they list are re-read. The additional-files list is live: files or config entries added mid-session take effect on the next turn.

## Mechanism constraints

- The extension works through pi's documented extension API: the `before_agent_start` event, its structured `systemPromptOptions` (custom prompt, appended prompt text, loaded context files with their paths), and the returned per-turn `systemPrompt`. To refresh startup-loaded pieces it substitutes exact previously-loaded content with fresh content inside the chained prompt — a dependency only on pi embedding file content verbatim, never on the rendered prompt's internal layout, section markers, or ordering, which are pi's business and change between pi versions. The `<dynamic_context>` section is appended to the end of the chained prompt for the same reason: appending is the one placement that does not depend on pi's layout.
- Each piece claims one occurrence per turn: a piece takes its first occurrence in the prompt that does not overlap a region already claimed by another piece, so pieces with byte-identical loaded content update distinct occurrences rather than colliding on the first.
- The extension composes with other `before_agent_start` extensions: it modifies only the parts of the prompt that come from the files it watches, plus its own appended section. A piece whose loaded content is absent from the chained prompt (another extension rewrote it) is left alone.
- Two accepted limitations follow from exact-content matching: a watched file's full content coincidentally appearing in the prompt outside its own slot can be mis-targeted, and a prompt file edited between session start and the first agent turn is never path-matched, so it is not watched for that session (`/reload` recovers both). Locating pieces through pi's rendered layout would remove them, and is rejected per the first constraint above.

## Command

The `/dynamic-context` command reports status: each template variable with its current value, each startup-loaded watched file with its path and last-read result, and each configured additional file with its resolved path and last-read result.

## Status

Implemented in `index.ts`.
