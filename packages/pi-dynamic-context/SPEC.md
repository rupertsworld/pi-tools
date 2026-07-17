# pi-dynamic-context

Keeps the system prompt and context files live during a session. Vanilla pi reads `SYSTEM.md`, `APPEND_SYSTEM.md`, and context files (`AGENTS.md`/`CLAUDE.md`) once at startup; this extension re-reads them before every agent turn and renders template variables, so file edits and the passage of time take effect without restarting the session or running `/reload`.

## Loading

pi-dynamic-context is an ordinary pi package:

```sh
pi install npm:@telepath-computer/pi-dynamic-context
```

It loads through the `packages` array of pi's settings like any other package. No pi fork, wrapper, or special launcher is required.

## Template variables

Template variables render inside the user-owned system prompt files pi has loaded — `SYSTEM.md` and `APPEND_SYSTEM.md` (global or project). They never render inside pi's default system prompt or inside context files.

| Variable | Value |
|---|---|
| `{{DATE}}` | Current date, `YYYY-MM-DD` |
| `{{TIME}}` | Current time, `HH:mm:ss` |
| `{{TZ}}` | IANA time zone name (or a `UTC±HH:MM` offset when no name is known) |
| `{{AGENT_DIR}}` | The coding-agent home (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) |
| `{{CWD}}` | The directory the session is running in |

Variables render before each agent turn, so time and timezone changes take effect turn by turn without restart.

An unknown `{{NAME}}` token (uppercase letters, digits, and underscores inside double braces) warns once per session and is left verbatim in the prompt. The turn proceeds; a typo in a prompt file must not break the agent.

## Per-turn refresh

Before each agent turn:

- The system prompt files pi loaded at startup are re-read from disk. Edited content replaces the previously loaded content in the system prompt for that turn onward.
- Context files pi loaded at startup (`AGENTS.md`/`CLAUDE.md` at their discovered paths) are re-read from disk and their current content replaces the stale content.
- A watched file that has become unreadable warns once and its last successfully read content is kept.
- Discovery does not re-run: files that did not exist at session start are not picked up mid-session. Adding a new context file still requires `/reload` or a new session. Refresh changes file *content*, not the resource set.

## Mechanism constraints

- The extension works through pi's documented extension API: the `before_agent_start` event, its structured `systemPromptOptions` (custom prompt, appended prompt text, loaded context files with their paths), and the returned per-turn `systemPrompt`. To apply changes it substitutes exact previously-loaded content with fresh content inside the chained prompt — a dependency only on pi embedding file content verbatim, never on the rendered prompt's internal layout, section markers, or ordering, which are pi's business and change between pi versions.
- The extension composes with other `before_agent_start` extensions: it modifies only the parts of the prompt that come from the files it watches.

## Configuration

Configuration is optional. If `dynamic-context.json` exists in the coding-agent home (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`), it is read:

```json
{
	"timeZone": "America/Los_Angeles"
}
```

- `timeZone` — IANA time zone used for `{{DATE}}`, `{{TIME}}`, and `{{TZ}}`. Default: the host time zone.

The file is not created automatically; the defaults are usually right. An invalid config or invalid time zone warns and falls back to defaults.

## Command

The `/dynamic-context` command reports status: each template variable with its current value, and each watched file with its path and last-read result.

## Status

Spec only — not yet implemented. `index.ts` is a no-op stub.
