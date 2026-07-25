import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
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
let agentDir: string;
let previousAgentDir: string | undefined;
const servers: Server[] = [];
const sockets = new Set<import("node:net").Socket>();

beforeEach(async () => {
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
	agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-http-test-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(agentDir, { recursive: true, force: true });
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

describe("http tool without a configured base", () => {
	it("rejects a relative url", async () => {
		const result = await runTool({ url: "/vault/search" });

		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /http.*https/i);
	});

	it("treats a present config without a base key as unrestricted", async () => {
		const url = await serve((_request, response) => {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("open");
		});
		await writeFile(path.join(agentDir, "http.json"), "{}");

		const absolute = await runTool({ url });
		assert.equal(absolute.isError, undefined);
		assert.match(absolute.content[0]!.text, /open/);

		const relative = await runTool({ url: "/vault/search" });
		assert.equal(relative.isError, true);
		assert.match(relative.content[0]!.text, /http.*https/i);
	});
});

describe("http tool with a configured base", () => {
	it("resolves a relative url with a leading slash against the base", async () => {
		let seen = "";
		const base = await serve((request, response) => {
			seen = request.url ?? "";
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("ok");
		});
		await configureBase(base);

		const result = await runTool({ url: "/vault/search?q=x" });

		assert.equal(result.isError, undefined);
		assert.equal((result.details as HttpDetails).status, 200);
		assert.equal(seen, "/vault/search?q=x");
	});

	it("resolves a relative url without a leading slash, tolerating a trailing slash on the base", async () => {
		let seen = "";
		const base = await serve((request, response) => {
			seen = request.url ?? "";
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("ok");
		});
		await configureBase(`${base}/`);

		const result = await runTool({ url: "vault/search" });

		assert.equal(result.isError, undefined);
		assert.equal(seen, "/vault/search");
	});

	it("allows an absolute url on the base origin", async () => {
		let seen = "";
		const base = await serve((request, response) => {
			seen = request.url ?? "";
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("ok");
		});
		await configureBase(base);

		const result = await runTool({ url: `${base}/direct` });

		assert.equal(result.isError, undefined);
		assert.equal(seen, "/direct");
	});

	it("rejects an unrecognized key alongside a valid base, naming the key", async () => {
		const base = await serve((_request, response) => response.end("ok"));
		await writeFile(path.join(agentDir, "http.json"), JSON.stringify({ base, future: true }));

		const result = await runTool({ url: "/anything" });

		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /http\.json/);
		assert.match(result.content[0]!.text, /future/);
	});

	it("rejects a protocol-relative url pointing off the base origin", async () => {
		let offOriginHits = 0;
		const base = await serve((_request, response) => response.end("ok"));
		const other = await serve((_request, response) => {
			offOriginHits += 1;
			response.end("stolen");
		});
		await configureBase(base);

		const result = await runTool({ url: `//${new URL(other).host}/x` });

		assert.equal(result.isError, true);
		assert.ok(result.content[0]!.text.includes(base));
		assert.equal(offOriginHits, 0);
	});

	it("rejects an absolute url off the base origin, naming the base", async () => {
		let offOriginHits = 0;
		const base = await serve((_request, response) => response.end("ok"));
		const other = await serve((_request, response) => {
			offOriginHits += 1;
			response.end("stolen");
		});
		await configureBase(base);

		const result = await runTool({ url: `${other}/steal` });

		assert.equal(result.isError, true);
		assert.ok(result.content[0]!.text.includes(base));
		assert.equal(offOriginHits, 0);
	});

	it("rejects a cross-origin redirect mid-chain, naming the base", async () => {
		let offOriginHits = 0;
		const other = await serve((_request, response) => {
			offOriginHits += 1;
			response.end("exfiltrated");
		});
		const base = await serve((_request, response) => {
			response.writeHead(302, { location: `${other}/exfil` });
			response.end();
		});
		await configureBase(base);

		const result = await runTool({ url: "/start" });

		assert.equal(result.isError, true);
		assert.ok(result.content[0]!.text.includes(base));
		assert.equal(offOriginHits, 0);
	});

	it("follows a same-origin redirect chain", async () => {
		const requests: string[] = [];
		const base = await serve((request, response) => {
			requests.push(`${request.method} ${request.url}`);
			if (request.url === "/a") {
				response.writeHead(302, { location: "/b" });
				response.end();
				return;
			}
			if (request.url === "/b") {
				response.writeHead(301, { location: "/c" });
				response.end();
				return;
			}
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("arrived");
		});
		await configureBase(base);

		const result = await runTool({ url: "/a" });

		assert.equal(result.isError, undefined);
		assert.equal((result.details as HttpDetails).status, 200);
		assert.match(result.content[0]!.text, /arrived/);
		assert.deepEqual(requests, ["GET /a", "GET /b", "GET /c"]);
	});

	it("converts a 303 redirect after POST into a body-less GET", async () => {
		const seen: Array<{ method: string; url: string; body: string }> = [];
		const base = await serve(async (request, response) => {
			seen.push({
				method: request.method ?? "",
				url: request.url ?? "",
				body: await readRequest(request),
			});
			if (request.url === "/submit") {
				response.writeHead(303, { location: "/done" });
				response.end();
				return;
			}
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("done");
		});
		await configureBase(base);

		const result = await runTool({ url: "/submit", method: "POST", body: "payload" });

		assert.equal(result.isError, undefined);
		assert.deepEqual(seen, [
			{ method: "POST", url: "/submit", body: "payload" },
			{ method: "GET", url: "/done", body: "" },
		]);
	});

	it("preserves method and body across 307 and 308 redirects", async () => {
		const seen: Array<{ method: string; url: string; body: string }> = [];
		const base = await serve(async (request, response) => {
			seen.push({
				method: request.method ?? "",
				url: request.url ?? "",
				body: await readRequest(request),
			});
			if (request.url === "/a") {
				response.writeHead(307, { location: "/b" });
				response.end();
				return;
			}
			if (request.url === "/b") {
				response.writeHead(308, { location: "/c" });
				response.end();
				return;
			}
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("kept");
		});
		await configureBase(base);

		const result = await runTool({ url: "/a", method: "PUT", body: "payload" });

		assert.equal(result.isError, undefined);
		assert.deepEqual(seen, [
			{ method: "PUT", url: "/a", body: "payload" },
			{ method: "PUT", url: "/b", body: "payload" },
			{ method: "PUT", url: "/c", body: "payload" },
		]);
	});

	it("keeps HEAD unchanged across a 303 redirect", async () => {
		const seen: string[] = [];
		const base = await serve((request, response) => {
			seen.push(`${request.method} ${request.url}`);
			if (request.url === "/a") {
				response.writeHead(303, { location: "/b" });
				response.end();
				return;
			}
			response.writeHead(200, { "content-type": "text/plain" });
			response.end();
		});
		await configureBase(base);

		const result = await runTool({ url: "/a", method: "HEAD" });

		assert.equal(result.isError, undefined);
		assert.deepEqual(seen, ["HEAD /a", "HEAD /b"]);
	});

	it("follows an absolute same-origin Location", async () => {
		let requests = 0;
		let base = "";
		base = await serve((request, response) => {
			requests += 1;
			if (request.url === "/a") {
				response.writeHead(302, { location: `${base}/b` });
				response.end();
				return;
			}
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("arrived");
		});
		await configureBase(base);

		const result = await runTool({ url: "/a" });

		assert.equal(result.isError, undefined);
		assert.equal(requests, 2);
		assert.match(result.content[0]!.text, /arrived/);
	});

	it("caps a same-origin redirect loop with a tool error", async () => {
		let hits = 0;
		const base = await serve((_request, response) => {
			hits += 1;
			response.writeHead(302, { location: "/loop" });
			response.end();
		});
		await configureBase(base);

		const result = await runTool({ url: "/loop" });

		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /redirect/i);
		assert.ok(hits <= 11, `expected at most 11 requests, saw ${hits}`);
	});
});

describe("http tool with a broken config (fails closed)", () => {
	for (const base of [
		"http://host:8770/path",
		"ftp://host:8770",
		"http://host:8770?q=1",
		"http://host:8770#fragment",
		"http://user:pass@host:8770",
		"not a url",
	]) {
		it(`rejects every call when base is ${JSON.stringify(base)}`, async () => {
			await configureBase(base);

			const result = await runTool({ url: "http://example.test/" });

			assert.equal(result.isError, true);
			assert.match(result.content[0]!.text, /http\.json/);
			assert.match(result.content[0]!.text, /base/);
		});
	}

	it("rejects every call when the config has a typo'd base key, naming the key", async () => {
		await writeFile(path.join(agentDir, "http.json"), '{"bsae": "http://host:8770"}');

		const result = await runTool({ url: "http://example.test/" });

		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /http\.json/);
		assert.match(result.content[0]!.text, /bsae/);
	});

	it("rejects every call when the config is a top-level array", async () => {
		await writeFile(path.join(agentDir, "http.json"), "[]");

		const result = await runTool({ url: "http://example.test/" });

		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /http\.json/);
		assert.match(result.content[0]!.text, /object/);
	});

	it("rejects every call when base is not a string", async () => {
		await writeFile(path.join(agentDir, "http.json"), '{"base": 42}');

		const result = await runTool({ url: "http://example.test/" });

		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /http\.json/);
		assert.match(result.content[0]!.text, /base/);
	});

	it("rejects every call when the config is not valid JSON", async () => {
		await writeFile(path.join(agentDir, "http.json"), "{nope");

		const result = await runTool({ url: "http://example.test/" });

		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /http\.json/);
		assert.match(result.content[0]!.text, /JSON/);
	});

	it("rejects every call when the config is unreadable", async () => {
		await mkdir(path.join(agentDir, "http.json"));

		const result = await runTool({ url: "http://example.test/" });

		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /http\.json/);
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

async function configureBase(base: string): Promise<void> {
	await writeFile(path.join(agentDir, "http.json"), JSON.stringify({ base }));
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
