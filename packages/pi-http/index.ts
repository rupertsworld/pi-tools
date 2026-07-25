/**
 * Structured HTTP calling tool for pi agents.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const BODY_LIMIT_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 30;
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

type HttpDetails = {
	status: number;
	headers: Record<string, string>;
	contentType: string;
	size: number;
	truncated: boolean;
	body?: string;
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
			url: Type.String({ minLength: 1, description: "HTTP or HTTPS URL" }),
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

			let url: URL;
			try {
				url = new URL(params.url);
			} catch {
				return errorResult("Invalid URL. The URL must use http:// or https://.");
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				return errorResult("Invalid URL scheme. The URL must use http:// or https://.");
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
				const response = await fetch(url, {
					method,
					headers,
					...(body === undefined ? {} : { body }),
					signal: timeoutSignal,
				});
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
