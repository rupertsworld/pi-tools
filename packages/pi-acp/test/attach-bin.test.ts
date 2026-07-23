import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "pi-acp.mjs");

let dir: string;
let server: Server | undefined;
let child: ChildProcess | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-acp-"));
});

afterEach(async () => {
	child?.kill("SIGKILL");
	child = undefined;
	if (server) {
		await new Promise<void>((resolve) => server!.close(() => resolve()));
		server = undefined;
	}
	await rm(dir, { recursive: true, force: true });
});

function listenEcho(path: string): Promise<Socket[]> {
	const sockets: Socket[] = [];
	server = createServer((socket) => {
		sockets.push(socket);
		socket.on("data", (chunk) => socket.write(chunk));
		socket.on("error", () => {});
	});
	return new Promise((resolve, reject) => {
		server!.once("error", reject);
		server!.listen(path, () => resolve(sockets));
	});
}

function spawnBin(args: string[], env: Record<string, string | undefined> = {}): ChildProcess {
	child = spawn(process.execPath, [BIN, ...args], {
		env: { ...process.env, PI_CODING_AGENT_DIR: undefined, ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	return child;
}

function waitExit(proc: ChildProcess): Promise<number | null> {
	return new Promise((resolve) => proc.once("exit", (code) => resolve(code)));
}

describe("pi-acp relay", () => {
	it("relays bytes between stdio and the socket and exits 0 when the socket closes", async () => {
		const path = join(dir, "acp.sock");
		const sockets = await listenEcho(path);

		const proc = spawnBin([path]);
		let stdout = "";
		proc.stdout!.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});

		proc.stdin!.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
		await waitUntil(() => stdout.includes('"method":"ping"'));

		// Server-side close ends the relay with exit 0.
		for (const socket of sockets) socket.destroy();
		const code = await waitExit(proc);
		assert.equal(code, 0);
	});

	it("resolves the socket path from PI_CODING_AGENT_DIR when no argument is given", async () => {
		const path = join(dir, "acp.sock");
		await listenEcho(path);

		const proc = spawnBin([], { PI_CODING_AGENT_DIR: dir });
		let stdout = "";
		proc.stdout!.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});

		proc.stdin!.write("hello\n");
		await waitUntil(() => stdout.includes("hello"));
		proc.kill();
	});

	it("exits 1 with a stderr message when the socket cannot be reached", async () => {
		const missing = join(dir, "missing.sock");
		const proc = spawnBin([missing]);
		let stderr = "";
		proc.stderr!.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		const code = await waitExit(proc);
		assert.equal(code, 1);
		assert.ok(stderr.includes(missing), stderr);
	});
});

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
