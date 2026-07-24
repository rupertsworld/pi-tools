import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
	ctx: {
		hasUI: boolean;
		sessionManager: { getSessionId: () => string };
		ui: { notify: (message: string, type?: string) => void };
	};
	notifications: Array<{ message: string; type?: string }>;
}

const sessionId = "test-session";
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
	it("does not listen or create config before an explicit attach", async () => {
		await fireEvent("session_start", createStubCtx());

		assert.equal(await fileExists(join(agentDir, "webhook.json")), false);
		assert.match(await commandStatus(), /not running/i);
		assert.match(await commandStatus(), /not attached/i);
	});

	it("attaches the current session, writes config, and serves requests", async () => {
		const address = await startOnEphemeralPort();

		assert.deepEqual(await readConfig(), {
			bind: "127.0.0.1",
			port: 0,
			allowedOrigins: [],
			sessionId,
		});
		const response = await fetch(`${address}/message`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "attached" }),
		});
		assert.equal(response.status, 202);
	});

	it("creates defaults with allowedOrigins and updates a supplied port in webhook.json", async () => {
		await runCommand("attach 0");

		assert.deepEqual(await readConfig(), {
			bind: "127.0.0.1",
			port: 0,
			allowedOrigins: [],
			sessionId,
		});
		assert.match(await commandStatus(), /listening/i);
	});

	it("rejects invalid ports without changing config or starting", async () => {
		const existing = "{\n\t\"bind\": \"127.0.0.1\",\n\t\"port\": 0,\n\t\"allowedOrigins\": []\n}\n";
		await writeFile(join(agentDir, "webhook.json"), existing, "utf8");

		for (const port of ["abc", "70000"]) {
			const notifications = await runCommand(`attach ${port}`);
			assert.ok(notifications.some((entry) => entry.type === "error" && /port/i.test(entry.message)));
		}

		assert.equal(await readFile(join(agentDir, "webhook.json"), "utf8"), existing);
		assert.match(await commandStatus(), /not running/i);
	});

	it("warns and falls back to defaults when allowedOrigins is invalid", async () => {
		await writeFile(
			join(agentDir, "webhook.json"),
			JSON.stringify({ bind: "127.0.0.1", port: 4321, allowedOrigins: "https://app.example" }),
			"utf8",
		);

		const notifications = await runCommand("attach 0");

		assert.ok(notifications.some((entry) => entry.type === "warning" && /webhook\.json/.test(entry.message)));
		assert.deepEqual(await readConfig(), {
			bind: "127.0.0.1",
			port: 0,
			allowedOrigins: [],
			sessionId,
		});
	});

	it("warns and replaces malformed config with attach-time defaults and ownership", async () => {
		await writeFile(join(agentDir, "webhook.json"), "not json {{", "utf8");

		const notifications = await runCommand("attach 0");

		assert.ok(notifications.some((entry) => entry.type === "warning" && /webhook\.json/.test(entry.message)));
		assert.deepEqual(await readConfig(), {
			bind: "127.0.0.1",
			port: 0,
			allowedOrigins: [],
			sessionId,
		});
	});

	it("transfers ownership even when the configured port is already taken", async () => {
		const blocker = createServer();
		const port = await listenOnEphemeralPort(blocker);
		try {
			await writeConfig({ bind: "127.0.0.1", port, allowedOrigins: [] });

			const notifications = await runCommand("attach");

			assert.ok(notifications.some((entry) =>
				entry.type === "error" && /another session/i.test(entry.message) && /shutdown|detach/i.test(entry.message),
			), JSON.stringify(notifications));
			assert.equal((await readConfig()).sessionId, sessionId);
			assert.match(await commandStatus(), /not running/i);
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("keeps serving and refreshes ownership on repeated attach", async () => {
		const address = await startOnEphemeralPort();
		await writeConfig({ bind: "127.0.0.1", port: 0, allowedOrigins: [], sessionId: "someone-else" });

		const notifications = await runCommand("attach");

		assert.equal((await readConfig()).sessionId, sessionId);
		assert.ok(notifications.some((entry) => entry.message.includes(address)), JSON.stringify(notifications));
		assert.ok((await commandStatus()).includes(address));
	});

	it("detach stops the server and removes sessionId while preserving user config", async () => {
		await writeConfig({ bind: "127.0.0.1", port: 0, allowedOrigins: ["https://app.example"] });
		await runCommand("attach");
		const address = statusAddress(await commandStatus());

		await runCommand("detach");

		await assert.rejects(fetch(`${address}/message`, { method: "POST", body: "{}" }));
		assert.deepEqual(await readConfig(), {
			bind: "127.0.0.1",
			port: 0,
			allowedOrigins: ["https://app.example"],
		});
		assert.match(await commandStatus(), /not attached/i);
	});

	it("detach clears ownership even when this session is not serving", async () => {
		await writeConfig({ bind: "127.0.0.1", port: 0, allowedOrigins: [], sessionId: "someone-else" });

		const notifications = await runCommand("detach");

		assert.equal((await readConfig()).sessionId, undefined);
		assert.ok(notifications.some((entry) => /not running|detached/i.test(entry.message)), JSON.stringify(notifications));
	});

	it("does not report a successful detach when config ownership cannot be cleared", async () => {
		await rm(join(agentDir, "webhook.json"), { force: true });
		await mkdir(join(agentDir, "webhook.json"));

		const notifications = await runCommand("detach");

		assert.ok(
			notifications.some((entry) => entry.type === "error" && /could not (?:be )?clear|not cleared/i.test(entry.message)),
			JSON.stringify(notifications),
		);
		assert.ok(
			notifications.every((entry) => !/^Webhook detached\b/i.test(entry.message)),
			JSON.stringify(notifications),
		);
	});

	it("session_start serves only when the configured sessionId matches", async () => {
		await writeConfig({ bind: "127.0.0.1", port: 0, allowedOrigins: [], sessionId });

		await fireEvent("session_start", createStubCtx());

		const response = await fetch(`${statusAddress(await commandStatus())}/message`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "restored" }),
		});
		assert.equal(response.status, 202);
	});

	it("session_start does nothing for different or absent ownership", async () => {
		for (const configuredSessionId of ["someone-else", undefined]) {
			await writeConfig({ bind: "127.0.0.1", port: 0, allowedOrigins: [], sessionId: configuredSessionId });
			await fireEvent("session_start", createStubCtx());
			assert.match(await commandStatus(), /not running/i);
		}
	});

	it("session_start warns and does not serve malformed or invalid-session config", async () => {
		for (const config of ["not json {{", JSON.stringify({ bind: "127.0.0.1", port: 0, sessionId: 42 })]) {
			await writeFile(join(agentDir, "webhook.json"), config, "utf8");
			const ctx = createStubCtx();
			await assert.doesNotReject(fireEvent("session_start", ctx));
			assert.ok(ctx.notifications.some((entry) => entry.type === "warning" && /webhook\.json/.test(entry.message)));
			const statusNotifications = await runCommand("status");
			assert.match(statusNotifications.at(-1)!.message, /not running/i);
		}
	});

	it("session_shutdown stops serving but leaves ownership in config", async () => {
		const address = await startOnEphemeralPort();

		await fireEvent("session_shutdown", createStubCtx());

		await assert.rejects(fetch(`${address}/message`, { method: "POST", body: "{}" }));
		assert.equal((await readConfig()).sessionId, sessionId);
	});

	it("status and bare command report the configured attached session", async () => {
		await writeConfig({ bind: "127.0.0.1", port: 0, allowedOrigins: [], sessionId: "attached-session" });

		for (const command of ["", "status"]) {
			const [notification] = await runCommand(command);
			assert.match(notification!.message, /attached-session/);
			assert.match(notification!.message, /not running/i);
		}
	});

	it("uses the attach usage line for unknown commands, including old start and stop", async () => {
		const usage = "Usage: /webhook attach [port] | detach | status";
		for (const command of ["frobnicate", "start", "stop"]) {
			const notifications = await runCommand(command);
			assert.equal(notifications[0]?.message, usage);
		}
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
		const notifications = await runCommand("attach");
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

	it("rejects an origin when the allowlist is empty with 403 without injecting", async () => {
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

	it("allows an origin in the allowlist and echoes it on the response", async () => {
		const origin = "https://App.Example";
		const address = await startOnEphemeralPort(["https://app.example"]);

		const response = await fetch(`${address}/message`, {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify({ message: "allowed" }),
		});

		assert.equal(response.status, 202);
		assert.equal(response.headers.get("access-control-allow-origin"), origin);
		assert.deepEqual(stub.sendMessageCalls, [
			{
				message: { customType: "webhook", content: "allowed", display: true },
				options: { triggerTurn: true, deliverAs: "followUp" },
			},
		]);
	});

	it("allows any origin when the allowlist contains a wildcard", async () => {
		const address = await startOnEphemeralPort(["*"]);

		const response = await fetch(`${address}/message`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://anything.example" },
			body: JSON.stringify({ message: "wildcard" }),
		});

		assert.equal(response.status, 202);
		assert.equal(response.headers.get("access-control-allow-origin"), "*");
		assert.equal(stub.sendMessageCalls.length, 1);
	});

	it("rejects an origin not in a non-empty allowlist without injecting", async () => {
		const address = await startOnEphemeralPort(["https://allowed.example"]);

		const response = await fetch(`${address}/message`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://other.example" },
			body: JSON.stringify({ message: "blocked" }),
		});

		assert.equal(response.status, 403);
		assert.equal(response.headers.get("access-control-allow-origin"), null);
		assert.equal(stub.sendMessageCalls.length, 0);
	});

	it("allows requests without an Origin regardless of the allowlist", async () => {
		const address = await startOnEphemeralPort(["https://allowed.example"]);

		const response = await fetch(`${address}/message`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "non-browser" }),
		});

		assert.equal(response.status, 202);
		assert.equal(response.headers.get("access-control-allow-origin"), null);
		assert.equal(stub.sendMessageCalls.length, 1);
	});

	it("answers an allowlisted OPTIONS preflight with CORS headers", async () => {
		const origin = "https://app.example";
		const address = await startOnEphemeralPort([origin]);

		const response = await fetch(`${address}/message`, {
			method: "OPTIONS",
			headers: { origin },
		});

		assert.equal(response.status, 204);
		assert.equal(response.headers.get("access-control-allow-origin"), origin);
		assert.equal(response.headers.get("access-control-allow-methods"), "POST");
		assert.equal(response.headers.get("access-control-allow-headers"), "content-type");
		assert.equal(response.headers.get("access-control-max-age"), "600");
		assert.equal(stub.sendMessageCalls.length, 0);
	});

	it("rejects OPTIONS preflights from non-allowlisted or missing origins", async () => {
		const address = await startOnEphemeralPort(["https://allowed.example"]);

		for (const origin of ["https://other.example", undefined]) {
			const headers = origin === undefined ? undefined : { origin };
			const response = await fetch(`${address}/message`, { method: "OPTIONS", headers });
			assert.equal(response.status, 403);
		}

		assert.equal(stub.sendMessageCalls.length, 0);
	});

	it("responds 404 to OPTIONS on other paths", async () => {
		const address = await startOnEphemeralPort(["*"]);

		const response = await fetch(`${address}/other`, {
			method: "OPTIONS",
			headers: { origin: "https://app.example" },
		});

		assert.equal(response.status, 404);
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
		assert.equal(wrongMethod.headers.get("allow"), "POST, OPTIONS");

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
			sessionManager: { getSessionId: () => sessionId },
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

async function writeConfig(config: { bind: string; port: number; allowedOrigins?: string[]; sessionId?: string }): Promise<void> {
	await writeFile(join(agentDir, "webhook.json"), JSON.stringify(config), "utf8");
}

async function readConfig(): Promise<{ bind: string; port: number; allowedOrigins: string[]; sessionId?: string }> {
	return JSON.parse(await readFile(join(agentDir, "webhook.json"), "utf8")) as {
		bind: string;
		port: number;
		allowedOrigins: string[];
		sessionId?: string;
	};
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

async function startOnEphemeralPort(allowedOrigins: string[] = []): Promise<string> {
	await writeConfig({ bind: "127.0.0.1", port: 0, allowedOrigins });
	await runCommand("attach");

	const status = await commandStatus();
	return statusAddress(status);
}

function statusAddress(status: string): string {
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
