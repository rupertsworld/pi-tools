import assert from "node:assert/strict";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import createHttpExtension from "../index.ts";

type HttpDetails = {
	status: number;
	headers: Record<string, string>;
	contentType: string;
	size: number;
	truncated: boolean;
	body?: string;
};
type ToolResult = {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
	isError?: boolean;
};
type RenderTheme = { fg: (color: string, text: string) => string };
type ToolDefinition = {
	execute: (
		toolCallId: string,
		params: never,
		signal: undefined,
		onUpdate: undefined,
		ctx: object,
	) => Promise<ToolResult>;
	renderCall: (
		args: Record<string, unknown>,
		theme: RenderTheme,
		context: object,
	) => { render: (width: number) => string[] };
	renderResult: (
		result: ToolResult,
		options: { expanded: boolean; isPartial: boolean },
		theme: RenderTheme,
		context: { isError?: boolean },
	) => { render: (width: number) => string[] };
};

let tool: ToolDefinition;
const servers: Server[] = [];
const sockets = new Set<import("node:net").Socket>();

beforeEach(() => {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(definition: ToolDefinition & { name: string }) {
			tools.set(definition.name, definition);
		},
	} as unknown as ExtensionAPI;
	createHttpExtension(pi);
	const registered = tools.get("http");
	assert.ok(registered);
	tool = registered;
});

afterEach(async () => {
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("http tool", () => {
	it("returns a 200 text response in text and details", async () => {
		const url = await serve((_request, response) => {
			response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-test": "yes" });
			response.end("hello");
		});

		const result = await runTool({ url });
		const details = result.details as HttpDetails;

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]!.text, /^200 OK\ncontent-type: text\/plain; charset=utf-8\nsize: 5 B\n\nhello$/);
		assert.deepEqual(details, {
			status: 200,
			headers: {
				connection: "keep-alive",
				"content-type": "text/plain; charset=utf-8",
				date: details.headers.date,
				"keep-alive": "timeout=5",
				"transfer-encoding": "chunked",
				"x-test": "yes",
			},
			contentType: "text/plain; charset=utf-8",
			size: 5,
			truncated: false,
			body: "hello",
		});
	});

	it("serializes an object body and defaults content-type to application/json", async () => {
		let received = { body: "", contentType: "" };
		const url = await serve(async (request, response) => {
			received = {
				body: await readRequest(request),
				contentType: String(request.headers["content-type"]),
			};
			response.writeHead(200, { "content-type": "application/json" });
			response.end('{"ok":true}');
		});

		const result = await runTool({ url, method: "POST", body: { answer: 42 } });

		assert.equal(result.isError, undefined);
		assert.deepEqual(received, { body: '{"answer":42}', contentType: "application/json" });
	});

	it("preserves an explicit content-type for an object body", async () => {
		let contentType = "";
		const url = await serve(async (request, response) => {
			await readRequest(request);
			contentType = String(request.headers["content-type"]);
			response.end();
		});

		await runTool({
			url,
			method: "POST",
			headers: { "Content-Type": "application/vnd.example+json" },
			body: { ok: true },
		});

		assert.equal(contentType, "application/vnd.example+json");
	});

	it("sends a string body unchanged", async () => {
		let body = "";
		const url = await serve(async (request, response) => {
			body = await readRequest(request);
			response.end();
		});

		await runTool({ url, method: "POST", body: "raw=body" });

		assert.equal(body, "raw=body");
	});

	it("treats a 404 as a normal result", async () => {
		const url = await serve((_request, response) => {
			response.writeHead(404, { "content-type": "text/plain" });
			response.end("missing");
		});

		const result = await runTool({ url });

		assert.equal(result.isError, undefined);
		assert.equal((result.details as HttpDetails).status, 404);
		assert.match(result.content[0]!.text, /404 Not Found/);
	});

	it("follows redirects", async () => {
		const base = await serve((request, response) => {
			if (request.url === "/start") {
				response.writeHead(302, { location: "/finish" });
				response.end();
				return;
			}
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("arrived");
		});

		const result = await runTool({ url: `${base}/start` });

		assert.equal((result.details as HttpDetails).status, 200);
		assert.match(result.content[0]!.text, /arrived/);
	});

	it("returns a clear timeout tool error", async () => {
		const url = await serve(() => {});

		const result = await runTool({ url, timeoutSeconds: 0.2 });

		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /timed? out|timeout/i);
	});

	it("returns a network tool error for a refused connection", async () => {
		const probe = http.createServer();
		await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
		const { port } = probe.address() as AddressInfo;
		await new Promise<void>((resolve) => probe.close(() => resolve()));

		const result = await runTool({ url: `http://127.0.0.1:${port}` });

		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /request failed|network/i);
		assert.doesNotMatch(result.content[0]!.text, /timeout/i);
	});

	it("returns tool errors for an invalid scheme and a GET body", async () => {
		const invalidScheme = await runTool({ url: "ftp://example.test/file" });
		assert.equal(invalidScheme.isError, true);
		assert.match(invalidScheme.content[0]!.text, /http.*https/i);

		const bodyWithGet = await runTool({ url: "http://example.test", body: "no" });
		assert.equal(bodyWithGet.isError, true);
		assert.match(bodyWithGet.content[0]!.text, /GET.*body/i);
	});

	it("returns a tool error for invalid headers instead of throwing", async () => {
		const result = await runTool({
			url: "http://example.test",
			headers: { "bad\nname": "value" },
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /invalid.*header/i);
	});

	it("keeps the first 16 KiB and reports dropped bytes", async () => {
		const body = "a".repeat(20 * 1024);
		const url = await serve((_request, response) => {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end(body);
		});

		const result = await runTool({ url });
		const details = result.details as HttpDetails;

		assert.equal(details.size, 20 * 1024);
		assert.equal(details.truncated, true);
		assert.ok(details.body?.startsWith("a".repeat(16_000)));
		assert.ok(Buffer.byteLength(details.body ?? "") <= 16 * 1024);
		assert.match(details.body ?? "", /dropped \d+ bytes/i);
		assert.match(result.content[0]!.text, /dropped \d+ bytes/i);
	});

	it("keeps a truncated multibyte body within the 16 KiB cap", async () => {
		const body = "😀".repeat(5_000);
		const url = await serve((_request, response) => {
			response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			response.end(body);
		});

		const result = await runTool({ url });
		const details = result.details as HttpDetails;

		assert.equal(details.truncated, true);
		assert.ok(Buffer.byteLength(details.body ?? "") <= 16 * 1024);
		assert.doesNotMatch(details.body ?? "", /\uFFFD/);
		assert.match(details.body ?? "", /dropped \d+ bytes/i);
	});

	it("omits a binary response body while reporting its type and size", async () => {
		const url = await serve((_request, response) => {
			response.writeHead(200, { "content-type": "application/octet-stream" });
			response.end(Buffer.from([0, 1, 2, 3]));
		});

		const result = await runTool({ url });
		const details = result.details as HttpDetails;

		assert.equal(details.contentType, "application/octet-stream");
		assert.equal(details.size, 4);
		assert.equal(details.body, undefined);
		assert.doesNotMatch(result.content[0]!.text, /\u0000/);
	});

	it("handles HEAD without expecting a body", async () => {
		const url = await serve((_request, response) => {
			response.writeHead(200, { "content-type": "text/plain", "content-length": "123", "x-head": "yes" });
			response.end();
		});

		const result = await runTool({ url, method: "HEAD" });
		const details = result.details as HttpDetails;

		assert.equal(result.isError, undefined);
		assert.equal(details.status, 200);
		assert.equal(details.size, 0);
		assert.equal(details.headers["x-head"], "yes");
		assert.equal(details.body, "");
	});
});

describe("http rendering", () => {
	const theme: RenderTheme = {
		fg(color, text) {
			return `<${color}:${text}>`;
		},
	};

	it("renders a GET call with a long query elided", () => {
		const rendered = tool.renderCall({
			url: "https://example.com/path?query=abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz",
		}, theme, {}).render(2_000).map((line) => line.trimEnd()).join("\n");

		assert.equal(rendered, "<accent:http><muted: · GET example.com/path?query=abcdefghijklmnopqrstuvwxyz…>");
	});

	it("colors result status by class", () => {
		for (const [status, color] of [[200, "success"], [302, "muted"], [404, "warning"], [500, "error"]] as const) {
			const result = renderResult(status, "application/json", 1_234, '{"ok":true}');
			const rendered = tool.renderResult(result, { expanded: false, isPartial: false }, theme, {})
				.render(2_000).map((line) => line.trimEnd()).join("\n");
			assert.equal(rendered, `<${color}:${status}><muted: · application/json · 1.2 KB>`);
		}
	});

	it("shows the body when expanded", () => {
		const result = renderResult(200, "text/plain", 5, "hello");
		const rendered = tool.renderResult(result, { expanded: true, isPartial: false }, theme, {})
			.render(2_000).map((line) => line.trimEnd()).join("\n");

		assert.equal(rendered, "<success:200><muted: · text/plain · 5 B>\n<muted:hello>");
	});
});

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
	const server = http.createServer(handler);
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

async function readRequest(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

async function runTool(params: object): Promise<ToolResult> {
	return tool.execute("tool-call", params as never, undefined, undefined, {});
}

function renderResult(status: number, contentType: string, size: number, body: string): ToolResult {
	return {
		content: [{ type: "text", text: body }],
		details: { status, headers: {}, contentType, size, truncated: false, body },
	};
}
