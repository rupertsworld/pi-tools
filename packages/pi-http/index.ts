/**
 * Structured HTTP calling tool for pi agents.
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const BODY_LIMIT_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_REDIRECT_HOPS = 10;
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

type HttpDetails = {
	status: number;
	headers: Record<string, string>;
	contentType: string;
	size: number;
	truncated: boolean;
	body?: string;
};

type AllowPattern =
	| { kind: "any"; raw: string }
	| { kind: "origin"; raw: string; origin: string }
	| { kind: "host"; raw: string; hostname: string; port: string | null };

type HttpRestriction = {
	base?: URL;
	baseRaw?: string;
	allow: AllowPattern[];
};

type HttpConfig = {
	restriction?: HttpRestriction;
};

type RenderTheme = Pick<Theme, "fg">;
type RenderableResult = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
};

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "http",
		label: "HTTP Request",
		description: "Make an HTTP or HTTPS request and return the response.",
		parameters: Type.Object({
			url: Type.String({
				minLength: 1,
				description: "HTTP or HTTPS URL, or a path relative to the configured base when one is set",
			}),
			method: Type.Optional(StringEnum(methods)),
			headers: Type.Optional(Type.Record(Type.String(), Type.String())),
			body: Type.Optional(Type.Union([
				Type.String(),
				Type.Object({}, { additionalProperties: true }),
			])),
			timeoutSeconds: Type.Optional(Type.Number({
				exclusiveMinimum: 0,
				description: "Positive timeout for the complete request, in seconds",
			})),
		}),
		async execute(_toolCallId, params) {
			const method = params.method ?? "GET";
			const timeoutSeconds = params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

			const config = await loadHttpConfig();
			if ("error" in config) return errorResult(config.error);
			const restriction = config.restriction;
			const base = restriction?.base;

			let url: URL;
			try {
				url = base === undefined ? new URL(params.url) : new URL(params.url, base);
			} catch {
				return errorResult("Invalid URL. The URL must use http:// or https://.");
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				return errorResult("Invalid URL scheme. The URL must use http:// or https://.");
			}
			if (restriction !== undefined && !isAllowedServer(url, restriction)) {
				return errorResult(refusalMessage("Request", url, restriction));
			}
			if ((method === "GET" || method === "HEAD") && params.body !== undefined) {
				return errorResult(`${method} requests cannot include a body.`);
			}

			let headers: Headers;
			try {
				headers = new Headers(params.headers);
			} catch (error) {
				return errorResult(`Invalid HTTP headers: ${describeError(error)}`);
			}
			let body: string | undefined;
			if (typeof params.body === "string") {
				body = params.body;
			} else if (params.body !== undefined) {
				try {
					body = JSON.stringify(params.body);
				} catch (error) {
					return errorResult(`Could not serialize request body as JSON: ${describeError(error)}`);
				}
				if (!headers.has("content-type")) headers.set("content-type", "application/json");
			}

			let timeoutSignal: AbortSignal;
			try {
				timeoutSignal = AbortSignal.timeout(Math.ceil(timeoutSeconds * 1_000));
			} catch (error) {
				return errorResult(`Invalid HTTP timeout: ${describeError(error)}`);
			}
			try {
				const outcome = restriction === undefined
					? {
						response: await fetch(url, {
							method,
							headers,
							...(body === undefined ? {} : { body }),
							signal: timeoutSignal,
						}),
					}
					: await fetchWithinRestriction(url, restriction, method, headers, body, timeoutSignal);
				if ("error" in outcome) return errorResult(outcome.error);
				const response = outcome.response;
				const bytes = new Uint8Array(await response.arrayBuffer());
				const contentType = response.headers.get("content-type") ?? "unknown";
				const textual = isTextualContentType(contentType);
				const truncated = textual && bytes.byteLength > BODY_LIMIT_BYTES;
				const responseBody = textual
					? decodeText(bytes, truncated)
					: undefined;
				const details: HttpDetails = {
					status: response.status,
					headers: Object.fromEntries(response.headers.entries()),
					contentType,
					size: bytes.byteLength,
					truncated,
					...(responseBody === undefined ? {} : { body: responseBody }),
				};
				return toolResult(formatResultText(response, details), details);
			} catch (error) {
				if (timeoutSignal.aborted || isTimeoutError(error)) {
					return errorResult(`HTTP request timed out after ${formatSeconds(timeoutSeconds)} seconds.`);
				}
				return errorResult(`HTTP network request failed: ${describeError(error)}`);
			}
		},
		renderCall(args: object, theme: RenderTheme) {
			return new Text(renderCall(args, theme), 0, 0);
		},
		renderResult(
			result: RenderableResult,
			options: { expanded: boolean; isPartial: boolean },
			theme: RenderTheme,
			context: { isError?: boolean },
		) {
			return new Text(renderResult(result, options.expanded, theme, context.isError === true), 0, 0);
		},
	});
}

async function loadHttpConfig(): Promise<HttpConfig | { error: string }> {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	const configPath = path.join(agentDir, "http.json");
	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") return {};
		return { error: `HTTP config ${configPath} could not be read (${describeError(error)}); refusing all requests.` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { error: `HTTP config ${configPath} is not valid JSON; refusing all requests.` };
	}
	// The restriction lives in the "base" and "allow" keys, not in the file's
	// existence. The schema is strict so a mistyped lock cannot fail open.
	if (!isRecord(parsed) || Array.isArray(parsed)) {
		return { error: `HTTP config ${configPath} is invalid: expected a JSON object like {"base": "http://host:8770", "allow": ["host:*"]}; refusing all requests.` };
	}
	const unknownKey = Object.keys(parsed).find((key) => key !== "base" && key !== "allow");
	if (unknownKey !== undefined) {
		return { error: `HTTP config ${configPath} is invalid: unrecognized key ${JSON.stringify(unknownKey)} (the recognized keys are "base" and "allow"); refusing all requests.` };
	}
	const hasBase = Object.hasOwn(parsed, "base");
	const hasAllow = Object.hasOwn(parsed, "allow");
	if (!hasBase && !hasAllow) return {};

	let base: URL | undefined;
	let baseRaw: string | undefined;
	if (hasBase) {
		if (typeof parsed.base !== "string") return invalidBaseError(configPath);
		base = parseHttpOrigin(parsed.base);
		if (base === undefined) return invalidBaseError(configPath);
		baseRaw = parsed.base;
	}

	const allow: AllowPattern[] = [];
	if (hasAllow) {
		if (!Array.isArray(parsed.allow)) {
			return { error: `HTTP config ${configPath} is invalid: "allow" must be an array of server patterns; refusing all requests.` };
		}
		for (let index = 0; index < parsed.allow.length; index += 1) {
			const entry = parsed.allow[index];
			if (typeof entry !== "string") {
				return { error: `HTTP config ${configPath} is invalid: "allow" entry ${index + 1} must be a string; refusing all requests.` };
			}
			const pattern = parseAllowPattern(entry);
			if (pattern === undefined) {
				return { error: `HTTP config ${configPath} is invalid: "allow" entry ${JSON.stringify(entry)} is not a valid server pattern; refusing all requests.` };
			}
			allow.push(pattern);
		}
	}
	return { restriction: { ...(base === undefined ? {} : { base, baseRaw }), allow } };
}

function invalidBaseError(configPath: string): { error: string } {
	return {
		error: `HTTP config ${configPath} is invalid: "base" must be an http(s) origin like "http://host:8770" — no path, query, or fragment; refusing all requests.`,
	};
}

function parseHttpOrigin(value: string): URL | undefined {
	if (!/^https?:\/\/(\[[^\s\]]+\]|[^\s/?#@\\:\[\]]+)(:\d+)?\/?$/i.test(value)) return undefined;
	let origin: URL;
	try {
		origin = new URL(value);
	} catch {
		return undefined;
	}
	if (
		(origin.protocol !== "http:" && origin.protocol !== "https:")
		|| origin.pathname !== "/"
		|| origin.search !== ""
		|| origin.hash !== ""
		|| origin.username !== ""
		|| origin.password !== ""
		|| origin.hostname.includes("*")
	) return undefined;
	return origin;
}

function parseAllowPattern(raw: string): AllowPattern | undefined {
	if (raw === "*") return { kind: "any", raw };
	if (raw.includes("*")) {
		if (!raw.endsWith(":*") || raw.slice(0, -2).includes("*")) return undefined;
	}
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
		const origin = parseHttpOrigin(raw);
		return origin === undefined ? undefined : { kind: "origin", raw, origin: origin.origin };
	}

	let host = raw;
	let port: string | null = null;
	if (raw.endsWith(":*")) {
		host = raw.slice(0, -2);
		port = "*";
	} else {
		const explicitPort = /^(.*):(\d+)$/.exec(raw);
		if (explicitPort !== null) {
			host = explicitPort[1]!;
			const number = Number(explicitPort[2]);
			if (number > 65_535) return undefined;
			port = String(number);
		}
	}
	const hostname = normalizePatternHost(host);
	return hostname === undefined ? undefined : { kind: "host", raw, hostname, port };
}

function normalizePatternHost(value: string): string | undefined {
	if (
		value === ""
		|| /[\s/?#@\\]/.test(value)
		|| (value.includes(":") && !(value.startsWith("[") && value.endsWith("]")))
	) return undefined;
	let url: URL;
	try {
		url = new URL(`http://${value}`);
	} catch {
		return undefined;
	}
	if (
		url.port !== ""
		|| url.pathname !== "/"
		|| url.search !== ""
		|| url.hash !== ""
		|| url.hostname.includes("*")
	) return undefined;
	return url.hostname;
}

function isAllowedServer(url: URL, restriction: HttpRestriction): boolean {
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	if (restriction.base !== undefined && url.origin === restriction.base.origin) return true;
	const effectivePort = url.port || (url.protocol === "http:" ? "80" : "443");
	return restriction.allow.some((pattern) => {
		if (pattern.kind === "any") return true;
		if (pattern.kind === "origin") return url.origin === pattern.origin;
		if (url.hostname !== pattern.hostname) return false;
		if (pattern.port === "*") return true;
		if (pattern.port === null) {
			return effectivePort === (url.protocol === "http:" ? "80" : "443");
		}
		return effectivePort === pattern.port;
	});
}

function refusalMessage(subject: "Request" | "Redirect", url: URL, restriction: HttpRestriction): string {
	const allowedServers = [
		...(restriction.baseRaw === undefined ? [] : [restriction.baseRaw]),
		...restriction.allow.map((pattern) => pattern.raw),
	];
	return `${subject} to ${url.origin} refused: configured allowed servers are ${JSON.stringify(allowedServers)}.`;
}

async function fetchWithinRestriction(
	url: URL,
	restriction: HttpRestriction,
	method: string,
	headers: Headers,
	body: string | undefined,
	signal: AbortSignal,
): Promise<{ response: Response } | { error: string }> {
	let currentUrl = url;
	let currentMethod = method;
	let currentBody = body;
	// `<=` so up to MAX_REDIRECT_HOPS redirects are followed (MAX + 1 requests in total).
	for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
		const response = await fetch(currentUrl, {
			method: currentMethod,
			headers,
			...(currentBody === undefined ? {} : { body: currentBody }),
			signal,
			redirect: "manual",
		});
		const location = response.headers.get("location");
		if (!isRedirectStatus(response.status) || location === null) return { response };
		await response.body?.cancel();
		let next: URL;
		try {
			next = new URL(location, currentUrl);
		} catch {
			return { error: `Redirect to invalid URL: ${location}` };
		}
		if (!isAllowedServer(next, restriction)) {
			return { error: refusalMessage("Redirect", next, restriction) };
		}
		if (next.origin !== currentUrl.origin) {
			for (const name of ["authorization", "proxy-authorization", "cookie"]) headers.delete(name);
		}
		// Per fetch's redirect algorithm: 303 converts anything but GET/HEAD to a
		// body-less GET, as do 301/302 answering a POST; 307/308 keep method and body.
		const convertToGet = (response.status === 303 && currentMethod !== "GET" && currentMethod !== "HEAD")
			|| ((response.status === 301 || response.status === 302) && currentMethod === "POST");
		if (convertToGet) {
			currentMethod = "GET";
			currentBody = undefined;
			for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) {
				headers.delete(name);
			}
		}
		currentUrl = next;
	}
	return { error: `Redirect chain exceeded ${MAX_REDIRECT_HOPS} hops.` };
}

function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function decodeText(bytes: Uint8Array, truncated: boolean): string {
	if (!truncated) return new TextDecoder().decode(bytes);
	let keptBytes = BODY_LIMIT_BYTES;
	let marker = "";
	for (;;) {
		marker = `\n\n[truncated: dropped ${bytes.byteLength - keptBytes} bytes]`;
		const nextKeptBytes = utf8SafeHeadLength(bytes, BODY_LIMIT_BYTES - Buffer.byteLength(marker));
		if (nextKeptBytes === keptBytes) break;
		keptBytes = nextKeptBytes;
	}
	return new TextDecoder().decode(bytes.subarray(0, keptBytes)) + marker;
}

function utf8SafeHeadLength(bytes: Uint8Array, maxBytes: number): number {
	if (bytes.byteLength <= maxBytes || maxBytes === 0) return Math.min(bytes.byteLength, maxBytes);
	let sequenceStart = maxBytes - 1;
	while (sequenceStart > 0 && (bytes[sequenceStart]! & 0xc0) === 0x80) sequenceStart -= 1;
	const leadingByte = bytes[sequenceStart]!;
	const sequenceLength =
		(leadingByte & 0x80) === 0 ? 1
			: (leadingByte & 0xe0) === 0xc0 ? 2
				: (leadingByte & 0xf0) === 0xe0 ? 3
					: (leadingByte & 0xf8) === 0xf0 ? 4
						: 1;
	return sequenceStart + sequenceLength > maxBytes ? sequenceStart : maxBytes;
}

function isTextualContentType(contentType: string): boolean {
	const normalized = contentType.toLowerCase();
	const mediaType = normalized.split(";", 1)[0]?.trim() ?? "";
	return mediaType.startsWith("text/")
		|| mediaType === "application/json"
		|| mediaType.endsWith("+json")
		|| mediaType === "application/xml"
		|| mediaType.endsWith("+xml")
		|| mediaType === "application/x-www-form-urlencoded"
		|| normalized.includes("charset=");
}

function formatResultText(response: Response, details: HttpDetails): string {
	const statusLine = `${details.status}${response.statusText ? ` ${response.statusText}` : ""}`;
	const summary = `${statusLine}\ncontent-type: ${details.contentType}\nsize: ${humanSize(details.size)}`;
	return details.body === undefined ? summary : `${summary}\n\n${details.body}`;
}

function renderCall(args: object, theme: RenderTheme): string {
	const record = isRecord(args) ? args : {};
	const method = methods.find((candidate) => candidate === record.method)
		?? (typeof record.method === "string" ? record.method : "GET");
	let destination = typeof record.url === "string" ? record.url : "";
	try {
		const url = new URL(destination);
		destination = `${url.host}${url.pathname}${url.search}`;
	} catch {
		// Keep the caller's text for malformed URLs so rendering never throws.
	}
	const detail = truncatePreview(`${method} ${destination}`);
	return theme.fg("accent", "http") + theme.fg("muted", ` · ${detail}`);
}

function renderResult(
	result: RenderableResult,
	expanded: boolean,
	theme: RenderTheme,
	contextIsError: boolean,
): string {
	const fallback = result.content.find((part) => part.type === "text")?.text ?? "";
	if (contextIsError || result.isError) return theme.fg("error", fallback || "HTTP request failed");
	if (!isHttpDetails(result.details)) return theme.fg("muted", fallback);
	const details = result.details;
	const statusColor =
		details.status >= 500 ? "error"
			: details.status >= 400 ? "warning"
				: details.status >= 300 ? "muted"
					: details.status >= 200 ? "success"
						: "muted";
	let text = theme.fg(statusColor, String(details.status))
		+ theme.fg("muted", ` · ${details.contentType} · ${humanSize(details.size)}`);
	if (expanded && details.body !== undefined) text += `\n${theme.fg("muted", details.body)}`;
	return text;
}

function truncatePreview(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= 54 ? normalized : `${normalized.slice(0, 53)}…`;
}

function humanSize(bytes: number): string {
	if (bytes < 1_024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let size = bytes / 1_024;
	let unit = units[0];
	for (let index = 1; index < units.length && size >= 1_024; index += 1) {
		size /= 1_024;
		unit = units[index];
	}
	return `${size.toFixed(1)} ${unit}`;
}

function formatSeconds(seconds: number): string {
	return Number.isInteger(seconds) ? String(seconds) : String(seconds);
}

function isTimeoutError(error: unknown): boolean {
	return error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isHttpDetails(value: unknown): value is HttpDetails {
	return isRecord(value)
		&& typeof value.status === "number"
		&& typeof value.contentType === "string"
		&& typeof value.size === "number"
		&& typeof value.truncated === "boolean";
}

function toolResult<T>(text: string, details: T) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function errorResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: { error: text },
		isError: true,
	};
}
