import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHarness, waitFor, type Harness } from "./helpers/harness.ts";

let agentDir: string;
let previousAgentDirEnv: string | undefined;
const harnesses: Harness[] = [];

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-acp-socket-"));
	previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
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

function harness(options: { sessionId?: string } = {}): Harness {
	const h = createHarness(options);
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

describe("socket lifecycle (autoStart)", () => {
	it("binds the listener on session_start and creates acp.json with defaults", async () => {
		const h = harness();
		await h.sessionStart();

		const info = await stat(socketPath());
		assert.equal(info.isSocket(), true);
		assert.equal(await canConnect(socketPath()), true);

		const config = JSON.parse(await readFile(join(agentDir, "acp.json"), "utf8")) as unknown;
		assert.deepEqual(config, { autoStart: true });
	});

	it("does not bind when autoStart is false", async () => {
		await writeFile(join(agentDir, "acp.json"), JSON.stringify({ autoStart: false }), "utf8");
		const h = harness();
		await h.sessionStart();

		assert.equal(await fileExists(socketPath()), false);
	});

	it("cleans up a stale socket file and rebinds", async () => {
		await writeFile(socketPath(), "stale", "utf8");
		const h = harness();
		await h.sessionStart();

		assert.equal(await canConnect(socketPath()), true);
	});

	it("stands down with a notice when another live listener holds the socket", async () => {
		const first = harness();
		await first.sessionStart();
		const second = harness();
		await second.sessionStart();

		assert.ok(
			second.notifications.some((entry) => /another/i.test(entry.message)),
			JSON.stringify(second.notifications),
		);
		// The first listener is untouched.
		assert.equal(await canConnect(socketPath()), true);
		await second.shutdown();
		assert.equal(await canConnect(socketPath()), true);
	});

	it("uses socketPath from config when set", async () => {
		const custom = join(agentDir, "custom.sock");
		await writeFile(join(agentDir, "acp.json"), JSON.stringify({ autoStart: true, socketPath: custom }), "utf8");
		const h = harness();
		await h.sessionStart();

		assert.equal(await canConnect(custom), true);
		assert.equal(await fileExists(socketPath()), false);
	});

	it("warns and falls back to defaults on invalid config without overwriting it", async () => {
		const malformed = "not json {{";
		await writeFile(join(agentDir, "acp.json"), malformed, "utf8");
		const h = harness();
		await h.sessionStart();

		assert.equal(await readFile(join(agentDir, "acp.json"), "utf8"), malformed);
		assert.ok(
			h.notifications.some((entry) => entry.type === "warning" && /acp\.json/.test(entry.message)),
			JSON.stringify(h.notifications),
		);
		// Defaults: autoStart true at the default path.
		assert.equal(await canConnect(socketPath()), true);
	});

	it("treats a JSON array config as invalid", async () => {
		await writeFile(join(agentDir, "acp.json"), "[]", "utf8");
		const h = harness();
		await h.sessionStart();

		assert.ok(
			h.notifications.some((entry) => entry.type === "warning" && /invalid/i.test(entry.message)),
			JSON.stringify(h.notifications),
		);
		assert.equal(await canConnect(socketPath()), true);
	});

	it("contains an autoStart bind failure and leaves the session running", async () => {
		const unavailable = join(agentDir, "missing", "acp.sock");
		await writeFile(join(agentDir, "acp.json"), JSON.stringify({ autoStart: true, socketPath: unavailable }), "utf8");
		const h = harness();

		await assert.doesNotReject(h.sessionStart());
		assert.ok(
			h.notifications.some((entry) => entry.type === "error" && entry.message.includes(unavailable)),
			JSON.stringify(h.notifications),
		);
	});
});

describe("session_shutdown", () => {
	it("closes the listener, removes the socket file, and disconnects clients", async () => {
		const h = harness();
		await h.sessionStart();

		const client = connect(socketPath());
		await new Promise<void>((resolve, reject) => {
			client.once("connect", () => resolve());
			client.once("error", reject);
		});
		let clientClosed = false;
		client.once("close", () => {
			clientClosed = true;
		});

		await h.shutdown();

		await waitFor(() => clientClosed);
		assert.equal(await fileExists(socketPath()), false);
		assert.equal(await canConnect(socketPath()), false);
	});
});
