import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

import { createHarness, delay, waitFor, type Harness } from "./helpers/harness.ts";

class RecordingClient implements acp.Client {
	readonly updates: acp.SessionNotification[] = [];

	async sessionUpdate(params: acp.SessionNotification): Promise<void> {
		this.updates.push(params);
	}

	async requestPermission(): Promise<acp.RequestPermissionResponse> {
		throw new Error("requestPermission should never be sent over the socket");
	}
}

let agentDir: string;
let previousAgentDirEnv: string | undefined;
let harness: Harness;
let socket: Socket | undefined;

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-acp-agent-"));
	previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
	socket?.destroy();
	socket = undefined;
	await harness?.shutdown();
	if (previousAgentDirEnv === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv;
	}
	await rm(agentDir, { recursive: true, force: true });
});

async function connectClient(options: { sessionId?: string } = {}): Promise<{
	client: RecordingClient;
	agent: acp.ClientSideConnection;
}> {
	harness = createHarness(options);
	await harness.sessionStart();
	const path = join(agentDir, "acp.sock");
	socket = connect(path);
	await new Promise<void>((resolve, reject) => {
		socket!.once("connect", () => resolve());
		socket!.once("error", reject);
	});
	const stream = acp.ndJsonStream(
		Writable.toWeb(socket!) as WritableStream<Uint8Array>,
		Readable.toWeb(socket!) as ReadableStream<Uint8Array>,
	);
	const client = new RecordingClient();
	const agent = new acp.ClientSideConnection(() => client, stream);
	return { client, agent };
}

function textChunks(client: RecordingClient): string[] {
	return client.updates
		.map((u) => u.update)
		.filter((u): u is Extract<typeof u, { sessionUpdate: "agent_message_chunk" }> => u.sessionUpdate === "agent_message_chunk")
		.map((u) => (u.content.type === "text" ? u.content.text : ""));
}

describe("acp round-trip", () => {
	it("returns expected capabilities from initialize", async () => {
		const { agent } = await connectClient();
		const result = await agent.initialize({
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
		});
		assert.equal(result.protocolVersion, acp.PROTOCOL_VERSION);
		assert.equal(result.agentCapabilities?.loadSession, false);
		assert.equal(result.agentCapabilities?.promptCapabilities?.image, false);
		assert.equal(result.agentCapabilities?.promptCapabilities?.audio, false);
	});

	it("binds newSession to the live session id and advertises no config options", async () => {
		const { agent } = await connectClient({ sessionId: "live-123" });
		await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const result = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
		assert.equal(result.sessionId, "live-123");
		assert.deepEqual(result.configOptions, []);
	});

	it("injects the prompt as a user message, streams deltas, and resolves end_turn on agent_settled (not agent_end)", async () => {
		const { client, agent } = await connectClient();
		await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

		const promptPromise = agent.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "hi there" }],
		});
		await waitFor(() => harness.sendUserMessageCalls.length === 1);
		assert.equal(harness.sendUserMessageCalls[0]!.content, "hi there");
		// Idle session: no deliverAs option.
		assert.equal(harness.sendUserMessageCalls[0]!.options, undefined);

		await harness.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" } });
		await harness.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " world" } });

		// agent_end alone must NOT end the turn; only agent_settled does.
		await harness.emit({ type: "agent_end", messages: [] });
		const outcome = await Promise.race([promptPromise.then(() => "resolved"), delay(150).then(() => "pending")]);
		assert.equal(outcome, "pending", "prompt must not resolve on agent_end");

		await harness.emit({ type: "agent_settled" });
		const result = await promptPromise;
		assert.equal(result.stopReason, "end_turn");
		assert.deepEqual(textChunks(client), ["Hello", " world"]);
	});

	it("maps tool execution start/update/end to tool_call and tool_call_update", async () => {
		const { client, agent } = await connectClient();
		await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

		const promptPromise = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "go" }] });
		await waitFor(() => harness.sendUserMessageCalls.length === 1);

		await harness.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "/a" } });
		await harness.emit({
			type: "tool_execution_update",
			toolCallId: "t1",
			toolName: "read",
			args: { path: "/a" },
			partialResult: "partial contents",
		});
		await harness.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "file contents", isError: false });
		await harness.emit({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "false" } });
		await harness.emit({ type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: "boom", isError: true });
		await harness.emit({ type: "agent_settled" });
		await promptPromise;

		await waitFor(() => client.updates.length >= 5);
		const updates = client.updates.map((u) => u.update);

		const toolCall = updates.find((u) => u.sessionUpdate === "tool_call" && u.toolCallId === "t1");
		assert.ok(toolCall && toolCall.sessionUpdate === "tool_call");
		assert.equal(toolCall.title, "read");
		assert.equal(toolCall.kind, "read");
		assert.equal(toolCall.status, "in_progress");
		assert.deepEqual(toolCall.rawInput, { path: "/a" });

		const midUpdate = updates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "t1" && u.status === "in_progress");
		assert.ok(midUpdate && midUpdate.sessionUpdate === "tool_call_update");
		assert.deepEqual(midUpdate.content, [{ type: "content", content: { type: "text", text: "partial contents" } }]);
		assert.equal(midUpdate.rawOutput, "partial contents");

		const endUpdate = updates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "t1" && u.status === "completed");
		assert.ok(endUpdate && endUpdate.sessionUpdate === "tool_call_update");
		assert.deepEqual(endUpdate.content, [{ type: "content", content: { type: "text", text: "file contents" } }]);

		const bashCall = updates.find((u) => u.sessionUpdate === "tool_call" && u.toolCallId === "t2");
		assert.ok(bashCall && bashCall.sessionUpdate === "tool_call");
		assert.equal(bashCall.kind, "execute");
		const bashEnd = updates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "t2");
		assert.ok(bashEnd && bashEnd.sessionUpdate === "tool_call_update");
		assert.equal(bashEnd.status, "failed");
	});

	it("resolves cancelled and aborts the session when cancel arrives mid-turn", async () => {
		const { agent } = await connectClient();
		await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

		const promptPromise = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "long task" }] });
		await waitFor(() => harness.sendUserMessageCalls.length === 1);

		await agent.cancel({ sessionId: session.sessionId });
		await waitFor(() => harness.abortCount === 1);
		await harness.emit({ type: "agent_settled" });

		const result = await promptPromise;
		assert.equal(result.stopReason, "cancelled");
		assert.equal(harness.abortCount, 1);
	});

	it("queues the prompt as a follow-up when the session is busy", async () => {
		const { agent } = await connectClient();
		await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

		harness.idle = false;
		const promptPromise = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "queued" }] });
		await waitFor(() => harness.sendUserMessageCalls.length === 1);
		assert.deepEqual(harness.sendUserMessageCalls[0]!.options, { deliverAs: "followUp" });

		await harness.emit({ type: "agent_settled" });
		const result = await promptPromise;
		assert.equal(result.stopReason, "end_turn");
	});

	it("surfaces a prompt failure as a warning message chunk and still ends the turn", async () => {
		const { client, agent } = await connectClient();
		await agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

		harness.failNextSendUserMessage(new Error("No API key found for provider."));
		const result = await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });

		assert.equal(result.stopReason, "end_turn");
		await waitFor(() => textChunks(client).join("").includes("No API key found for provider."));
		assert.match(textChunks(client).join(""), /⚠/);
	});
});
