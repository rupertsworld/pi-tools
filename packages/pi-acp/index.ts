/**
 * ACP extension: exposes the live pi session over ACP on a unix socket.
 *
 * With autoStart (the default) the listener binds on session_start when the
 * socket is free or stale; a socket held by another live pi means this session
 * stands down. /acp attach claims the socket, with cooperative takeover via the
 * _pi-acp/release extension method; /acp detach frees it. session_shutdown
 * always closes the listener and disconnects clients. Configuration lives in
 * acp.json in the coding-agent home. See SPEC.md.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface AcpConfig {
	autoStart: boolean;
	socketPath?: string;
}

const DEFAULT_CONFIG: AcpConfig = { autoStart: true };
const VERSION = "0.1.0";
const RELEASE_METHOD = "_pi-acp/release";
const PROBE_TIMEOUT_MS = 500;
const RELEASE_TIMEOUT_MS = 2000;
const USAGE = "Usage: /acp status | attach | detach";

/** The slice of the live session the per-connection ACP agent drives. */
interface AgentHost {
	getSessionId(): string;
	/** Inject text as a user message; queues as a follow-up when mid-turn. */
	sendPrompt(text: string): void;
	/** Abort the session's current run. */
	abort(): void;
	/** Cooperative takeover: close the listener and notify the session. */
	release(requester: Socket | undefined): Promise<void>;
}

export default function (pi: ExtensionAPI) {
	let server: Server | undefined;
	let serverPath: string | undefined;
	let latestCtx: ExtensionContext | undefined;
	const sockets = new Set<Socket>();
	const agents = new Set<PiAcpAgent>();
	// Fallback only: used when no event has delivered a ctx yet (loadSession is
	// false, so the id is opaque to clients either way).
	const fallbackSessionId = `pi-acp-${randomUUID()}`;

	const exitHook = () => {
		if (!serverPath) return;
		try {
			unlinkSync(serverPath);
		} catch {
			// best effort
		}
	};

	const host: AgentHost = {
		getSessionId() {
			return latestCtx?.sessionManager.getSessionId() ?? fallbackSessionId;
		},
		sendPrompt(text) {
			if (latestCtx && !latestCtx.isIdle()) {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
			} else {
				pi.sendUserMessage(text);
			}
		},
		abort() {
			latestCtx?.abort();
		},
		async release(requester) {
			if (!server) return;
			const closing = server;
			const path = serverPath!;
			server = undefined;
			serverPath = undefined;
			process.removeListener("exit", exitHook);
			// Free the path first so the claimant can bind as soon as we respond.
			await unlinkQuiet(path);
			closing.close();
			// Drop other clients now; they reconnect to the new holder. The
			// requester's socket must outlive the JSON-RPC response, so it is only
			// half-closed after a grace period (the claimant normally closes first).
			for (const socket of [...sockets]) {
				if (socket !== requester) socket.destroy();
			}
			if (requester) setTimeout(() => requester.end(), 100).unref();
			notify(latestCtx, `ACP socket ${path} released to another session; this session continues without a listener.`, "info");
		},
	};

	const forward = (event: unknown) => {
		for (const agent of [...agents]) agent.handleSessionEvent(event as { type: string });
	};

	for (const type of ["message_update", "tool_execution_start", "tool_execution_update", "tool_execution_end", "agent_settled"] as const) {
		pi.on(type as "agent_settled", (event, ctx) => {
			latestCtx = ctx;
			forward(event);
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		if (server) return;
		const config = await loadConfig(ctx);
		if (!config.autoStart) return;
		const path = resolveSocketPath(config);
		// Auto-start never takes the socket from a live holder.
		const probe = await probeListener(path);
		if (probe.alive) {
			notify(ctx, `ACP: another live listener holds ${path}; this session runs without ACP. Use /acp attach to take over.`, "info");
			return;
		}
		await unlinkIfUnchanged(path, probe.identity);
		if (!(await bindListener(path))) {
			notify(ctx, `ACP could not listen at ${path}; this session continues without ACP.`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		await closeListener();
	});

	pi.registerCommand("acp", {
		description: "ACP socket: status (default) | attach | detach",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const [subcommand] = args.trim().split(/\s+/).filter((part) => part.length > 0);
			switch (subcommand ?? "status") {
				case "status":
					notify(ctx, await statusMessage(ctx), "info");
					return;
				case "attach":
					await handleAttach(ctx);
					return;
				case "detach":
					await handleDetach(ctx);
					return;
				default:
					notify(ctx, USAGE, "info");
			}
		},
	});

	async function statusMessage(ctx: ExtensionContext): Promise<string> {
		if (server && serverPath) {
			return `ACP listening at ${serverPath} (this session holds the listener).`;
		}
		const path = resolveSocketPath(await loadConfig(ctx));
		if (await isListenerAlive(path)) {
			return `ACP not attached. ${path} is held by another process. Use /acp attach to take over.`;
		}
		return `ACP not attached. ${path} is free. Use /acp attach to claim it.`;
	}

	async function handleAttach(ctx: ExtensionContext): Promise<void> {
		if (server && serverPath) {
			notify(ctx, `ACP already listening at ${serverPath} (this session holds the listener).`, "info");
			return;
		}
		const path = resolveSocketPath(await loadConfig(ctx));
		const probe = await probeListener(path);
		if (probe.alive) {
			const outcome = await requestRelease(path);
			if (outcome !== "released") {
				notify(
					ctx,
					outcome === "unresponsive"
						? `ACP attach failed: the holder of ${path} did not respond to a release request; leaving it alone.`
						: `ACP attach failed: the holder of ${path} refused the release request; leaving it alone.`,
					"error",
				);
				return;
			}
		} else {
			await unlinkIfUnchanged(path, probe.identity);
		}
		if (await bindListener(path)) {
			notify(ctx, `ACP listening at ${path} (this session holds the listener).`, "info");
		} else {
			notify(ctx, `ACP attach failed: could not bind ${path} (another listener won the race).`, "error");
		}
	}

	async function handleDetach(ctx: ExtensionContext): Promise<void> {
		if (!server) {
			notify(ctx, "ACP not attached; nothing to detach.", "info");
			return;
		}
		const path = serverPath;
		await closeListener();
		notify(ctx, `ACP detached; ${path} released for another session to claim.`, "info");
	}

	/** Bind the listener at `path`. Returns false on a lost bind race. */
	async function bindListener(path: string): Promise<boolean> {
		const candidate = createServer((socket) => {
			socket.on("error", (error) => logError(`connection error: ${error.message}`));
			try {
				const stream = acp.ndJsonStream(
					Writable.toWeb(socket) as WritableStream<Uint8Array>,
					Readable.toWeb(socket) as ReadableStream<Uint8Array>,
				);
				// Each connection gets its own agent bound to the one live session.
				let agent: PiAcpAgent | undefined;
				new acp.AgentSideConnection((conn) => {
					agent = new PiAcpAgent(conn, host, socket);
					agents.add(agent);
					return agent;
				}, stream);
				sockets.add(socket);
				socket.once("close", () => {
					sockets.delete(socket);
					if (agent) {
						agents.delete(agent);
						agent.dispose();
					}
				});
			} catch (error) {
				logError(`failed to attach connection: ${describeError(error)}`);
				socket.destroy();
			}
		});

		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => reject(error);
				candidate.once("error", onError);
				candidate.listen(path, () => {
					candidate.off("error", onError);
					resolve();
				});
			});
		} catch (error) {
			// Lost a concurrent double-start race: another pi bound the socket
			// between our probe and our listen. Stand down rather than throw.
			if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
				return false;
			}
			logError(`could not listen at ${path}: ${describeError(error)}`);
			return false;
		}

		candidate.on("error", (error) => logError(`server error: ${error.message}`));
		server = candidate;
		serverPath = path;
		process.once("exit", exitHook);
		return true;
	}

	/** Close the listener, remove the socket file, and disconnect all clients. */
	async function closeListener(): Promise<void> {
		if (!server) return;
		const closing = server;
		const path = serverPath!;
		server = undefined;
		serverPath = undefined;
		process.removeListener("exit", exitHook);
		const closed = new Promise<void>((resolve) => closing.close(() => resolve()));
		for (const socket of [...sockets]) socket.destroy();
		sockets.clear();
		for (const agent of [...agents]) agent.dispose();
		agents.clear();
		await closed;
		await unlinkQuiet(path);
	}
}

/**
 * ACP agent for one socket connection, driving the single live session via the
 * extension host. Mirrors the pino ACP agent, with turn completion keyed on
 * pi's `agent_settled` (fired only after retries, compaction, and queued
 * continuations have fully settled).
 */
class PiAcpAgent implements acp.Agent {
	private readonly conn: acp.AgentSideConnection;
	private readonly host: AgentHost;
	private readonly socket: Socket;
	private readonly resolveTurns = new Set<() => void>();
	private cancelled = false;

	constructor(conn: acp.AgentSideConnection, host: AgentHost, socket: Socket) {
		this.conn = conn;
		this.host = host;
		this.socket = socket;
	}

	async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
		return {
			protocolVersion: acp.PROTOCOL_VERSION,
			agentInfo: { name: "pi-acp", version: VERSION },
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { image: false, audio: false },
			},
			authMethods: [],
		};
	}

	async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
		return {};
	}

	async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
		// Bind to the single live session: no id bookkeeping, no history replay.
		// Advertise an empty config surface so a conformant client never calls
		// session/set_config_option.
		return { sessionId: this.host.getSessionId(), configOptions: [] };
	}

	async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
		this.cancelled = false;
		const text = extractText(params.prompt);

		let turnError: unknown;
		let resolveTurn!: () => void;
		const turnEnded = new Promise<void>((resolve) => {
			resolveTurn = resolve;
			this.resolveTurns.add(resolve);
		});
		try {
			this.host.sendPrompt(text);
		} catch (error) {
			// A prompt that cannot run at all (e.g. no model credentials) must not
			// leave the client stuck waiting: surface it and end the turn.
			turnError = error;
			resolveTurn();
		}
		await turnEnded;
		this.resolveTurns.delete(resolveTurn);

		if (turnError !== undefined && !this.cancelled) {
			const message = turnError instanceof Error ? turnError.message : String(turnError);
			this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `⚠️ ${message}` } });
		}
		return { stopReason: this.cancelled ? "cancelled" : "end_turn" };
	}

	async cancel(_params: acp.CancelNotification): Promise<void> {
		this.cancelled = true;
		this.host.abort();
	}

	async extMethod(method: string, _params: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (method === RELEASE_METHOD) {
			// Cooperative takeover: stand down so the caller can bind the socket.
			await this.host.release(this.socket);
			return {};
		}
		throw acp.RequestError.methodNotFound(method);
	}

	/** Tear down this connection's turn state when its socket closes. */
	dispose(): void {
		for (const resolve of this.resolveTurns) resolve();
		this.resolveTurns.clear();
	}

	handleSessionEvent(event: { type: string } & Record<string, unknown>): void {
		switch (event.type) {
			case "message_update": {
				const inner = event.assistantMessageEvent as { type: string; delta?: string } | undefined;
				if (inner?.type === "text_delta" && typeof inner.delta === "string") {
					this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: inner.delta } });
				}
				break;
			}
			case "tool_execution_start": {
				const e = event as unknown as { toolCallId: string; toolName: string; args: unknown };
				this.send({
					sessionUpdate: "tool_call",
					toolCallId: e.toolCallId,
					title: e.toolName,
					kind: mapKind(e.toolName),
					status: "in_progress",
					rawInput: e.args as Record<string, unknown>,
				});
				break;
			}
			case "tool_execution_update": {
				const e = event as unknown as { toolCallId: string; partialResult: unknown };
				this.send({
					sessionUpdate: "tool_call_update",
					toolCallId: e.toolCallId,
					status: "in_progress",
					content: [{ type: "content", content: { type: "text", text: stringifyResult(e.partialResult) } }],
					rawOutput: e.partialResult as Record<string, unknown>,
				});
				break;
			}
			case "tool_execution_end": {
				const e = event as unknown as { toolCallId: string; result: unknown; isError: boolean };
				this.send({
					sessionUpdate: "tool_call_update",
					toolCallId: e.toolCallId,
					status: e.isError ? "failed" : "completed",
					content: [{ type: "content", content: { type: "text", text: stringifyResult(e.result) } }],
					rawOutput: e.result as Record<string, unknown>,
				});
				break;
			}
			case "agent_settled": {
				// The turn ends only when the run has fully settled: after any
				// automatic retry, compaction, or queued continuation.
				for (const resolve of this.resolveTurns) resolve();
				break;
			}
		}
	}

	/** Fire a session update to the client; never let a write error escape. */
	private send(update: acp.SessionUpdate): void {
		void this.conn.sessionUpdate({ sessionId: this.host.getSessionId(), update }).catch(() => {});
	}
}

export function mapKind(toolName: string): acp.ToolKind {
	switch (toolName.toLowerCase()) {
		case "read":
			return "read";
		case "bash":
			return "execute";
		case "edit":
		case "write":
			return "edit";
		case "grep":
		case "find":
		case "ls":
			return "search";
		default:
			return "other";
	}
}

/** Resolve true if something is actively listening on the socket path. */
async function isListenerAlive(path: string): Promise<boolean> {
	return (await probeListener(path)).alive;
}

interface FileIdentity {
	dev: number;
	ino: number;
}

/**
 * Probe the path and retain the identity of any stale entry. Keeping the
 * identity lets the caller remove only the file it actually probed, rather
 * than unlinking a live socket created by a bind-race winner.
 */
async function probeListener(path: string): Promise<{ alive: boolean; identity?: FileIdentity }> {
	let identity: FileIdentity | undefined;
	try {
		const info = await lstat(path);
		identity = { dev: info.dev, ino: info.ino };
	} catch {
		// Missing or unreadable: the connect probe below is authoritative.
	}

	const alive = await new Promise<boolean>((resolve) => {
		const probe = connect(path);
		const settle = (result: boolean) => {
			clearTimeout(timer);
			probe.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => settle(false), PROBE_TIMEOUT_MS);
		probe.once("connect", () => settle(true));
		probe.once("error", () => settle(false));
	});
	return { alive, identity };
}

async function unlinkIfUnchanged(path: string, identity: FileIdentity | undefined): Promise<void> {
	if (!identity) return;
	try {
		const current = await lstat(path);
		if (current.dev === identity.dev && current.ino === identity.ino) {
			await unlink(path);
		}
	} catch {
		// Missing, replaced, or already removed.
	}
}

/**
 * Ask the live holder of `path` to stand down via the _pi-acp/release ext
 * method, speaking raw newline-delimited JSON-RPC so no handshake is needed.
 */
function requestRelease(path: string, timeoutMs = RELEASE_TIMEOUT_MS): Promise<"released" | "refused" | "unresponsive"> {
	return new Promise((resolve) => {
		const socket = connect(path);
		let settled = false;
		let buffer = "";
		const settle = (result: "released" | "refused" | "unresponsive") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => settle("unresponsive"), timeoutMs);
		socket.once("error", () => settle("unresponsive"));
		socket.once("connect", () => {
			socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: RELEASE_METHOD, params: {} })}\n`);
		});
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let message: { id?: unknown; error?: unknown };
				try {
					message = JSON.parse(line) as { id?: unknown; error?: unknown };
				} catch {
					continue;
				}
				if (message.id === 0) {
					settle(message.error === undefined ? "released" : "refused");
					return;
				}
			}
		});
	});
}

async function loadConfig(ctx: ExtensionContext | undefined): Promise<AcpConfig> {
	const configPath = join(getAgentDir(), "acp.json");
	const { readFile, writeFile } = await import("node:fs/promises");

	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") {
			try {
				await mkdir(getAgentDir(), { recursive: true });
				await writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, "\t")}\n`, "utf8");
			} catch (writeError) {
				notify(ctx, `ACP could not create ${configPath} (${describeError(writeError)}). Using defaults.`, "warning");
			}
		} else {
			notify(ctx, `ACP could not read ${configPath} (${describeError(error)}). Using defaults.`, "warning");
		}
		return { ...DEFAULT_CONFIG };
	}

	const config = parseConfig(raw);
	if (!config) {
		notify(ctx, `ACP config ${configPath} is invalid. Using defaults (autoStart ${DEFAULT_CONFIG.autoStart}).`, "warning");
		return { ...DEFAULT_CONFIG };
	}
	return config;
}

function parseConfig(raw: string): AcpConfig | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

	const { autoStart, socketPath } = parsed as { autoStart?: unknown; socketPath?: unknown };
	if (autoStart !== undefined && typeof autoStart !== "boolean") return undefined;
	if (socketPath !== undefined && (typeof socketPath !== "string" || socketPath.length === 0)) return undefined;

	return {
		autoStart: autoStart ?? DEFAULT_CONFIG.autoStart,
		...(socketPath !== undefined ? { socketPath } : {}),
	};
}

function resolveSocketPath(config: AcpConfig): string {
	return config.socketPath ?? join(getAgentDir(), "acp.sock");
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function extractText(blocks: acp.ContentBlock[]): string {
	return blocks
		.filter((block): block is Extract<acp.ContentBlock, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function stringifyResult(result: unknown): string {
	if (typeof result === "string") return result;
	if (result === undefined || result === null) return "";
	try {
		return JSON.stringify(result);
	} catch {
		return String(result);
	}
}

async function unlinkQuiet(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch {
		// missing or already removed
	}
}

function notify(ctx: ExtensionContext | undefined, message: string, type: "info" | "warning" | "error"): void {
	if (ctx?.hasUI) ctx.ui.notify(message, type);
	else logError(message);
}

function logError(message: string): void {
	process.stderr.write(`[pi-acp] ${message}\n`);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
