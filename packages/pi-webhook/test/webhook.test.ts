import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import createWebhookExtension from "../index.ts";

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface StubPi {
	pi: ExtensionAPI;
	handlers: Map<string, EventHandler>;
	sendMessageCalls: Array<{ message: unknown; options: unknown }>;
	commands: Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
}

interface StubCtx {
	ctx: { hasUI: boolean; ui: { notify: (message: string, type?: string) => void } };
	notifications: Array<{ message: string; type?: string }>;
}

let agentDir: string;
let previousAgentDirEnv: string | undefined;
let stub: StubPi;

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-webhook-test-"));
	previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	stub = createStubPi();
	createWebhookExtension(stub.pi);
});

afterEach(async () => {
	await fireEvent("session_shutdown", createStubCtx());
	if (previousAgentDirEnv === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv;
	}
	await rm(agentDir, { recursive: true, force: true });
});

describe("webhook lifecycle", () => {
	it("does not listen or touch webhook.json before /webhook start", async () => {
		const handler = stub.handlers.get("session_start");
		if (handler) await handler({}, createStubCtx().ctx);

		assert.equal(await fileExists(join(agentDir, "webhook.json")), false);
		assert.match(await commandStatus(), /not running/i);
	});

	it("creates webhook.json with defaults on first /webhook start when missing", async () => {
		await runCommand("start 0");

		const config = JSON.parse(await readFile(join(agentDir, "webhook.json"), "utf8")) as unknown;
		assert.deepEqual(config, { bind: "127.0.0.1", port: 3729 });
	});

	it("does not overwrite an existing webhook.json on start", async () => {
		const existing = "{\n\t\"bind\": \"127.0.0.1\",\n\t\"port\": 0\n}\n";
		await writeFile(join(agentDir, "webhook.json"), existing, "utf8");

		await runCommand("start");

		assert.equal(await readFile(join(agentDir, "webhook.json"), "utf8"), existing);
	});

	it("warns and falls back to defaults on a malformed webhook.json without overwriting it", async () => {
		const malformed = "not json {{";
		await writeFile(join(agentDir, "webhook.json"), malformed, "utf8");

		const notifications = await runCommand("start 0");

		assert.equal(await readFile(join(agentDir, "webhook.json"), "utf8"), malformed);
		assert.ok(
			notifications.some((entry) => entry.type === "warning" && /webhook\.json/.test(entry.message)),
			JSON.stringify(notifications),
		);
		assert.match(await commandStatus(), /listening/i);
	});

	it("starts on the configured bind and port via /webhook start", async () => {
		const address = await startOnEphemeralPort();

		assert.match(address, /^http:\/\/127\.0\.0\.1:\d+$/);
		assert.match(await commandStatus(), /listening/i);
	});

	it("overrides the configured port with an integer argument to start", async () => {
		const blocker = createServer();
		const takenPort = await listenOnEphemeralPort(blocker);
		try {
			await writeConfig({ bind: "127.0.0.1", port: takenPort });

			const notifications = await runCommand("start 0");

			const status = await commandStatus();
			assert.match(status, /listening/i);
			const match = status.match(/http:\/\/127\.0\.0\.1:(\d+)/);
			assert.ok(match, status);
			assert.notEqual(Number(match![1]), takenPort);
			assert.ok(
				notifications.every((entry) => entry.type !== "error"),
				JSON.stringify(notifications),
			);
		} finally {
			blocker.close();
		}
	});

	it("rejects a non-integer port argument without starting", async () => {
		const notifications = await runCommand("start abc");

		assert.ok(
			notifications.some((entry) => entry.type === "error" && /port/i.test(entry.message)),
			JSON.stringify(notifications),
		);
		assert.match(await commandStatus(), /not running/i);
	});

	it("rejects an out-of-range port argument without starting", async () => {
		const notifications = await runCommand("start 70000");

		assert.ok(
			notifications.some((entry) => entry.type === "error" && /port/i.test(entry.message)),
			JSON.stringify(notifications),
		);
		assert.match(await commandStatus(), /not running/i);
	});

	it("notifies and continues without the webhook when the port is taken", async () => {
		const blocker = createServer();
		const port = await listenOnEphemeralPort(blocker);
		try {
			await writeConfig({ bind: "127.0.0.1", port });

			const notifications = await runCommand("start");

			assert.ok(
				notifications.some((entry) => entry.type === "error" && /webhook/i.test(entry.message)),
				JSON.stringify(notifications),
			);
			assert.match(await commandStatus(), /not running/i);
		} finally {
			blocker.close();
		}
	});

	it("keeps the running server when start is repeated", async () => {
		const address = await startOnEphemeralPort();

		const notifications = await runCommand("start");

		assert.ok(
			notifications.some((entry) => /already/i.test(entry.message)),
			JSON.stringify(notifications),
		);
		const status = await commandStatus();
		assert.ok(status.includes(address), `${status} should include ${address}`);
	});

	it("stops the server via /webhook stop", async () => {
		const address = await startOnEphemeralPort();

		const notifications = await runCommand("stop");

		assert.ok(
			notifications.some((entry) => /stopped/i.test(entry.message)),
			JSON.stringify(notifications),
		);
		await assert.rejects(fetch(`${address}/message`, { method: "POST", body: "{}" }));
		assert.match(await commandStatus(), /not running/i);
	});

	it("reports not running when stop is invoked without a server", async () => {
		const notifications = await runCommand("stop");

		assert.ok(
			notifications.some((entry) => /not running/i.test(entry.message)),
			JSON.stringify(notifications),
		);
	});

	it("notifies usage for an unknown subcommand", async () => {
		const notifications = await runCommand("frobnicate");

		assert.ok(
			notifications.some((entry) => /usage/i.test(entry.message)),
			JSON.stringify(notifications),
		);
		assert.match(await commandStatus(), /not running/i);
	});

	it("reports status via the status subcommand and the bare command", async () => {
		assert.match(await commandStatus(), /not running/i);
		const [statusNotification] = await runCommand("status");
		assert.match(statusNotification!.message, /not running/i);

		const address = await startOnEphemeralPort();

		const status = await commandStatus();
		assert.match(status, /listening/i);
		assert.ok(status.includes(address), `${status} should include ${address}`);
		const [runningStatus] = await runCommand("status");
		assert.ok(runningStatus!.message.includes(address), runningStatus!.message);
	});

	it("closes the server on session_shutdown", async () => {
		const address = await startOnEphemeralPort();

		await fireEvent("session_shutdown", createStubCtx());

		await assert.rejects(fetch(`${address}/message`, { method: "POST", body: "{}" }));
		assert.match(await commandStatus(), /not running/i);
	});

	it("notifies without crashing when the server errors after a successful listen", async (t) => {
		const created: Server[] = [];
		const originalListen = Server.prototype.listen;
		Server.prototype.listen = function (this: Server, ...args: unknown[]) {
			created.push(this);
			return (originalListen as (...listenArgs: unknown[]) => Server).apply(this, args);
		} as typeof originalListen;
		t.after(() => {
			Server.prototype.listen = originalListen;
		});

		await writeConfig({ bind: "127.0.0.1", port: 0 });
		const notifications = await runCommand("start");
		assert.equal(created.length, 1);

		created[0]!.emit("error", new Error("boom"));

		assert.ok(
			notifications.some((entry) => entry.type === "error" && /boom/.test(entry.message)),
			JSON.stringify(notifications),
		);
		assert.ok(
			notifications.every((entry) => !/failed to listen/i.test(entry.message)),
			JSON.stringify(notifications),
		);
		assert.match(await commandStatus(), /listening/i);
	});
});

describe("webhook http handling", () => {
	it("injects a posted message via pi.sendMessage and responds 202", async () => {
		const address = await startOnEphemeralPort();

		const response = await fetch(`${address}/message`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "hi" }),
		});

		assert.equal(response.status, 202);
		assert.deepEqual(await response.json(), { ok: true });
		assert.deepEqual(stub.sendMessageCalls, [
			{
				message: { customType: "webhook", content: "hi", display: true },
				options: { triggerTurn: true, deliverAs: "followUp" },
			},
		]);
	});

	it("rejects missing, empty, and non-string messages with 400", async () => {
		const address = await startOnEphemeralPort();

		for (const body of ["{}", "{\"message\":\"\"}", "{\"message\":5}", "null"]) {
			const response = await fetch(`${address}/message`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
			assert.equal(response.status, 400, `body: ${body}`);
			const payload = (await response.json()) as { ok: boolean };
			assert.equal(payload.ok, false);
		}

		assert.equal(stub.sendMessageCalls.length, 0);
	});

	it("rejects an unparseable JSON body with 400", async () => {
		const address = await startOnEphemeralPort();

		const response = await fetch(`${address}/message`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not json",
		});

		assert.equal(response.status, 400);
		assert.equal(stub.sendMessageCalls.length, 0);
	});

	it("rejects a body over 1 MB with 413 without injecting", async () => {
		const address = await startOnEphemeralPort();

		// The server responds 413 mid-upload and destroys the socket, which can
		// reset fetch's in-flight body write, so post over a raw socket that reads
		// the response eagerly and tolerates the write-side reset.
		const response = await postOversizedBody(address, 3 * 1_048_576);

		assert.match(response, /^HTTP\/1\.1 413 /);
		const body = response.match(/\{.*\}/)?.[0];
		assert.ok(body, `expected a JSON body in: ${response}`);
		const payload = JSON.parse(body) as { ok: boolean };
		assert.equal(payload.ok, false);
		assert.equal(stub.sendMessageCalls.length, 0);
	});

	it("rejects a request bearing an Origin header with 403 without injecting", async () => {
		const address = await startOnEphemeralPort();

		const response = await fetch(`${address}/message`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "http://evil.example" },
			body: JSON.stringify({ message: "hi" }),
		});

		assert.equal(response.status, 403);
		const payload = (await response.json()) as { ok: boolean };
		assert.equal(payload.ok, false);
		assert.equal(stub.sendMessageCalls.length, 0);
	});

	it("rejects a non-JSON Content-Type with 415 without injecting", async () => {
		const address = await startOnEphemeralPort();

		const response = await fetch(`${address}/message`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: JSON.stringify({ message: "hi" }),
		});

		assert.equal(response.status, 415);
		const payload = (await response.json()) as { ok: boolean };
		assert.equal(payload.ok, false);
		assert.equal(stub.sendMessageCalls.length, 0);
	});

	it("accepts application/json with a charset parameter", async () => {
		const address = await startOnEphemeralPort();

		const response = await fetch(`${address}/message`, {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify({ message: "hi" }),
		});

		assert.equal(response.status, 202);
		assert.equal(stub.sendMessageCalls.length, 1);
	});

	it("responds 404 for unknown paths and 405 for wrong methods on /message", async () => {
		const address = await startOnEphemeralPort();

		const notFound = await fetch(`${address}/nope`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		assert.equal(notFound.status, 404);

		const wrongMethod = await fetch(`${address}/message`);
		assert.equal(wrongMethod.status, 405);

		assert.equal(stub.sendMessageCalls.length, 0);
	});
});

function createStubPi(): StubPi {
	const handlers = new Map<string, EventHandler>();
	const sendMessageCalls: StubPi["sendMessageCalls"] = [];
	const commands: StubPi["commands"] = new Map();
	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, handler);
		},
		sendMessage(message: unknown, options: unknown) {
			sendMessageCalls.push({ message, options });
		},
		registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, options);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, sendMessageCalls, commands };
}

function createStubCtx(): StubCtx {
	const notifications: StubCtx["notifications"] = [];
	return {
		ctx: {
			hasUI: true,
			ui: {
				notify(message: string, type?: string) {
					notifications.push({ message, type });
				},
			},
		},
		notifications,
	};
}

async function fireEvent(event: string, stubCtx: StubCtx | StubCtx["ctx"]): Promise<void> {
	const handler = stub.handlers.get(event);
	assert.ok(handler, `no handler registered for ${event}`);
	const ctx = "ctx" in stubCtx ? stubCtx.ctx : stubCtx;
	await handler({}, ctx);
}

async function runCommand(args: string): Promise<StubCtx["notifications"]> {
	const command = stub.commands.get("webhook");
	assert.ok(command, "webhook command not registered");
	const { ctx, notifications } = createStubCtx();
	await command.handler(args, ctx);
	return notifications;
}

async function commandStatus(): Promise<string> {
	const notifications = await runCommand("");
	assert.equal(notifications.length, 1, JSON.stringify(notifications));
	return notifications[0]!.message;
}

async function writeConfig(config: { bind: string; port: number }): Promise<void> {
	await writeFile(join(agentDir, "webhook.json"), JSON.stringify(config), "utf8");
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function listenOnEphemeralPort(server: Server): Promise<number> {
	return new Promise((resolvePort, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			assert.ok(address && typeof address === "object");
			resolvePort(address.port);
		});
	});
}

async function startOnEphemeralPort(): Promise<string> {
	await writeConfig({ bind: "127.0.0.1", port: 0 });
	await runCommand("start");

	const status = await commandStatus();
	const match = status.match(/http:\/\/127\.0\.0\.1:(\d+)/);
	assert.ok(match, `expected listening address in: ${status}`);
	return `http://127.0.0.1:${match[1]}`;
}

function postOversizedBody(address: string, bytes: number): Promise<string> {
	const url = new URL(address);
	return new Promise((resolve) => {
		const socket = connect(Number(url.port), url.hostname);
		let received = "";
		socket.on("data", (chunk: Buffer) => {
			received += chunk.toString("utf8");
		});
		socket.on("error", () => {
			// Expected: the server destroys the socket while the body is in flight.
		});
		socket.on("close", () => resolve(received));
		socket.on("connect", () => {
			socket.write(
				`POST /message HTTP/1.1\r\nhost: ${url.host}\r\ncontent-type: application/json\r\ncontent-length: ${bytes}\r\n\r\n`,
			);
			const chunk = Buffer.alloc(65536, 97);
			let sent = 0;
			const pump = (): void => {
				while (sent < bytes && !socket.destroyed) {
					const size = Math.min(chunk.length, bytes - sent);
					sent += size;
					if (!socket.write(chunk.subarray(0, size))) {
						socket.once("drain", pump);
						return;
					}
				}
			};
			pump();
		});
	});
}
