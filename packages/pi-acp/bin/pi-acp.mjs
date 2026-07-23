#!/usr/bin/env node

/**
 * Dumb stdio <-> unix-socket relay for ACP hosts that spawn an agent process.
 *
 * This file intentionally has no TypeScript or pi runtime dependency: machines
 * that only attach to a live session need nothing beyond Node and this package.
 */

import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const path =
	process.argv[2] ??
	(process.env.PI_CODING_AGENT_DIR
		? join(process.env.PI_CODING_AGENT_DIR, "acp.sock")
		: join(homedir(), ".pi", "agent", "acp.sock"));

const socket = connect(path);
let settled = false;
let connected = false;

function finish(code) {
	if (settled) return;
	settled = true;
	process.stdin.unpipe(socket);
	process.stdin.pause();
	socket.destroy();
	process.exitCode = code;
}

socket.on("error", (error) => {
	if (!connected) {
		process.stderr.write(`pi-acp: cannot connect to ${path}: ${error.message}\n`);
	}
	finish(connected ? 0 : 1);
});

process.stdout.on("error", () => finish(0));

socket.once("connect", () => {
	connected = true;
	process.stdin.pipe(socket);
	socket.pipe(process.stdout);

	socket.once("close", () => {
		process.stdin.unpipe(socket);
		process.stdin.pause();
		finish(0);
	});
	process.stdin.once("end", () => socket.end());
	socket.on("error", () => finish(1));
});
