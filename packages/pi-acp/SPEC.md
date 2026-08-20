# pi-acp

The ACP extension gives a running pi session an [ACP](https://agentclientprotocol.com/) endpoint over a unix socket. An external ACP client — Television, an editor, any ACP-speaking host — attaches to the **same live session** the terminal is driving: prompts sent over the socket run in that session, and the session's streamed output and tool activity fan out to every attached client as well as the TUI. The package also ships `pi-acp`, a stdio↔socket relay for hosts that spawn their ACP agent as a subprocess.

## Loading

pi-acp is an ordinary pi package:

```sh
pi install npm:@rupertsworld/pi-acp
```

It loads through the `packages` array of pi's settings like any other package. No pi fork, wrapper, or special launcher is required.

The relay is the same package's npm bin. A machine that only attaches (for example, the one running a Television server) installs it with `npm i -g @rupertsworld/pi-acp`; it has no pi dependency.

## Behavior

### Socket lifecycle

- The socket lives at `$PI_CODING_AGENT_DIR/acp.sock` (default `~/.pi/agent/acp.sock`). Access control is the filesystem: whoever can reach the path can drive the session. There is no additional authentication.
- With `autoStart` (the default), the listener opens when a session starts — but only when the socket is free or stale. Auto-start never takes the socket from a live holder; that is an explicit act (`/acp attach`).
- `/acp attach` claims the socket for the current session. A free or stale socket is bound directly. A socket held by another live pi-acp is taken over cooperatively: the claimant connects and sends the `_pi-acp/release` extension method; the holder closes its listener, notifies its own session that the socket was released to another session, and responds; the claimant then binds. A holder that does not respond (not a pi-acp listener, or wedged) is reported and left alone — there is no forced takeover. "Attached" therefore means "the session external clients reach": the last session that claimed it.
- `/acp detach` closes this session's listener and frees the socket for another session to claim. The session runs on without ACP for its remaining lifetime; a later `/acp attach` (or the next session's auto-start) may rebind.
- The listener belongs to exactly one live session runtime. It closes on `session_shutdown` — `/new`, `/resume`, `/reload`, exit — and (under `autoStart`) reopens with the replacement session. Attached clients are disconnected at the boundary and reattach to the new session by reconnecting.
- Stale socket files (a previous pi that crashed) are detected by a probe connection and cleaned up before binding. Under auto-start, a socket held by another live pi means this session stands down with a notice and runs without the listener; losing the bind race (`EADDRINUSE`) is treated the same way. One state dir has at most one listener; distinct state dirs (for example a pino-style harness with its own home) have distinct sockets and never contend.
- Multiple clients may be connected at once. Each connection gets its own ACP agent bound to the one live session; every connection receives every session event. A disconnect drops that connection's subscription and nothing else.
- Socket and per-connection errors are contained: they are logged and may drop a connection, but never destabilize the session or the TUI.

### ACP surface

Per connection, the extension implements the agent side of ACP (JSON-RPC over newline-delimited JSON on the socket):

- `initialize` advertises `loadSession: false` and `promptCapabilities: { image: false, audio: false }`.
- `session/new` binds the connection to the live session and returns that session's id, with `configOptions: []` — the extension exposes no session config options and does not implement `session/set_config_option`. A conformant client reads the empty advertisement and does not call it. There is no session-id bookkeeping: whatever session is live is the session.
- `session/prompt` injects the text content as a user message in the live session. If the agent is mid-turn, the message queues as a follow-up rather than failing. The prompt resolves `end_turn` when the run has fully settled — after any automatic retry, compaction, or queued continuation — or `cancelled` when the turn was cancelled.
- `session/cancel` aborts the session's current run.
- The `_pi-acp/release` extension method asks this listener to stand down (the cooperative-takeover handshake behind `/acp attach`). The listener closes, notifies its session, and responds; the caller may then bind the socket.
- Streamed output maps to `session/update` notifications: assistant text deltas as `agent_message_chunk`; tool executions as `tool_call` (title, kind, `rawInput`) and `tool_call_update` (status, textual output, `rawOutput`). Tool kinds map by tool name (read → read, bash → execute, edit/write → edit, grep/find/ls → search, otherwise other).
- A prompt that cannot run at all (for example, no model credentials) surfaces the error as an assistant-style message chunk and still ends the turn, so clients are never left waiting.

Not provided, by design: permission prompts over the socket (permissioning stays in the TUI; agent-initiated `session/request_permission` is never sent), transcript history replay on attach (a client sees the session from its connection onward), rich diff/terminal tool payloads, and multi-session discovery or takeover.

## The attach relay

`pi-acp [socket-path]` connects to the socket — the argument, else `$PI_CODING_AGENT_DIR/acp.sock`, else `~/.pi/agent/acp.sock` — and relays raw bytes between its stdio and the socket. It exists for hosts whose ACP transport is "spawn a subprocess, speak over its stdio":

```sh
TELEVISION_ACP_COMMAND="pi-acp"
TELEVISION_ACP_COMMAND="pi-acp /root/.pino/acp.sock"
```

It exits 0 when either side closes and 1 (with a stderr message) when the socket cannot be reached, so spawning hosts observe a launch failure when no pi is listening. It performs no framing or interpretation; equivalent stock tools (`socat - UNIX-CONNECT:<path>`) work the same way.

## Configuration

Configuration lives in `acp.json` in the coding-agent home (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). The extension creates the file with defaults on first use; the user edits it to override.

Defaults: `{ "autoStart": true }`. `socketPath` may be set to override the socket location.

An unreadable or invalid config warns and falls back to defaults.

## Command

`/acp` with subcommands `status` (default), `attach`, and `detach`. `status` reports the socket path, whether this session holds the listener, and — when it doesn't — whether some other process does. `attach` claims the socket (cooperative takeover included); `detach` releases it. An `attach` that cannot complete (unresponsive holder, bind failure) reports why and leaves the session running without a listener.

## Status

`index.ts` implements this spec; the relay is `bin/pi-acp.mjs`.
