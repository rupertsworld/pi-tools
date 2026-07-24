/**
 * Webhook extension: HTTP ingress for injecting messages into the active session.
 *
 * Nothing listens until a session attaches or resumes its attachment;
 * session_shutdown always closes the server. POST /message with {"message": "..."}
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
	allowedOrigins: string[];
	sessionId?: string;
}

const DEFAULT_CONFIG: WebhookConfig = { bind: "127.0.0.1", port: 3729, allowedOrigins: [] };
const MAX_BODY_BYTES = 1_048_576;

class BodyTooLargeError extends Error {}

const USAGE = "Usage: /webhook attach [port] | detach | status";

export default function (pi: ExtensionAPI) {
	let server: Server | undefined;
	let lifecycleGeneration = 0;

	pi.on("session_start", async (_event, ctx) => {
		const config = await loadConfig(ctx, false, false);
		if (config?.sessionId !== ctx.sessionManager.getSessionId()) {
			updateStatus(ctx, "clear");
			return;
		}
		const started = await startServer(config, ctx);
		if (started) server = started;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await stopServer();
		updateStatus(ctx, "clear");
	});

	pi.registerCommand("webhook", {
		description: "Control the webhook server: attach [port] | detach | status",
		handler: async (args, ctx) => {
			const [subcommand, portArg] = args.trim().split(/\s+/).filter((part) => part.length > 0);
			switch (subcommand ?? "status") {
				case "attach":
					await handleAttach(portArg, ctx);
					return;
				case "detach":
					await handleDetach(ctx);
					return;
				case "status":
					notify(ctx, await statusMessage(ctx), "info");
					return;
				default:
					notify(ctx, USAGE, "info");
			}
		},
	});

	async function handleAttach(portArg: string | undefined, ctx: ExtensionContext): Promise<void> {
		let requestedPort: number | undefined;
		if (portArg !== undefined) {
			requestedPort = parsePort(portArg);
			if (requestedPort === undefined) {
				notify(ctx, `Invalid port "${portArg}". ${USAGE}`, "error");
				return;
			}
		}
		const config = await loadConfig(ctx, true, true);
		if (!config) return;
		if (requestedPort !== undefined) config.port = requestedPort;
		config.sessionId = ctx.sessionManager.getSessionId();
		if (!(await writeConfig(config, ctx))) return;
		if (server) {
			updateStatus(ctx, "listening", config);
			notify(ctx, await statusMessage(ctx), "info");
			return;
		}
		const started = await startServer(config, ctx);
		if (started) {
			server = started;
			notify(ctx, await statusMessage(ctx), "info");
		}
	}

	async function handleDetach(ctx: ExtensionContext): Promise<void> {
		const wasRunning = server !== undefined;
		await stopServer();
		updateStatus(ctx, "clear");
		const config = await loadConfig(ctx, false, true);
		if (config) {
			delete config.sessionId;
			if (!(await writeConfig(config, ctx))) {
				notify(ctx, "Webhook stopped here, but its configured attachment could not be cleared.", "error");
				return;
			}
		}
		notify(ctx, wasRunning ? "Webhook detached and stopped." : "Webhook detached; it was not running here.", "info");
	}

	async function statusMessage(ctx: ExtensionContext): Promise<string> {
		const config = await loadConfig(ctx, false, false);
		const attachment = config?.sessionId ? `Attached session: ${config.sessionId}.` : "Not attached.";
		const address = server?.address();
		if (!address || typeof address !== "object") return `Webhook not running. ${attachment}`;
		const base = `http://${address.address}:${address.port}`;
		return `Webhook listening at ${base}. ${attachment} Send: curl -X POST ${base}/message -H 'Content-Type: application/json' -d '{"message":"..."}'`;
	}

	function startServer(config: WebhookConfig, ctx: ExtensionContext): Promise<Server | undefined> {
		const generation = ++lifecycleGeneration;
		return new Promise((resolve) => {
			const candidate = createServer((request, response) => {
				handleRequest(request, response, config).catch(() => {
					if (!response.headersSent) sendJson(response, 500, { ok: false, error: "internal error" });
					else response.destroy();
				});
			});
			const onBindError = (error: Error) => {
				candidate.close();
				if (generation !== lifecycleGeneration) {
					resolve(undefined);
					return;
				}
				updateStatus(ctx, "port-held");
				notify(
					ctx,
					`Webhook failed to listen on ${config.bind}:${config.port} (${error.message}). Another session may still hold the port; it releases on shutdown or /webhook detach. Continuing without webhook.`,
					"error",
				);
				resolve(undefined);
			};
			candidate.once("error", onBindError);
			candidate.listen(config.port, config.bind, () => {
				candidate.removeListener("error", onBindError);
				if (generation !== lifecycleGeneration) {
					candidate.close();
					resolve(undefined);
					return;
				}
				candidate.on("error", (error) => {
					if (server !== candidate) return;
					notify(ctx, `Webhook server error: ${error.message}.`, "error");
					if (!candidate.listening) {
						server = undefined;
						updateStatus(ctx, "error");
					}
				});
				updateStatus(ctx, "listening", config, candidate);
				resolve(candidate);
			});
		});
	}

	async function stopServer(): Promise<void> {
		lifecycleGeneration += 1;
		if (!server) return;
		const closing = server;
		server = undefined;
		await new Promise<void>((resolve) => {
			closing.close(() => resolve());
			closing.closeAllConnections();
		});
	}

	function updateStatus(
		ctx: ExtensionContext,
		state: "listening" | "port-held" | "error" | "clear",
		config?: WebhookConfig,
		listeningServer: Server | undefined = server,
	): void {
		if (!ctx.hasUI) return;
		let value: string | undefined;
		let color: "success" | "warning" = "success";
		if (state === "listening") {
			const address = listeningServer?.address();
			value =
				address && typeof address === "object"
					? `${address.address}:${address.port}`
					: `${config?.bind ?? DEFAULT_CONFIG.bind}:${config?.port ?? DEFAULT_CONFIG.port}`;
		} else if (state === "port-held") {
			value = "port held";
			color = "warning";
		} else if (state === "error") {
			value = "error";
			color = "warning";
		}
		const text =
			value === undefined
				? undefined
				: `${ctx.ui.theme.fg("accent", "webhook")} ${ctx.ui.theme.fg(color, value)}`;
		ctx.ui.setStatus("webhook", text);
	}

	async function handleRequest(request: IncomingMessage, response: ServerResponse, config: WebhookConfig): Promise<void> {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		if (pathname !== "/message") {
			sendJson(response, 404, { ok: false, error: "not found" });
			return;
		}
		const origin = request.headers.origin;
		const allowedOrigin = origin === undefined ? undefined : matchAllowedOrigin(origin, config.allowedOrigins);
		if (request.method === "OPTIONS") {
			if (allowedOrigin === undefined) {
				sendJson(response, 403, { ok: false, error: "origin is not allowed" });
				return;
			}
			response.writeHead(204, {
				"access-control-allow-origin": allowedOrigin,
				"access-control-allow-methods": "POST",
				"access-control-allow-headers": "content-type",
				"access-control-max-age": "600",
			});
			response.end();
			return;
		}
		if (request.method !== "POST") {
			response.setHeader("allow", "POST, OPTIONS");
			sendJson(response, 405, { ok: false, error: "method not allowed" });
			return;
		}
		if (origin !== undefined && allowedOrigin === undefined) {
			sendJson(response, 403, { ok: false, error: "origin is not allowed" });
			return;
		}
		if (allowedOrigin !== undefined) response.setHeader("access-control-allow-origin", allowedOrigin);
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
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		sendJson(response, 202, { ok: true });
	}
}

async function loadConfig(
	ctx: ExtensionContext,
	createIfMissing: boolean,
	fallbackOnInvalid: boolean,
): Promise<WebhookConfig | undefined> {
	const configPath = join(getAgentDir(), "webhook.json");

	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") {
			if (!createIfMissing) return undefined;
			const config = defaultConfig();
			await writeConfig(config, ctx);
			return config;
		} else {
			notify(ctx, `Webhook could not read ${configPath} (${describeError(error)}). Using defaults.`, "warning");
		}
		return fallbackOnInvalid ? defaultConfig() : undefined;
	}

	const config = parseConfig(raw);
	if (!config) {
		notify(ctx, `Webhook config ${configPath} is invalid. Using defaults (bind ${DEFAULT_CONFIG.bind}, port ${DEFAULT_CONFIG.port}).`, "warning");
		return fallbackOnInvalid ? defaultConfig() : undefined;
	}
	return config;
}

async function writeConfig(config: WebhookConfig, ctx: ExtensionContext): Promise<boolean> {
	const configPath = join(getAgentDir(), "webhook.json");
	try {
		await writeFile(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
		return true;
	} catch (error) {
		notify(ctx, `Webhook could not write ${configPath} (${describeError(error)}).`, "error");
		return false;
	}
}

function parseConfig(raw: string): WebhookConfig | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;

	const { bind, port, allowedOrigins, sessionId } = parsed as {
		bind?: unknown;
		port?: unknown;
		allowedOrigins?: unknown;
		sessionId?: unknown;
	};
	if (bind !== undefined && typeof bind !== "string") return undefined;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)) return undefined;
	if (allowedOrigins !== undefined && (!Array.isArray(allowedOrigins) || !allowedOrigins.every((origin) => typeof origin === "string"))) {
		return undefined;
	}
	if (sessionId !== undefined && typeof sessionId !== "string") return undefined;

	return {
		bind: bind ?? DEFAULT_CONFIG.bind,
		port: port ?? DEFAULT_CONFIG.port,
		allowedOrigins: allowedOrigins ?? DEFAULT_CONFIG.allowedOrigins,
		...(sessionId === undefined ? {} : { sessionId }),
	};
}

function defaultConfig(): WebhookConfig {
	return { ...DEFAULT_CONFIG, allowedOrigins: [...DEFAULT_CONFIG.allowedOrigins] };
}

function matchAllowedOrigin(origin: string, allowedOrigins: string[]): string | undefined {
	if (allowedOrigins.includes("*")) return "*";
	return allowedOrigins.some((allowedOrigin) => allowedOrigin.toLowerCase() === origin.toLowerCase()) ? origin : undefined;
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
