/**
 * Webhook extension: HTTP ingress for injecting messages into the active session.
 *
 * Nothing listens until /webhook start; /webhook stop stops the server, and
 * session_shutdown always closes it. POST /message with {"message": "..."}
 * injects the message into the session via pi.sendMessage. Configuration lives
 * in webhook.json in the coding-agent home. See SPEC.md.
 */

import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface WebhookConfig {
	bind: string;
	port: number;
}

const DEFAULT_CONFIG: WebhookConfig = { bind: "127.0.0.1", port: 3729 };
const MAX_BODY_BYTES = 1_048_576;

class BodyTooLargeError extends Error {}

const USAGE = "Usage: /webhook start [port] | stop | status";

export default function (pi: ExtensionAPI) {
	let server: Server | undefined;

	pi.on("session_shutdown", async () => {
		await stopServer();
	});

	pi.registerCommand("webhook", {
		description: "Control the webhook server: start [port] | stop | status",
		handler: async (args, ctx) => {
			const [subcommand, portArg] = args.trim().split(/\s+/).filter((part) => part.length > 0);
			switch (subcommand ?? "status") {
				case "start":
					await handleStart(portArg, ctx);
					return;
				case "stop":
					await handleStop(ctx);
					return;
				case "status":
					notify(ctx, statusMessage(), "info");
					return;
				default:
					notify(ctx, USAGE, "info");
			}
		},
	});

	async function handleStart(portArg: string | undefined, ctx: ExtensionContext): Promise<void> {
		if (server) {
			notify(ctx, `Webhook already running. ${statusMessage()}`, "info");
			return;
		}
		let portOverride: number | undefined;
		if (portArg !== undefined) {
			portOverride = parsePort(portArg);
			if (portOverride === undefined) {
				notify(ctx, `Invalid port "${portArg}". ${USAGE}`, "error");
				return;
			}
		}
		const config = await loadConfig(ctx);
		if (portOverride !== undefined) config.port = portOverride;
		server = await startServer(config, ctx);
		if (server) notify(ctx, statusMessage(), "info");
	}

	async function handleStop(ctx: ExtensionContext): Promise<void> {
		if (!server) {
			notify(ctx, "Webhook not running.", "info");
			return;
		}
		await stopServer();
		notify(ctx, "Webhook stopped.", "info");
	}

	function statusMessage(): string {
		const address = server?.address();
		if (!address || typeof address !== "object") return "Webhook not running. Start with /webhook start.";
		const base = `http://${address.address}:${address.port}`;
		return `Webhook listening at ${base} — send: curl -X POST ${base}/message -d '{"message":"..."}'`;
	}

	function startServer(config: WebhookConfig, ctx: ExtensionContext): Promise<Server | undefined> {
		return new Promise((resolve) => {
			const candidate = createServer((request, response) => {
				handleRequest(request, response).catch(() => {
					if (!response.headersSent) sendJson(response, 500, { ok: false, error: "internal error" });
					else response.destroy();
				});
			});
			const onBindError = (error: Error) => {
				notify(ctx, `Webhook failed to listen on ${config.bind}:${config.port} (${error.message}). Continuing without webhook.`, "error");
				resolve(undefined);
			};
			candidate.once("error", onBindError);
			candidate.listen(config.port, config.bind, () => {
				candidate.removeListener("error", onBindError);
				candidate.on("error", (error) => {
					notify(ctx, `Webhook server error: ${error.message}.`, "error");
				});
				resolve(candidate);
			});
		});
	}

	async function stopServer(): Promise<void> {
		if (!server) return;
		const closing = server;
		server = undefined;
		await new Promise<void>((resolve) => {
			closing.close(() => resolve());
			closing.closeAllConnections();
		});
	}

	async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		if (pathname !== "/message") {
			sendJson(response, 404, { ok: false, error: "not found" });
			return;
		}
		if (request.method !== "POST") {
			response.setHeader("allow", "POST");
			sendJson(response, 405, { ok: false, error: "method not allowed" });
			return;
		}
		if (request.headers.origin !== undefined) {
			sendJson(response, 403, { ok: false, error: "browser requests are not allowed" });
			return;
		}
		if (!isJsonContentType(request.headers["content-type"])) {
			sendJson(response, 415, { ok: false, error: "content-type must be application/json" });
			return;
		}

		let raw: string;
		try {
			raw = await readBody(request, MAX_BODY_BYTES);
		} catch (error) {
			if (error instanceof BodyTooLargeError) {
				sendJson(response, 413, { ok: false, error: `request body exceeds ${MAX_BODY_BYTES} bytes` });
				response.once("finish", () => request.socket.destroy());
				return;
			}
			throw error;
		}

		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			sendJson(response, 400, { ok: false, error: "request body must be valid JSON" });
			return;
		}

		const message = (body as { message?: unknown } | null)?.message;
		if (typeof message !== "string" || message.length === 0) {
			sendJson(response, 400, { ok: false, error: "body must be {\"message\": \"<non-empty string>\"}" });
			return;
		}

		pi.sendMessage(
			{ customType: "webhook", content: message, display: true },
			{ triggerTurn: true, deliverAs: "steer" },
		);
		sendJson(response, 202, { ok: true });
	}
}

async function loadConfig(ctx: ExtensionContext): Promise<WebhookConfig> {
	const configPath = join(getAgentDir(), "webhook.json");

	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") {
			try {
				await writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, "\t")}\n`, "utf8");
			} catch (writeError) {
				notify(ctx, `Webhook could not create ${configPath} (${describeError(writeError)}). Using defaults.`, "warning");
			}
		} else {
			notify(ctx, `Webhook could not read ${configPath} (${describeError(error)}). Using defaults.`, "warning");
		}
		return { ...DEFAULT_CONFIG };
	}

	const config = parseConfig(raw);
	if (!config) {
		notify(ctx, `Webhook config ${configPath} is invalid. Using defaults (bind ${DEFAULT_CONFIG.bind}, port ${DEFAULT_CONFIG.port}).`, "warning");
		return { ...DEFAULT_CONFIG };
	}
	return config;
}

function parseConfig(raw: string): WebhookConfig | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;

	const { bind, port } = parsed as { bind?: unknown; port?: unknown };
	if (bind !== undefined && typeof bind !== "string") return undefined;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)) return undefined;

	return {
		bind: bind ?? DEFAULT_CONFIG.bind,
		port: port ?? DEFAULT_CONFIG.port,
	};
}

function parsePort(raw: string): number | undefined {
	if (!/^\d+$/.test(raw)) return undefined;
	const port = Number(raw);
	if (!Number.isInteger(port) || port > 65535) return undefined;
	return port;
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function isJsonContentType(header: string | undefined): boolean {
	if (!header) return false;
	const mediaType = header.split(";", 1)[0]?.trim().toLowerCase();
	return mediaType === "application/json";
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let received = 0;
		const onData = (chunk: Buffer) => {
			received += chunk.length;
			if (received > maxBytes) {
				request.removeListener("data", onData);
				request.pause();
				reject(new BodyTooLargeError("request body too large"));
				return;
			}
			chunks.push(chunk);
		};
		request.on("data", onData);
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

function sendJson(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(payload));
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
