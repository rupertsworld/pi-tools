import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect, createServer, type Server } from "node:net";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarness, waitFor, type Harness } from "./helpers/harness.ts";

let agentDir: string;
let previousAgentDirEnv: string | undefined;
const harnesses: Harness[] = [];

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-acp-commands-"));
	previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// Keep autoStart out of the way: commands are exercised explicitly.
	await writeFile(join(agentDir, "acp.json"), JSON.stringify({ autoStart: false }), "utf8");
});

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.shutdown();
	}
	if (previousAgentDirEnv === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv;
	}
	await rm(agentDir, { recursive: true, force: true });
});

function harness(): Harness {
	const h = createHarness();
	harnesses.push(h);
	return h;
}

function socketPath(): string {
	return join(agentDir, "acp.sock");
}

function canConnect(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(path);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			socket.destroy();
			resolve(false);
		});
	});
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

describe("/acp command", () => {
	it("status (default) reports the socket path and a free socket when not attached", async () => {
		const h = harness();
		for (const args of ["", "status"]) {
			const notifications = await h.runCommand(args);
			assert.equal(notifications.length, 1, JSON.stringify(notifications));
			const message = notifications[0]!.message;
			assert.ok(message.includes(socketPath()), message);
			assert.match(message, /not attached/i);
			assert.match(message, /free/i);
		}
	});

	it("status reports when another process holds the socket", async () => {
		const blocker = createServer();
		await new Promise<void>((resolve, reject) => {
			blocker.once("error", reject);
			blocker.listen(socketPath(), () => resolve());
		});
		try {
			const h = harness();
			const [status] = await h.runCommand("status");
			assert.match(status!.message, /not attached/i);
			assert.match(status!.message, /another process/i);
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("attach binds a free socket and status then reports this session as holder", async () => {
		const h = harness();
		const notifications = await h.runCommand("attach");
		assert.ok(
			notifications.some((entry) => /listening/i.test(entry.message)),
			JSON.stringify(notifications),
		);
		assert.equal(await canConnect(socketPath()), true);
		const [status] = await h.runCommand("status");
		assert.match(status!.message, /this session/i);
	});

	it("attach cleans up a stale socket file before binding", async () => {
		await writeFile(socketPath(), "stale", "utf8");
		const h = harness();
		await h.runCommand("attach");
		assert.equal(await canConnect(socketPath()), true);
	});

	it("detach frees the socket and reports; a repeat detach reports not holding", async () => {
		const h = harness();
		await h.runCommand("attach");
		const notifications = await h.runCommand("detach");
		assert.ok(
			notifications.some((entry) => /released|freed|detached/i.test(entry.message)),
			JSON.stringify(notifications),
		);
		assert.equal(await fileExists(socketPath()), false);
		const [status] = await h.runCommand("status");
		assert.match(status!.message, /not attached/i);

		const repeat = await h.runCommand("detach");
		assert.ok(
			repeat.some((entry) => /not/i.test(entry.message)),
			JSON.stringify(repeat),
		);
	});

	it("reports usage for an unknown subcommand", async () => {
		const h = harness();
		const notifications = await h.runCommand("frobnicate");
		assert.ok(
			notifications.some((entry) => /usage/i.test(entry.message)),
			JSON.stringify(notifications),
		);
	});

	it("reports a bind failure without throwing or attaching", async () => {
		const unavailable = join(agentDir, "missing", "acp.sock");
		await writeFile(join(agentDir, "acp.json"), JSON.stringify({ autoStart: false, socketPath: unavailable }), "utf8");
		const h = harness();

		const notifications = await h.runCommand("attach");
		assert.ok(
			notifications.some((entry) => entry.type === "error" && entry.message.includes(unavailable)),
			JSON.stringify(notifications),
		);
		const [status] = await h.runCommand("status");
		assert.match(status!.message, /not attached/i);
	});
});

describe("cooperative takeover", () => {
	it("attach takes over from a live pi-acp holder via _pi-acp/release", async () => {
		const holder = harness();
		await holder.runCommand("attach");
		assert.equal(await canConnect(socketPath()), true);

		const claimant = harness();
		const notifications = await claimant.runCommand("attach");

		// Claimant now holds the socket.
		assert.ok(
			notifications.some((entry) => /listening/i.test(entry.message)),
			JSON.stringify(notifications),
		);
		assert.equal(await canConnect(socketPath()), true);
		const [claimantStatus] = await claimant.runCommand("status");
		assert.match(claimantStatus!.message, /this session/i);

		// Holder was notified that the socket was released to another session.
		await waitFor(() => holder.notifications.some((entry) => /released/i.test(entry.message)));
		const [holderStatus] = await holder.runCommand("status");
		assert.match(holderStatus!.message, /not attached/i);
	});

	it("attach reports and leaves an unresponsive holder alone", async () => {
		// A plain net server that accepts connections but never answers JSON-RPC.
		const silent = createServer((socket) => {
			socket.on("data", () => {});
			socket.on("error", () => {});
		});
		await new Promise<void>((resolve, reject) => {
			silent.once("error", reject);
			silent.listen(socketPath(), () => resolve());
		});
		try {
			const h = harness();
			const notifications = await h.runCommand("attach");
			assert.ok(
				notifications.some((entry) => /respond/i.test(entry.message)),
				JSON.stringify(notifications),
			);
			// The holder keeps the socket; this session did not bind.
			assert.equal(await canConnect(socketPath()), true);
			const [status] = await h.runCommand("status");
			assert.match(status!.message, /not attached/i);
		} finally {
			await new Promise<void>((resolve) => silent.close(() => resolve()));
		}
	});
});
