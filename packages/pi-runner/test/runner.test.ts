import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scheduledJobs } from "croner";

import createRunnerExtension from "../index.ts";

type EventHandler = (event: unknown, ctx: StubCtx["ctx"]) => Promise<unknown> | unknown;
type ToolResult = {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
	isError?: boolean;
};
type ToolDefinition = {
	execute: (
		toolCallId: string,
		params: never,
		signal: undefined,
		onUpdate: undefined,
		ctx: StubCtx["ctx"],
	) => Promise<ToolResult>;
};
interface StubPi {
	pi: ExtensionAPI;
	handlers: Map<string, EventHandler>;
	sendMessageCalls: Array<{ message: unknown; options: unknown }>;
	tools: Map<string, ToolDefinition>;
}

interface StubCtx {
	ctx: {
		hasUI: boolean;
		sessionManager: { getSessionId: () => string };
		ui: { notify: (message: string, type?: string) => void };
	};
	notifications: Array<{ message: string; type?: string }>;
}

interface ScheduledJob {
	jobId: string;
	message: string;
	trigger: unknown;
	nextRunAt: string;
}

let stub: StubPi;
let stubCtx: StubCtx;
let tempAgentDir: string;
const sessionId = "test-session";
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	tempAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-test-"));
	process.env.PI_CODING_AGENT_DIR = tempAgentDir;
	stub = createStubPi();
	stubCtx = createStubCtx();
	createRunnerExtension(stub.pi);
});

afterEach(async () => {
	await fireEvent("session_shutdown");
	fs.rmSync(tempAgentDir, { recursive: true, force: true });
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("runner tools", () => {
	it("schedules and lists a valid recurring cron prompt", async () => {
		const before = Date.now();
		const scheduled = await runTool("schedule", {
			message: "Morning review",
			trigger: { kind: "cron", cron: "0 0 9 * * 1-5" },
		});

		assert.equal(scheduled.isError, undefined);
		const job = scheduled.details as ScheduledJob;
		assert.match(job.jobId, /\S/);
		assert.equal(job.message, "Morning review");
		assert.deepEqual(job.trigger, { kind: "cron", cron: "0 0 9 * * 1-5" });
		assert.ok(Date.parse(job.nextRunAt) > before);
		assert.deepEqual((await runTool("list", {})).details, [job]);
	});

	it("persists a scheduled job definition for the current session", async () => {
		const scheduled = await runTool("schedule", {
			message: "Morning review",
			trigger: { kind: "cron", cron: "0 0 9 * * 1-5" },
		});
		const job = scheduled.details as ScheduledJob;

		assert.deepEqual(readPersistedJobs(), [
			{ jobId: job.jobId, message: job.message, trigger: job.trigger },
		]);
	});

	it("schedules a relative one-shot prompt at the requested time", async () => {
		const before = Date.now();
		const scheduled = await runTool("schedule", {
			message: "Check the oven",
			trigger: { kind: "once", at: "+30s" },
		});
		const after = Date.now();

		assert.equal(scheduled.isError, undefined);
		const job = scheduled.details as ScheduledJob;
		const nextRunMs = Date.parse(job.nextRunAt);
		assert.ok(nextRunMs >= before + 30_000);
		assert.ok(nextRunMs <= after + 30_000);
		assert.deepEqual(job.trigger, { kind: "once", at: "+30s" });
		assert.deepEqual(((await runTool("list", {})).details as ScheduledJob[])[0]!.trigger, {
			kind: "once",
			at: "+30s",
		});
		assert.deepEqual(readPersistedJobs(), [
			{
				jobId: job.jobId,
				message: job.message,
				trigger: { kind: "once", at: job.nextRunAt },
			},
		]);
	});

	it("fires a prompt with the required message and delivery options", async () => {
		const scheduled = await runTool("schedule", {
			message: "Continue the review",
			trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
		});
		const cron = scheduledCron(scheduled);

		await cron.trigger();

		assert.deepEqual(stub.sendMessageCalls, [
			{
				message: { customType: "runner", content: "Continue the review", display: true },
				options: { triggerTurn: true, deliverAs: "followUp" },
			},
		]);
	});

	it("removes a one-shot prompt after firing", async () => {
		const scheduled = await runTool("schedule", {
			message: "One time",
			trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
		});

		await scheduledCron(scheduled).trigger();

		assert.deepEqual((await runTool("list", {})).details, []);
		assert.deepEqual(readPersistedJobs(), []);
	});

	it("keeps a cron prompt active after firing", async () => {
		const scheduled = await runTool("schedule", {
			message: "Recurring",
			trigger: { kind: "cron", cron: "0 * * * * *" },
		});
		const job = scheduled.details as ScheduledJob;
		const cron = scheduledCron(scheduled);

		await cron.trigger();

		assert.equal(stub.sendMessageCalls.length, 1);
		const listed = (await runTool("list", {})).details as ScheduledJob[];
		assert.equal(listed.length, 1);
		assert.equal(listed[0]!.jobId, job.jobId);
	});

	it("cancels a prompt and prevents its timer from firing", async () => {
		const scheduled = await runTool("schedule", {
			message: "Do not send",
			trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
		});
		const job = scheduled.details as ScheduledJob;
		const cron = scheduledCron(scheduled);

		const cancelled = await runTool("cancel", { jobId: job.jobId });
		await cron.trigger();

		assert.deepEqual(cancelled.details, { jobId: job.jobId, found: true, cancelled: true });
		assert.deepEqual((await runTool("list", {})).details, []);
		assert.equal(stub.sendMessageCalls.length, 0);
		assert.deepEqual(readPersistedJobs(), []);
	});

	it("reports an unknown cancellation without throwing", async () => {
		const result = await runTool("cancel", { jobId: "missing" });

		assert.equal(result.isError, undefined);
		assert.deepEqual(result.details, { jobId: "missing", found: false, cancelled: false });
		assert.deepEqual(readPersistedJobs(), []);
	});

	it("warns and continues when schedules cannot be written", async () => {
		const unwritableAgentDir = path.join(tempAgentDir, "not-a-directory");
		fs.writeFileSync(unwritableAgentDir, "");
		process.env.PI_CODING_AGENT_DIR = unwritableAgentDir;

		const result = await runTool("schedule", {
			message: "Still scheduled",
			trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
		});

		assert.equal(result.isError, undefined);
		assert.equal(((await runTool("list", {})).details as ScheduledJob[]).length, 1);
		assert.equal(stubCtx.notifications.length, 1);
		assert.equal(stubCtx.notifications[0]!.type, "warning");
		assert.match(stubCtx.notifications[0]!.message, /runner.*persist|persist.*runner/i);
	});

	it("reports invalid cron expressions as tool errors", async () => {
		const result = await runTool("schedule", {
			message: "Never",
			trigger: { kind: "cron", cron: "not a cron" },
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /invalid cron/i);
		assert.deepEqual((await runTool("list", {})).details, []);
	});

	it("reports invalid time zones as tool errors", async () => {
		const result = await runTool("schedule", {
			message: "Never",
			trigger: { kind: "cron", cron: "0 * * * * *", timeZone: "Not/AZone" },
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /time.?zone/i);
		assert.deepEqual((await runTool("list", {})).details, []);
	});

	it("reports invalid and past one-shot times as tool errors", async () => {
		for (const at of ["tomorrow-ish", "2020-01-01T00:00:00Z"]) {
			const result = await runTool("schedule", {
				message: "Never",
				trigger: { kind: "once", at },
			});
			assert.equal(result.isError, true, at);
		}
		assert.deepEqual((await runTool("list", {})).details, []);
	});
});

describe("runner lifecycle", () => {
	it("reschedules persisted jobs on session_start", async () => {
		const definitions = [
			{
				jobId: "persisted-once",
				message: "Loaded reminder",
				trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
			},
			{
				jobId: "persisted-cron",
				message: "Loaded recurring prompt",
				trigger: { kind: "cron", cron: "0 * * * * *" },
			},
		];
		writePersistedJobs(definitions);

		await fireEvent("session_start");

		const listed = (await runTool("list", {})).details as ScheduledJob[];
		assert.deepEqual(
			listed.map(({ jobId, message, trigger }) => ({ jobId, message, trigger })),
			definitions,
		);
		for (const definition of definitions) {
			const cron = scheduledJobs.find((candidate) => candidate.name === definition.jobId);
			assert.ok(cron);
			assert.equal(cron.isRunning(), true);
		}
	});

	it("drops and persists an expired one-shot job on session_start", async () => {
		writePersistedJobs([
			{
				jobId: "expired-once",
				message: "Too late",
				trigger: { kind: "once", at: "2020-01-01T00:00:00Z" },
			},
		]);

		await fireEvent("session_start");

		assert.deepEqual((await runTool("list", {})).details, []);
		assert.deepEqual(readPersistedJobs(), []);
	});

	it("warns and continues when persisted JSON cannot be read", async () => {
		fs.mkdirSync(path.dirname(persistencePath()), { recursive: true });
		fs.writeFileSync(persistencePath(), "{not json");

		await assert.doesNotReject(fireEvent("session_start"));

		assert.deepEqual((await runTool("list", {})).details, []);
		assert.equal(stubCtx.notifications.length, 1);
		assert.equal(stubCtx.notifications[0]!.type, "warning");
		assert.match(stubCtx.notifications[0]!.message, /runner.*load|load.*runner/i);
	});

	it("stops and clears every job on session_shutdown", async () => {
		const oneShot = await runTool("schedule", {
			message: "One shot",
			trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
		});
		const scheduled = await runTool("schedule", {
			message: "Recurring",
			trigger: { kind: "cron", cron: "0 * * * * *" },
		});
		const onceCron = scheduledCron(oneShot);
		const cron = scheduledCron(scheduled);
		const fileBeforeShutdown = fs.readFileSync(persistencePath(), "utf8");

		await fireEvent("session_shutdown");
		await onceCron.trigger();
		await cron.trigger();

		assert.equal(stub.sendMessageCalls.length, 0);
		assert.deepEqual((await runTool("list", {})).details, []);
		assert.equal(onceCron.isStopped(), true);
		assert.equal(cron.isStopped(), true);
		assert.equal(fs.readFileSync(persistencePath(), "utf8"), fileBeforeShutdown);
	});
});

function createStubPi(): StubPi {
	const handlers = new Map<string, EventHandler>();
	const sendMessageCalls: StubPi["sendMessageCalls"] = [];
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, handler);
		},
		registerTool(tool: ToolDefinition & { name: string }) {
			tools.set(tool.name, tool);
		},
		sendMessage(message: unknown, options: unknown) {
			sendMessageCalls.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, sendMessageCalls, tools };
}

function createStubCtx(): StubCtx {
	const notifications: StubCtx["notifications"] = [];
	return {
		ctx: {
			hasUI: true,
			sessionManager: {
				getSessionId() {
					return sessionId;
				},
			},
			ui: {
				notify(message, type) {
					notifications.push({ message, type });
				},
			},
		},
		notifications,
	};
}

async function runTool(name: string, params: object): Promise<ToolResult> {
	const tool = stub.tools.get(name);
	assert.ok(tool, `tool ${name} should be registered`);
	try {
		return await tool.execute("tool-call", params as never, undefined, undefined, stubCtx.ctx);
	} catch (error) {
		return {
			content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
			isError: true,
		};
	}
}

async function fireEvent(name: string): Promise<void> {
	const handler = stub.handlers.get(name);
	if (handler) await handler({}, stubCtx.ctx);
}

function scheduledCron(result: ToolResult) {
	const job = result.details as ScheduledJob;
	const cron = scheduledJobs.find((candidate) => candidate.name === job.jobId);
	assert.ok(cron);
	return cron;
}

function persistencePath(): string {
	return path.join(tempAgentDir, "runner", `${sessionId}.json`);
}

function readPersistedJobs(): unknown {
	return JSON.parse(fs.readFileSync(persistencePath(), "utf8"));
}

function writePersistedJobs(jobs: unknown): void {
	fs.mkdirSync(path.dirname(persistencePath()), { recursive: true });
	fs.writeFileSync(persistencePath(), JSON.stringify(jobs));
}
