# pi-fence

A soft workspace boundary for pi sessions. The agent's home directory — the
session cwd — defines its world: pi-fence blocks file tools and bash commands
that reach outside the home, its symlinked side-doors, and `/tmp`, and each
block names the sanctioned alternative (the HTTP service mounts). It is a
fence, not a sandbox: it disciplines a well-intentioned agent and surfaces
boundary violations as visible friction, but it cannot contain a hostile
one — the agent process retains its OS privileges. Kernel-level containment
is a separate concern.

## Loading

pi-fence is an ordinary pi package:

```sh
pi install npm:@rupertsworld/pi-fence
```

It loads through the `packages` array of pi's settings like any other
package, or directly by placing (or symlinking) `index.ts` in
`~/.pi/agent/extensions/`.

## The allowlist

There is no configuration. The allowlist is derived from the filesystem at
every tool call:

- the session cwd (resolved through symlinks), and
- the resolved target of every top-level symlink in the cwd, and
- `/tmp`.

The home's own symlinks are the policy: linking a directory into the home
grants it; removing the link revokes it. This makes the boundary auditable
with `ls -la` and adjustable without touching the extension.

Only the private roots `/root` and `/home` are fenced. Paths outside them —
`/usr/bin/python3`, `/etc/hosts`, toolchain and system paths generally — are
always allowed, so ordinary command execution is unaffected.

## Enforcement

On each `tool_call` event:

- **File tools** — any tool whose input carries a path-like key (`path`,
  `file_path`, `filePath`, `dir`, `directory`): the path is resolved against
  the cwd and through symlinks (nonexistent tails resolve through the
  nearest existing ancestor, so writes to new files are judged by their
  ancestor directory). A path under a private root but outside the
  allowlist blocks the call.
- **Bash** — absolute path tokens are extracted from the command string;
  the first token under a private root but outside the allowlist blocks
  the command. URLs are not paths and pass through (`http://rubot/…`).

A blocked call returns `{ block: true }` with a reason instructing the
agent to use the HTTP mounts or workspace-relative paths, and notifies the
UI when one is attached.

## Limits, stated plainly

Bash blocking is token-matching, not interpretation: substitution,
variables, and indirection evade it (`cat $(echo /root/x)`). Symlink
resolution happens at check time; a link swapped between check and
execution is not caught. The extension file itself lives where the agent
can edit it. These are accepted properties of a fence. Real enforcement
requires OS-level isolation (dedicated user, bubblewrap, or similar), for
which pi-fence is the behavioral rehearsal.
