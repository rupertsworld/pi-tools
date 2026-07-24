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
	action: PromptAction | CommandAction;
	deliverAs: "followUp" | "nextTurn" | "steer";
	trigger: unknown;
	nextRunAt: string;
}

type PromptAction = { kind: "prompt"; message: string };
type CommandAction = { kind: "command"; command: string; cwd?: string };

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
			trigger: { kind: "cron", cron: "0 0 9 * * 1-5" },
			action: { kind: "prompt", message: "Morning review" },
		});

		assert.equal(scheduled.isError, undefined);
		const job = scheduled.details as ScheduledJob;
		assert.match(job.jobId, /\S/);
		assert.deepEqual(job.action, { kind: "prompt", message: "Morning review" });
		assert.equal(job.deliverAs, "followUp");
		assert.deepEqual(job.trigger, { kind: "cron", cron: "0 0 9 * * 1-5" });
		assert.ok(Date.parse(job.nextRunAt) > before);
		assert.deepEqual((await runTool("list", {})).details, [job]);
	});

	it("persists and reloads a new-shape command job definition for the current session", async () => {
		const scheduled = await runTool("schedule", {
			trigger: { kind: "cron", cron: "0 0 9 * * 1-5" },
			action: { kind: "command", command: "printf persisted", cwd: tempAgentDir },
			deliverAs: "nextTurn",
		});
		const job = scheduled.details as ScheduledJob;

		assert.deepEqual(readPersistedJobs(), [
			{ jobId: job.jobId, trigger: job.trigger, action: job.action, deliverAs: job.deliverAs },
		]);

		await fireEvent("session_shutdown");
		await fireEvent("session_start");
		assert.deepEqual((await runTool("list", {})).details, [job]);
		assert.equal(scheduledCron(scheduled).isRunning(), true);
	});

	it("schedules a relative one-shot prompt at the requested time", async () => {
		const before = Date.now();
		const scheduled = await runTool("schedule", {
			trigger: { kind: "once", at: "+30s" },
			action: { kind: "prompt", message: "Check the oven" },
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
				trigger: { kind: "once", at: job.nextRunAt },
				action: job.action,
				deliverAs: "followUp",
			},
		]);
	});

	it("fires a prompt with the required message and delivery options", async () => {
		const scheduled = await runTool("schedule", {
			trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
			action: { kind: "prompt", message: "Continue the review" },
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

	it("uses the exact delivery options for nextTurn and steer", async () => {
		for (const [deliverAs, options] of [
			["nextTurn", { deliverAs: "nextTurn" }],
			["steer", { deliverAs: "steer", triggerTurn: true }],
		] as const) {
			const scheduled = await runTool("schedule", {
				trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
				action: { kind: "prompt", message: deliverAs },
				deliverAs,
			});
			await scheduledCron(scheduled).trigger();
			assert.deepEqual(stub.sendMessageCalls.at(-1)?.options, options);
		}
	});

	it("runs a command to completion and delivers its structured result", async () => {
		const command = "printf 'hello runner'";
		const scheduled = await runTool("schedule", {
			trigger: { kind: "cron", cron: "0 * * * * *" },
			action: { kind: "command", command },
		});

		await scheduledCron(scheduled).trigger();

		assert.equal(stub.sendMessageCalls.length, 1);
		const call = stub.sendMessageCalls[0]!;
		const message = call.message as { content: string; details: Record<string, unknown> };
		assert.match(message.content, /hello runner/);
		assert.match(message.content, /exit code: 0/i);
		assert.match(message.content, new RegExp(escapeRegExp(command)));
		assert.deepEqual(message.details, {
			command,
			exitCode: 0,
			stdout: "hello runner",
			stderr: "",
			truncated: false,
		});
	});

	it("delivers nonzero command exits with stderr", async () => {
		const command = `sh -c "echo boom >&2; exit 3"`;
		const scheduled = await runTool("schedule", {
			trigger: { kind: "cron", cron: "0 * * * * *" },
			action: { kind: "command", command },
		});

		await scheduledCron(scheduled).trigger();

		const message = stub.sendMessageCalls[0]!.message as { content: string; details: Record<string, unknown> };
		assert.match(message.content, /exit code: 3/i);
		assert.match(message.content, /stderr:[\s\S]*boom/i);
		assert.equal(message.details.exitCode, 3);
		assert.match(String(message.details.stderr), /boom/);
	});

	it("delivers a spawn-failure result for a nonexistent cwd", async () => {
		const command = "printf unreachable";
		const scheduled = await runTool("schedule", {
			trigger: { kind: "cron", cron: "0 * * * * *" },
			action: { kind: "command", command, cwd: path.join(tempAgentDir, "missing") },
		});

		await assert.doesNotReject(scheduledCron(scheduled).trigger());

		const message = stub.sendMessageCalls[0]!.message as { content: string; details: Record<string, unknown> };
		assert.match(message.content, /spawn error/i);
		assert.match(message.content, /enoent/i);
		assert.equal(message.details.command, command);
		assert.equal(message.details.exitCode, null);
	});

	it("keeps the stdout tail and marks dropped bytes", async () => {
		const command = "printf '%020000d' 0 | tr 0 x";
		const scheduled = await runTool("schedule", {
			trigger: { kind: "cron", cron: "0 * * * * *" },
			action: { kind: "command", command },
		});

		await scheduledCron(scheduled).trigger();

		const message = stub.sendMessageCalls[0]!.message as { content: string; details: Record<string, unknown> };
		assert.match(message.content, /dropped \d+ bytes/i);
		assert.equal(message.details.truncated, true);
		assert.ok(Buffer.byteLength(String(message.details.stdout)) <= 8_192);
		assert.equal(String(message.details.stdout).endsWith("x".repeat(100)), true);
	});

	it("keeps a valid multibyte stdout tail across chunk boundaries", async () => {
		const command = `i=0; while [ $i -lt 4000 ]; do printf '€'; i=$((i+1)); done`;
		const scheduled = await runTool("schedule", {
			trigger: { kind: "cron", cron: "0 * * * * *" },
			action: { kind: "command", command },
		});

		await scheduledCron(scheduled).trigger();

		const message = stub.sendMessageCalls[0]!.message as { details: Record<string, unknown> };
		const stdout = String(message.details.stdout);
		assert.equal(message.details.truncated, true);
		assert.match(stdout, /dropped \d+ bytes/i);
		assert.equal(stdout.includes("\uFFFD"), false);
		assert.equal(stdout.endsWith("€".repeat(100)), true);
		assert.ok(Buffer.byteLength(stdout) <= 8_192);
	});

	it("delivers a synchronous spawn failure instead of rejecting the fire", async () => {
		const scheduled = await runTool("schedule", {
			trigger: { kind: "cron", cron: "0 * * * * *" },
			action: { kind: "command", command: "\0" },
		});

		await assert.doesNotReject(scheduledCron(scheduled).trigger());

		const message = stub.sendMessageCalls[0]!.message as { content: string; details: Record<string, unknown> };
		assert.match(message.content, /spawn error/i);
		assert.equal(message.details.exitCode, null);
		assert.equal(message.details.command, "\0");
	});

	it("removes a one-shot prompt after firing", async () => {
		const scheduled = await runTool("schedule", {
			trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
			action: { kind: "prompt", message: "One time" },
		});

		await scheduledCron(scheduled).trigger();

		assert.deepEqual((await runTool("list", {})).details, []);
		assert.deepEqual(readPersistedJobs(), []);
	});

	it("keeps a cron prompt active after firing", async () => {
		const scheduled = await runTool("schedule", {
			trigger: { kind: "cron", cron: "0 * * * * *" },
			action: { kind: "prompt", message: "Recurring" },
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
			trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
			action: { kind: "prompt", message: "Do not send" },
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
			trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
			action: { kind: "prompt", message: "Still scheduled" },
		});

		assert.equal(result.isError, undefined);
		assert.equal(((await runTool("list", {})).details as ScheduledJob[]).length, 1);
		assert.equal(stubCtx.notifications.length, 1);
		assert.equal(stubCtx.notifications[0]!.type, "warning");
		assert.match(stubCtx.notifications[0]!.message, /runner.*persist|persist.*runner/i);
	});

	it("reports invalid cron expressions as tool errors", async () => {
		const result = await runTool("schedule", {
			trigger: { kind: "cron", cron: "not a cron" },
			action: { kind: "prompt", message: "Never" },
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /invalid cron/i);
		assert.deepEqual((await runTool("list", {})).details, []);
	});

	it("reports invalid time zones as tool errors", async () => {
		const result = await runTool("schedule", {
			trigger: { kind: "cron", cron: "0 * * * * *", timeZone: "Not/AZone" },
			action: { kind: "prompt", message: "Never" },
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /time.?zone/i);
		assert.deepEqual((await runTool("list", {})).details, []);
	});

	it("reports invalid and past one-shot times as tool errors", async () => {
		for (const at of ["tomorrow-ish", "2020-01-01T00:00:00Z"]) {
			const result = await runTool("schedule", {
				trigger: { kind: "once", at },
				action: { kind: "prompt", message: "Never" },
			});
			assert.equal(result.isError, true, at);
		}
		assert.deepEqual((await runTool("list", {})).details, []);
	});
});

describe("runner lifecycle", () => {
	it("normalizes legacy persisted jobs on session_start", async () => {
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
			listed.map(({ jobId, action, deliverAs, trigger }) => ({ jobId, action, deliverAs, trigger })),
			definitions.map(({ jobId, message, trigger }) => ({
				jobId,
				action: { kind: "prompt", message },
				deliverAs: "followUp",
				trigger,
			})),
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
			trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
			action: { kind: "prompt", message: "One shot" },
		});
		const scheduled = await runTool("schedule", {
			trigger: { kind: "cron", cron: "0 * * * * *" },
			action: { kind: "prompt", message: "Recurring" },
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

	it("kills a running command when its job is cancelled", async () => {
		const pidFile = path.join(tempAgentDir, "cancelled.pid");
		const command = `echo $$ > ${JSON.stringify(pidFile)}; sleep 60`;
		const scheduled = await runTool("schedule", {
			trigger: { kind: "cron", cron: "0 * * * * *" },
			action: { kind: "command", command },
		});
		const firing = scheduledCron(scheduled).trigger();
		await waitFor(() => fs.existsSync(pidFile));
		const pid = Number(fs.readFileSync(pidFile, "utf8"));

		await runTool("cancel", { jobId: (scheduled.details as ScheduledJob).jobId });
		await firing;

		await waitFor(() => !isProcessRunning(pid), 4_000);
		assert.equal(isProcessRunning(pid), false);
	});

	it("cancels a firing one-shot command, suppresses delivery, and keeps its removal persisted", async () => {
		const pidFile = path.join(tempAgentDir, "cancelled-once.pid");
		const command = `echo $$ > ${JSON.stringify(pidFile)}; sleep 60`;
		const scheduled = await runTool("schedule", {
			trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
			action: { kind: "command", command },
		});
		const job = scheduled.details as ScheduledJob;
		const firing = scheduledCron(scheduled).trigger();
		await waitFor(() => fs.existsSync(pidFile));
		const pid = Number(fs.readFileSync(pidFile, "utf8"));
		assert.deepEqual(readPersistedJobs(), []);
		const persistedAfterFire = fs.readFileSync(persistencePath(), "utf8");

		const cancelled = await runTool("cancel", { jobId: job.jobId });
		await firing;

		assert.deepEqual(cancelled.details, { jobId: job.jobId, found: true, cancelled: true });
		assert.equal(isProcessRunning(pid), false);
		assert.equal(stub.sendMessageCalls.length, 0);
		assert.equal(fs.readFileSync(persistencePath(), "utf8"), persistedAfterFire);
	});

	it("kills running commands and stops timers on session_shutdown", async () => {
		const pidFile = path.join(tempAgentDir, "shutdown.pid");
		const command = `echo $$ > ${JSON.stringify(pidFile)}; sleep 60`;
		const scheduled = await runTool("schedule", {
			trigger: { kind: "cron", cron: "0 * * * * *" },
			action: { kind: "command", command },
		});
		const cron = scheduledCron(scheduled);
		const firing = cron.trigger();
		await waitFor(() => fs.existsSync(pidFile));
		const pid = Number(fs.readFileSync(pidFile, "utf8"));

		await fireEvent("session_shutdown");
		await firing;

		await waitFor(() => !isProcessRunning(pid), 4_000);
		assert.equal(isProcessRunning(pid), false);
		assert.equal(cron.isStopped(), true);
		assert.deepEqual((await runTool("list", {})).details, []);
	});

	it("kills a firing one-shot command on shutdown without delivery or persistence changes", async () => {
		const pidFile = path.join(tempAgentDir, "shutdown-once.pid");
		const command = `echo $$ > ${JSON.stringify(pidFile)}; sleep 60`;
		const scheduled = await runTool("schedule", {
			trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
			action: { kind: "command", command },
		});
		const firing = scheduledCron(scheduled).trigger();
		await waitFor(() => fs.existsSync(pidFile));
		const pid = Number(fs.readFileSync(pidFile, "utf8"));
		assert.deepEqual(readPersistedJobs(), []);
		const persistedAfterFire = fs.readFileSync(persistencePath(), "utf8");

		await fireEvent("session_shutdown");
		await firing;

		assert.equal(isProcessRunning(pid), false);
		assert.equal(stub.sendMessageCalls.length, 0);
		assert.equal(fs.readFileSync(persistencePath(), "utf8"), persistedAfterFire);
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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
