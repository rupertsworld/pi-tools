/**
 * pi-fence — soft workspace boundary for pi sessions.
 *
 * The agent home's own symlinks define the allowlist: the session cwd, every
 * symlink target at its top level, and /tmp. File tools reaching elsewhere
 * under a private root (/root, /home) are blocked; bash commands naming such
 * paths are blocked with a pointer to the HTTP mounts.
 *
 * A fence, not a sandbox: it disciplines habits and names the right
 * alternative, but cannot contain a determined shell. Kernel-level
 * enforcement is a separate project.
 */

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PRIVATE_ROOTS = ["/root", "/home"];
const PATH_KEYS = ["path", "file_path", "filePath", "dir", "directory"];

/** realpath, falling back through nonexistent tails to the nearest existing ancestor. */
export function realish(abs: string): string {
	let dir = abs;
	const tail: string[] = [];
	while (true) {
		try {
			return tail.length ? join(realpathSync(dir), ...tail.reverse()) : realpathSync(dir);
		} catch {
			const parent = dirname(dir);
			if (parent === dir) return abs;
			tail.push(basename(dir));
			dir = parent;
		}
	}
}

/** The allowlist: cwd, each top-level symlink target in cwd, and /tmp. */
export function deriveAllowed(cwd: string): string[] {
	const allowed = new Set<string>([realish(cwd), "/tmp"]);
	let names: string[] = [];
	try {
		names = readdirSync(cwd);
	} catch {
		/* unreadable cwd: fence still covers cwd itself */
	}
	for (const name of names) {
		const p = join(cwd, name);
		try {
			if (lstatSync(p).isSymbolicLink()) allowed.add(realish(p));
		} catch {
			/* dangling link: nothing to allow */
		}
	}
	return [...allowed];
}

const underAny = (p: string, roots: string[]) =>
	roots.some((r) => p === r || p.startsWith(r + sep));

/** Paths outside the private roots (system, toolchain) are always fine. */
export function isAllowedPath(p: string, cwd: string, allowed: string[]): boolean {
	const real = realish(isAbsolute(p) ? p : resolve(cwd, p));
	if (!underAny(real, PRIVATE_ROOTS)) return true;
	return underAny(real, allowed);
}

/** First absolute path in a bash command that violates the fence, if any. */
export function scanBash(command: string, cwd: string, allowed: string[]): string | undefined {
	const tokens = command.match(/(?<=^|[\s"'`=(:;|&<>])\/[^\s"'`)|&;<>]+/g) ?? [];
	for (const raw of tokens) {
		const token = raw.replace(/[.,:]+$/, "");
		if (!isAllowedPath(token, cwd, allowed)) return token;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const cwd = process.cwd();
		const allowed = deriveAllowed(cwd);

		if (event.toolName === "bash") {
			const command = String((event.input as Record<string, unknown>).command ?? "");
			const offender = scanBash(command, cwd, allowed);
			if (offender) {
				if (ctx.hasUI) ctx.ui.notify(`fence: blocked bash touching ${offender}`, "warning");
				return {
					block: true,
					reason: `\`${offender}\` is outside the workspace fence. Use the HTTP mounts (http://rubot/…) or workspace-relative paths.`,
				};
			}
			return undefined;
		}

		for (const key of PATH_KEYS) {
			const value = (event.input as Record<string, unknown>)?.[key];
			if (typeof value === "string" && !isAllowedPath(value, cwd, allowed)) {
				if (ctx.hasUI) ctx.ui.notify(`fence: blocked ${event.toolName} on ${value}`, "warning");
				return {
					block: true,
					reason: `"${value}" is outside the workspace fence. Use the HTTP mounts (http://rubot/…) or workspace-relative paths.`,
				};
			}
		}
		return undefined;
	});
}
