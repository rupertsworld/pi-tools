import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deriveAllowed, isAllowedPath, realish, scanBash } from "../index.ts";

// A fake agent home under /tmp with a side-door symlink to a "private" area.
// /tmp is itself allowed, so tests assert against fake private roots via the
// pure functions' PRIVATE_ROOTS behavior using /root-shaped paths that don't
// need to exist (realish falls back through nonexistent tails).

const home = mkdtempSync(join(tmpdir(), "fence-home-"));
const door = mkdtempSync(join(tmpdir(), "fence-door-"));
mkdirSync(join(home, "state"));
writeFileSync(join(home, "AGENTS.md"), "x");
symlinkSync(door, join(home, "sidedoor"));

test("deriveAllowed includes cwd, /tmp, and symlink targets", () => {
	const allowed = deriveAllowed(home);
	assert.ok(allowed.includes(realish(home)));
	assert.ok(allowed.includes("/tmp"));
	assert.ok(allowed.includes(realish(door)));
	// plain dirs and files are not separate entries
	assert.ok(!allowed.includes(join(home, "state")));
});

test("system and toolchain paths are always allowed", () => {
	const allowed = deriveAllowed(home);
	assert.ok(isAllowedPath("/usr/bin/python3", home, allowed));
	assert.ok(isAllowedPath("/etc/hosts", home, allowed));
});

test("private paths outside the allowlist are blocked", () => {
	const allowed = deriveAllowed(home);
	assert.ok(!isAllowedPath("/root/Dropbox/Vault/topics/now.md", home, allowed));
	assert.ok(!isAllowedPath("/root/.ssh/id_ed25519", home, allowed));
	assert.ok(!isAllowedPath("/home/anyone/file", home, allowed));
});

test("cwd-relative and side-door paths are allowed", () => {
	const allowed = deriveAllowed(home);
	assert.ok(isAllowedPath("state/notes.md", home, allowed));
	assert.ok(isAllowedPath(join(home, "new-file.md"), home, allowed));
	assert.ok(isAllowedPath(join(door, "secret.env"), home, allowed));
	assert.ok(isAllowedPath("sidedoor/secret.env", home, allowed));
});

test("nonexistent paths resolve through nearest ancestor", () => {
	const allowed = deriveAllowed(home);
	assert.ok(isAllowedPath(join(home, "not", "yet", "made.txt"), home, allowed));
	assert.ok(!isAllowedPath("/root/nope/not/yet/made.txt", home, allowed));
});

test("scanBash finds offending absolute paths", () => {
	const allowed = deriveAllowed(home);
	assert.equal(scanBash("ls -la state/", home, allowed), undefined);
	assert.equal(scanBash("/usr/bin/python3 script.py", home, allowed), undefined);
	assert.equal(
		scanBash("cat /root/Dropbox/Vault/autofile.yml", home, allowed),
		"/root/Dropbox/Vault/autofile.yml",
	);
	assert.equal(scanBash("grep x /root/.ssh/config.", home, allowed), "/root/.ssh/config");
	assert.equal(scanBash(`curl "http://rubot/vault/tasks/"`, home, allowed), undefined);
});
