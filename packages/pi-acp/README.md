# @rupertsworld/pi-acp

An [ACP](https://agentclientprotocol.com/) endpoint for a running [pi](https://github.com/earendil-works/pi-mono) session, served over a unix socket. An external ACP client — Television, an editor, any ACP-speaking host — attaches to the **same live session** the terminal is driving: prompts sent over the socket run in that session, and streamed output and tool activity fan out to every attached client as well as the TUI.

```sh
pi install npm:@rupertsworld/pi-acp
```

## Surface

- The socket lives in the coding-agent home (`acp.sock`); one live session holds it at a time. With `autoStart` (the default) a starting session binds a free or stale socket automatically; `/acp attach` claims it explicitly (cooperative takeover from a live holder — never forced), and `/acp detach` frees it.
- `pi-acp` (the package's npm bin) is a stdio↔socket relay for hosts that spawn their ACP agent as a subprocess. An attach-only machine installs it with `npm i -g @rupertsworld/pi-acp`; it has no pi dependency.

[`spec/pi-acp/index.md`](https://github.com/rupertsworld/pi-tools/blob/main/spec/pi-acp/index.md) is the authority on behavior.
