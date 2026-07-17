# pi-tools

A monorepo of [pi](https://github.com/earendil-works/pi-mono) packages. Each package is independently published to npm under the `@telepath-computer` scope and is spec-driven: its `SPEC.md` is the authority on desired behavior.

## Packages

| Package | Description |
|---|---|
| [`@telepath-computer/pi-webhook`](packages/pi-webhook) | HTTP ingress for injecting messages into the active pi session |
| [`@telepath-computer/pi-dynamic-context`](packages/pi-dynamic-context) | Per-turn refresh of system prompt and context files, with template variables |

## Install

```sh
pi install npm:@telepath-computer/pi-webhook
pi install npm:@telepath-computer/pi-dynamic-context
```

For local development, install a package by path:

```sh
pi install /root/dev/pi-tools/packages/pi-webhook
```
