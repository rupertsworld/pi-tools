import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scheduledJobs } from "croner";
import { Value } from "typebox/value";

import createRunnerExtension from "../index.ts";

type EventHandler = (event: unknown, ctx: StubCtx["ctx"]) => Promise<unknown> | unknown;
type ToolResult = {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
	isError?: boolean;
};
type ToolDefinition = {
	parameters?: object;
	execute: (
		toolCallId: string,
		params: never,
		signal: undefined,
		onUpdate: undefined,
		ctx: StubCtx["ctx"],
	) => Promise<ToolResult>;
	renderCall?: (args: Record<string, unknown>, theme: RenderTheme, context: Record<string, unknown>) => {
		render: (width: number) => string[];
	};
	renderResult?: (
		result: ToolResult,
		options: { expanded: boolean; isPartial: boolean },
		theme: RenderTheme,
		context: Record<string, unknown>,
	) => { render: (width: number) => string[] };
};
type RenderTheme = { fg: (color: string, text: string) => string };
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
		ui: {
			notify: (message: string, type?: string) => void;
			setStatus: (key: string, text: string | undefined) => void;
			theme: { fg: (color: string, text: string) => string };
		};
	};
	notifications: Array<{ message: string; type?: string }>;
	statusCalls: Array<{ key: string; text: string | undefined }>;
}

interface ScheduledJob {
	jobId: string;
	action: PromptAction | CommandAction | SubagentAction;
	deliverAs: "followUp" | "nextTurn" | "steer";
	trigger: unknown;
	nextRunAt: string;
	running?: true;
	startedAt?: string;
}

type PromptAction = { kind: "prompt"; message: string };
type CommandAction = { kind: "command"; command: string; cwd?: string };
type SubagentAction = {
	kind: "subagent";
	prompt: string;
	model?: string;
	cwd?: string;
	appendSystemPrompt?: string;
	maxMinutes?: number;
};

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
	createRunnerExtension(stub.pi, { spawnSubagentChild: spawnFakeSubagentChild });
});

afterEach(async () => {
	await fireEvent("session_shutdown");
	fs.rmSync(tempAgentDir, { recursive: true, force: true });
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("runner tools", () => {
	it("requires a trigger for prompt at the schema boundary", () => {
		const parameters = stub.tools.get("prompt")?.parameters;
		assert.ok(parameters);
		assert.equal(Value.Check(parameters, { message: "Missing trigger" }), false);
		assert.equal(Value.Check(parameters, { message: "Scheduled", trigger: { kind: "once", at: "+10m" } }), true);
	});

	it("omits timeZone from creator schemas and ignores it when TypeBox allows the unknown field", async () => {
		for (const name of ["prompt", "process", "subagent"]) {
			const parameters = stub.tools.get(name)?.parameters as {
				properties?: { trigger?: { anyOf?: Array<{ properties?: Record<string, unknown> }> } };
			};
			const cronSchema = parameters.properties?.trigger?.anyOf?.find(
				(candidate) => candidate.properties?.cron,
			);
			assert.ok(cronSchema, `${name} should expose a cron trigger schema`);
			assert.equal("timeZone" in (cronSchema.properties ?? {}), false);
		}

		const trigger = { kind: "cron", cron: "0 0 9 * * *", timeZone: "America/Los_Angeles" };
		const parameters = stub.tools.get("prompt")?.parameters;
		assert.ok(parameters);
		assert.equal(Value.Check(parameters, { message: "Host time", trigger }), true);

		const result = await runTool("prompt", { message: "Host time", trigger });
		assert.deepEqual((result.details as ScheduledJob).trigger, { kind: "cron", cron: trigger.cron });
		assert.deepEqual((readPersistedJobs() as Array<{ trigger: unknown }>)[0]?.trigger, {
			kind: "cron",
			cron: trigger.cron,
		});
	});

	it("process without a trigger fires immediately and is not persisted", async () => {
		const result = await runTool("process", { command: "printf immediate" });
		assert.deepEqual((result.details as ScheduledJob).trigger, { kind: "now" });
		await waitFor(() => stub.sendMessageCalls.length === 1);
		assert.deepEqual(readPersistedJobs(), []);
	});

	it("subagent without a trigger fires immediately and is not persisted", async () => {
		const result = await runTool("subagent", { prompt: "settle" });
		assert.deepEqual((result.details as ScheduledJob).trigger, { kind: "now" });
		await waitFor(() => stub.sendMessageCalls.length === 1);
		assert.deepEqual(readPersistedJobs(), []);
	});

	it("preserves explicitly provided empty optional subagent strings", async () => {
		const result = await runTool("subagent", {
			prompt: "Review this",
			model: "",
			cwd: "",
			appendSystemPrompt: "",
			trigger: { kind: "cron", cron: "0 * * * * *" },
		});

		assert.deepEqual((result.details as ScheduledJob).action, {
			kind: "subagent",
			prompt: "Review this",
			model: "",
			cwd: "",
			appendSystemPrompt: "",
		});

		const processResult = await runTool("process", {
			command: "pwd",
			cwd: "",
			trigger: { kind: "cron", cron: "0 * * * * *" },
		});
		assert.deepEqual((processResult.details as ScheduledJob).action, {
			kind: "command",
			command: "pwd",
			cwd: "",
		});
	});

	it("renders representative calls and results as Text components", () => {
		assert.equal(renderCall("subagent", { prompt: "summarize the last 3 commits", maxMinutes: 5 }), "<accent:subagent><muted: · \"summarize the last 3 commits\" · max 5m>");
		assert.equal(renderCall("process", {
			command: "git fetch --all",
			trigger: { kind: "cron", cron: "0 */15 * * * *" },
		}), "<accent:process><muted: · git fetch --all · cron 0 */15 * * * *>");

		const peekResult = toolResultForRender("first line\nsecond line", { jobId: "a7953fc5-rest", lines: 2, totalBytes: 23 });
		assert.equal(renderResult("peek", peekResult), "<muted:first line\nsecond line>");

		const jobs: ScheduledJob[] = [{
			jobId: "a7953fc5-rest",
			trigger: { kind: "once", at: "+10m" },
			action: { kind: "prompt", message: "Check the oven" },
			deliverAs: "followUp",
			nextRunAt: new Date(Date.now() + 600_000).toISOString(),
		}];
		assert.match(renderResult("list", toolResultForRender("1 active scheduled job.", jobs)), /^<muted:a7953fc5 · prompt · "Check the oven" · /);
		assert.equal(renderResult("cancel", {
			content: [{ type: "text", text: "failed badly" }],
			isError: true,
		}), "<error:failed badly>");
	});

	it("renders full job IDs and untruncated previews in expanded creator and list results", () => {
		const fullId = "a7953fc5-1234-5678-9012-abcdefabcdef";
		const fullPrompt = "Review every commit in this branch and explain all important architecture decisions without abbreviating anything";
		const job: ScheduledJob = {
			jobId: fullId,
			trigger: { kind: "cron", cron: "0 */15 * * * *" },
			action: {
				kind: "subagent",
				prompt: fullPrompt,
				model: "provider/model",
				cwd: "/workspace/project",
				appendSystemPrompt: "Use the project conventions and report every finding",
				maxMinutes: 5,
			},
			deliverAs: "followUp",
			nextRunAt: new Date(Date.now() + 900_000).toISOString(),
		};

		const creator = renderResult("subagent", toolResultForRender("scheduled", job), true);
		assert.match(creator, new RegExp(escapeRegExp(fullId)));
		assert.match(creator, new RegExp(escapeRegExp(fullPrompt)));
		assert.match(creator, /model provider\/model/);
		assert.match(creator, /cwd \/workspace\/project/);
		assert.match(creator, /system "Use the project conventions and report every finding"/);
		assert.match(creator, /max 5m/);
		assert.doesNotMatch(creator, /…/);

		const list = renderResult("list", toolResultForRender("1 active scheduled job.", [job]), true);
		assert.match(list, new RegExp(escapeRegExp(fullId)));
		assert.match(list, new RegExp(escapeRegExp(fullPrompt)));
		assert.match(list, /model provider\/model/);
		assert.match(list, /cwd \/workspace\/project/);
		assert.match(list, /system "Use the project conventions and report every finding"/);
		assert.match(list, /max 5m/);
		assert.doesNotMatch(list, /…/);

		const processJob: ScheduledJob = {
			jobId: "process-full-id-123456789",
			trigger: { kind: "once", at: "+10m" },
			action: { kind: "command", command: "git fetch --all", cwd: "/workspace/repository" },
			deliverAs: "nextTurn",
			nextRunAt: new Date(Date.now() + 600_000).toISOString(),
		};
		const expandedProcess = renderResult("process", toolResultForRender("scheduled", processJob), true);
		assert.match(expandedProcess, /process-full-id-123456789/);
		assert.match(expandedProcess, /git fetch --all/);
		assert.match(expandedProcess, /cwd \/workspace\/repository/);
	});

	it("updates the status with singular and plural job counts after scheduling", async () => {
		await runCreator({
			trigger: { kind: "cron", cron: "0 * * * * *" },
			action: { kind: "prompt", message: "First" },
		});
		await runCreator({
			trigger: { kind: "cron", cron: "0 * * * * *" },
			action: { kind: "prompt", message: "Second" },
		});

		assert.deepEqual(stubCtx.statusCalls, [
			{ key: "runner", text: "<accent:runner> <success:1 scheduled>" },
			{ key: "runner", text: "<accent:runner> <success:2 scheduled>" },
		]);
	});

	it("schedules and lists a valid recurring cron prompt", async () => {
		const before = Date.now();
		const scheduled = await runCreator({
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
		const scheduled = await runCreator({
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
		const scheduled = await runCreator({
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
		const scheduled = await runCreator({
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
			const scheduled = await runCreator({
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
		const scheduled = await runCreator({
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
		const scheduled = await runCreator({
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
		const scheduled = await runCreator({
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
		const scheduled = await runCreator({
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
		const scheduled = await runCreator({
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
		const scheduled = await runCreator({
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
		const scheduled = await runCreator({
			trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
			action: { kind: "prompt", message: "One time" },
		});

		await scheduledCron(scheduled).trigger();

		assert.deepEqual((await runTool("list", {})).details, []);
		assert.deepEqual(readPersistedJobs(), []);
		assert.deepEqual(stubCtx.statusCalls.at(-1), { key: "runner", text: undefined });
	});

	it("keeps a cron prompt active after firing", async () => {
		const scheduled = await runCreator({
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
		const scheduled = await runCreator({
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
		assert.deepEqual(stubCtx.statusCalls.at(-1), { key: "runner", text: undefined });
	});

	it("reports an unknown cancellation without throwing", async () => {
		const result = await runTool("cancel", { jobId: "missing" });

		assert.equal(result.isError, undefined);
		assert.deepEqual(result.details, { jobId: "missing", found: false, cancelled: false });
		assert.deepEqual(readPersistedJobs(), []);
	});

	it("does not access status UI when the session has no UI", async () => {
		stubCtx.ctx.hasUI = false;

		const scheduled = await runCreator({
			trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
			action: { kind: "prompt", message: "Headless" },
		});
		await assert.doesNotReject(scheduledCron(scheduled).trigger());

		assert.deepEqual(stubCtx.statusCalls, []);
	});

	it("warns and continues when schedules cannot be written", async () => {
		const unwritableAgentDir = path.join(tempAgentDir, "not-a-directory");
		fs.writeFileSync(unwritableAgentDir, "");
		process.env.PI_CODING_AGENT_DIR = unwritableAgentDir;

		const result = await runCreator({
			trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
			action: { kind: "prompt", message: "Still scheduled" },
		});

		assert.equal(result.isError, undefined);
		assert.equal(((await runTool("list", {})).details as ScheduledJob[]).length, 1);
		const persistenceWarnings = stubCtx.notifications.filter(({ message }) => /persist/i.test(message));
		assert.equal(persistenceWarnings.length, 1);
		assert.equal(persistenceWarnings[0]!.type, "warning");
		assert.match(persistenceWarnings[0]!.message, /runner.*persist|persist.*runner/i);
	});

	it("reports invalid cron expressions as tool errors", async () => {
		const result = await runCreator({
			trigger: { kind: "cron", cron: "not a cron" },
			action: { kind: "prompt", message: "Never" },
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /invalid cron/i);
		assert.deepEqual((await runTool("list", {})).details, []);
	});

	it("reports invalid and past one-shot times as tool errors", async () => {
		for (const at of ["tomorrow-ish", "2020-01-01T00:00:00Z"]) {
			const result = await runCreator({
				trigger: { kind: "once", at },
				action: { kind: "prompt", message: "Never" },
			});
			assert.equal(result.isError, true, at);
		}
		assert.deepEqual((await runTool("list", {})).details, []);
	});

	it("fires a now subagent immediately, exposes running state, and delivers its final assistant text", async () => {
		const scheduled = await runCreator({
			trigger: { kind: "now" },
			action: { kind: "subagent", prompt: "settle" },
		});
		const job = scheduled.details as ScheduledJob;
		const listed = (await runTool("list", {})).details as ScheduledJob[];

		assert.equal(job.nextRunAt <= new Date().toISOString(), true);
		assert.equal(listed[0]?.jobId, job.jobId);
		assert.equal(listed[0]?.running, true);
		assert.match(listed[0]?.startedAt ?? "", /^\d{4}-\d\d-\d\dT/);
		await waitFor(() => stub.sendMessageCalls.length === 1);
		assert.match((stub.sendMessageCalls[0]!.message as { content: string }).content, /final from message_end/);
		assert.match((stub.sendMessageCalls[0]!.message as { content: string }).content, /settled/i);
		assert.deepEqual(stub.sendMessageCalls[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
		assert.deepEqual((await runTool("list", {})).details, []);
		assert.deepEqual(readPersistedJobs(), []);
	});

	it("forwards steer NDJSON to a running subagent and rejects invalid targets", async () => {
		const scheduled = await runCreator({
			trigger: { kind: "now" },
			action: { kind: "subagent", prompt: "hang", cwd: tempAgentDir },
		});
		const job = scheduled.details as ScheduledJob;
		await waitFor(() => fs.existsSync(path.join(tempAgentDir, "subagent-input.ndjson")));

		const steered = await runTool("steer", { jobId: job.jobId, message: "change course" });
		assert.equal(steered.isError, undefined);
		await waitFor(() => fs.readFileSync(path.join(tempAgentDir, "subagent-input.ndjson"), "utf8").includes("change course"));
		assert.match(fs.readFileSync(path.join(tempAgentDir, "subagent-input.ndjson"), "utf8"), /"type":"steer"/);

		const promptJob = await runCreator({
			trigger: { kind: "cron", cron: "0 * * * * *" },
			action: { kind: "prompt", message: "not a subagent" },
		});
		for (const jobId of ["missing", (promptJob.details as ScheduledJob).jobId]) {
			assert.equal((await runTool("steer", { jobId, message: "no" })).isError, true);
		}
		const idleSubagent = await runCreator({
			trigger: { kind: "cron", cron: "0 * * * * *" },
			action: { kind: "subagent", prompt: "settle" },
		});
		assert.equal(
			(await runTool("steer", { jobId: (idleSubagent.details as ScheduledJob).jobId, message: "no" })).isError,
			true,
		);
		await runTool("cancel", { jobId: job.jobId });
	});

	it("uses agent_end assistant text only when no message_end text was seen", async () => {
		await runCreator({
			trigger: { kind: "now" },
			action: { kind: "subagent", prompt: "fallback-order" },
		});

		await waitFor(() => stub.sendMessageCalls.length === 1);
		const content = (stub.sendMessageCalls[0]!.message as { content: string }).content;
		assert.match(content, /preferred message_end text/);
		assert.doesNotMatch(content, /later agent_end fallback/);
	});

	it("uses agent_end assistant text as a fallback when message_end text is absent", async () => {
		await runCreator({
			trigger: { kind: "now" },
			action: { kind: "subagent", prompt: "agent-end-only" },
		});

		await waitFor(() => stub.sendMessageCalls.length === 1);
		assert.match(
			(stub.sendMessageCalls[0]!.message as { content: string }).content,
			/agent_end only text/,
		);
	});

	it("times out a subagent and delivers partial text with a timed-out note", async () => {
		await runCreator({
			trigger: { kind: "now" },
			action: { kind: "subagent", prompt: "partial-hang", maxMinutes: 0.01 },
		});

		await waitFor(() => stub.sendMessageCalls.length === 1, 1_800);
		const content = (stub.sendMessageCalls[0]!.message as { content: string }).content;
		assert.match(content, /partial answer/);
		assert.match(content, /timed out/i);
	});

	it("delivers a failure note with stderr when a subagent exits before settling", async () => {
		await runCreator({
			trigger: { kind: "now" },
			action: { kind: "subagent", prompt: "fail" },
		});

		await waitFor(() => stub.sendMessageCalls.length === 1);
		const content = (stub.sendMessageCalls[0]!.message as { content: string }).content;
		assert.match(content, /failed/i);
		assert.match(content, /fake stderr tail/);
	});

	it("includes both a child error and stderr tail in a subagent failure note", async () => {
		await runCreator({
			trigger: { kind: "now" },
			action: { kind: "subagent", prompt: "error-stderr" },
		});

		await waitFor(() => stub.sendMessageCalls.length === 1);
		const content = (stub.sendMessageCalls[0]!.message as { content: string }).content;
		assert.match(content, /fake child error/);
		assert.match(content, /stderr alongside error/);
	});

	it("persists cron subagents but never persists now subagents", async () => {
		const cron = await runCreator({
			trigger: { kind: "cron", cron: "0 * * * * *" },
			action: { kind: "subagent", prompt: "settle", model: "model-x" },
		});
		assert.deepEqual(readPersistedJobs(), [
			{
				jobId: (cron.details as ScheduledJob).jobId,
				trigger: { kind: "cron", cron: "0 * * * * *" },
				action: { kind: "subagent", prompt: "settle", model: "model-x" },
				deliverAs: "followUp",
			},
		]);
		await runCreator({
			trigger: { kind: "now" },
			action: { kind: "subagent", prompt: "settle" },
		});
		assert.equal((readPersistedJobs() as unknown[]).length, 1);
	});

	it("shows and clears the warning-colored running status suffix", async () => {
		const scheduled = await runCreator({
			trigger: { kind: "cron", cron: "0 * * * * *" },
			action: { kind: "subagent", prompt: "settle-delayed" },
		});
		const firing = scheduledCron(scheduled).trigger();
		await waitFor(() => stubCtx.statusCalls.some(({ text }) => text?.includes("<warning: · 1 running>") ?? false));
		await firing;
		assert.equal(stubCtx.statusCalls.at(-1)?.text, "<accent:runner> <success:1 scheduled>");
	});

	it("counts only scheduled jobs: a running now-job shows running without a scheduled count", async () => {
		await runCreator({
			trigger: { kind: "now" },
			action: { kind: "command", command: `node -e "setTimeout(() => process.stdout.write('done'), 250)"` },
		});
		await waitFor(() => stubCtx.statusCalls.some(({ text }) => text?.includes("running") ?? false));
		const runningText = stubCtx.statusCalls.filter(({ text }) => text?.includes("running") ?? false).at(-1)?.text ?? "";
		assert.ok(!/<success:/.test(runningText), `running-only status should carry no scheduled count: ${runningText}`);
		assert.match(runningText, /<accent:runner>.*<warning:.*1 running>/);
		await waitFor(() => stub.sendMessageCalls.length === 1, 1_800);
		await waitFor(() => stubCtx.statusCalls.at(-1)?.text === undefined);
	});

	it("logs schedule, prompt delivery, and cancellation with timestamps", async () => {
		const prompt = await runCreator({
			trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
			action: { kind: "prompt", message: "Log this prompt" },
		});
		const promptJob = prompt.details as ScheduledJob;
		await scheduledCron(prompt).trigger();
		const promptLog = readJobLog(promptJob.jobId);
		assert.match(promptLog, /^\d{4}-\d\d-\d\dT\S+ scheduled once /m);
		assert.match(promptLog, /^\d{4}-\d\d-\d\dT\S+ prompt fired\/delivered/m);

		const recurring = await runCreator({
			trigger: { kind: "cron", cron: "0 * * * * *" },
			action: { kind: "prompt", message: "Cancel me" },
		});
		const recurringJob = recurring.details as ScheduledJob;
		await runTool("cancel", { jobId: recurringJob.jobId });
		assert.match(readJobLog(recurringJob.jobId), /^\d{4}-\d\d-\d\dT\S+ cancelled/m);
	});

	it("logs full command streams while delivery keeps only the 8 KiB tails", async () => {
		const fullOutput = "x".repeat(10_000);
		const scheduled = await runCreator({
			trigger: { kind: "now" },
			action: {
				kind: "command",
				command: "printf '%010000d' 0 | tr 0 x; printf stderr-all >&2",
				cwd: tempAgentDir,
			},
		});
		const job = scheduled.details as ScheduledJob;

		await waitFor(() => stub.sendMessageCalls.length === 1);
		const delivered = stub.sendMessageCalls[0]!.message as { content: string; details: { stdout: string } };
		assert.equal(delivered.details.stdout.includes(fullOutput), false);
		assert.match(delivered.details.stdout, /dropped \d+ bytes/);
		const log = readJobLog(job.jobId);
		assert.match(log, /command started .* cwd=/);
		assert.equal(log.includes(fullOutput), true);
		assert.match(log, /stderr-all/);
		assert.match(log, /command exited code=0/);
	});

	it("logs subagent spawn, tool execution, assistant text, steering, settlement, and delivery", async () => {
		const scheduled = await runCreator({
			trigger: { kind: "now" },
			action: { kind: "subagent", prompt: "tool-settle", model: "model-x", cwd: tempAgentDir },
		});
		const job = scheduled.details as ScheduledJob;
		await waitFor(
			() => fs.existsSync(path.join(tempAgentDir, "subagent-input.ndjson"))
				&& fs.readFileSync(path.join(tempAgentDir, "subagent-input.ndjson"), "utf8").includes('"type":"prompt"'),
		);
		await runTool("steer", { jobId: job.jobId, message: "change course" });
		await waitFor(() => stub.sendMessageCalls.length === 1);

		const log = readJobLog(job.jobId);
		assert.match(log, /subagent spawned model=model-x cwd=/);
		assert.match(log, /tool_execution example_tool .*query.*compact/);
		assert.match(log, /assistant: final from message_end/);
		assert.match(log, /steer: change course/);
		assert.match(log, /subagent settled/);
		assert.match(log, /result delivered: .*Subagent settled/s);
	});

	it("preserves split UTF-8 characters in subagent RPC assistant text and logs", async () => {
		const scheduled = await runCreator({
			trigger: { kind: "now" },
			action: { kind: "subagent", prompt: "split-unicode" },
		});
		const job = scheduled.details as ScheduledJob;
		await waitFor(() => stub.sendMessageCalls.length === 1);

		const delivered = (stub.sendMessageCalls[0]!.message as { content: string }).content;
		assert.match(delivered, /split € text/);
		assert.doesNotMatch(delivered, /�/);
		const log = readJobLog(job.jobId);
		assert.match(log, /assistant: split € text/);
		assert.doesNotMatch(log, /�/);
	});

	it("peek returns exact tail lines, defaults to 50, and survives completed job removal", async () => {
		const output = Array.from({ length: 60 }, (_, index) => `line-${index + 1}`).join("\n");
		const scheduled = await runCreator({
			trigger: { kind: "now" },
			action: { kind: "command", command: `printf ${JSON.stringify(`${output}\n`)}` },
		});
		const job = scheduled.details as ScheduledJob;
		await waitFor(() => stub.sendMessageCalls.length === 1);
		assert.deepEqual((await runTool("list", {})).details, []);

		const lastThree = await runTool("peek", { jobId: job.jobId, lines: 3 });
		assert.equal(lastThree.isError, undefined);
		assert.equal(lastThree.content[0]!.text.split("\n").length, 3);
		assert.match(lastThree.content[0]!.text, /line-60/);
		assert.match(lastThree.content[0]!.text, /command exited code=0/);
		assert.deepEqual(
			lastThree.details,
			{ jobId: job.jobId, lines: 3, totalBytes: fs.statSync(jobLogPath(job.jobId)).size },
		);

		const defaultTail = await runTool("peek", { jobId: job.jobId });
		assert.equal(defaultTail.content[0]!.text.split("\n").length, 50);
		assert.equal((await runTool("peek", { jobId: "unknown" })).isError, true);
	});

	it("peek rejects path traversal instead of reading files outside the logs directory", async () => {
		const secret = path.join(tempAgentDir, "runner", "secret.log");
		fs.mkdirSync(path.dirname(secret), { recursive: true });
		fs.writeFileSync(secret, "must not escape");

		for (const jobId of ["../secret", "..\\secret", "/tmp/secret"]) {
			const result = await runTool("peek", { jobId });
			assert.equal(result.isError, true);
			assert.doesNotMatch(result.content[0]!.text, /must not escape/);
		}
	});

	it("logs command text faithfully across UTF-8 and logical-line chunk boundaries and peek awaits queued writes", async () => {
		await fireEvent("session_shutdown");
		stub = createStubPi();
		const fake = createFakeCommandChild();
		createRunnerExtension(stub.pi, {
			spawnSubagentChild: spawnFakeSubagentChild,
			spawnCommandChild: () => fake.child,
		});
		const scheduled = await runCreator({
			trigger: { kind: "now" },
			action: { kind: "command", command: "fake chunked output" },
		});
		const job = scheduled.details as ScheduledJob;
		const euro = Buffer.from("€");

		fake.stdout.write(Buffer.concat([Buffer.from("prefix "), euro.subarray(0, 1)]));
		fake.stdout.write(Buffer.concat([euro.subarray(1), Buffer.from(" suffix")]));
		fake.stdout.write("\nnext");
		fake.stdout.write(" line");

		const runningPeek = await runTool("peek", { jobId: job.jobId });
		assert.match(runningPeek.content[0]!.text, /stdout: prefix € suffix/);
		assert.doesNotMatch(runningPeek.content[0]!.text, /�/);
		assert.doesNotMatch(runningPeek.content[0]!.text, /stdout: next/);

		fake.close(0);
		await waitFor(() => stub.sendMessageCalls.length === 1);
		const log = readJobLog(job.jobId);
		assert.match(log, /^\S+ stdout: prefix € suffix$/m);
		assert.match(log, /^\S+ stdout: next line$/m);
		assert.doesNotMatch(log, /�/);
		assert.match((stub.sendMessageCalls[0]!.message as { content: string }).content, /prefix € suffix\nnext line/);
	});

	it("warns once per job when log writes fail and still completes and delivers", async () => {
		const logsPath = path.join(tempAgentDir, "runner", "logs");
		fs.mkdirSync(path.dirname(logsPath), { recursive: true });
		fs.writeFileSync(logsPath, "not a directory");

		const scheduled = await runCreator({
			trigger: { kind: "now" },
			action: { kind: "command", command: "printf still-delivered" },
		});
		assert.equal(scheduled.isError, undefined);
		await waitFor(() => stub.sendMessageCalls.length === 1);
		assert.match((stub.sendMessageCalls[0]!.message as { content: string }).content, /still-delivered/);
		const logWarnings = stubCtx.notifications.filter(({ message }) => /log/i.test(message));
		assert.equal(logWarnings.length, 1);
		assert.equal(logWarnings[0]!.type, "warning");
	});
});

describe("runner lifecycle", () => {
	it("sets the status after loading persisted jobs on session_start", async () => {
		writePersistedJobs([
			{
				jobId: "persisted-once",
				action: { kind: "prompt", message: "Loaded reminder" },
				deliverAs: "followUp",
				trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
			},
			{
				jobId: "persisted-cron",
				action: { kind: "prompt", message: "Loaded recurring prompt" },
				deliverAs: "followUp",
				trigger: { kind: "cron", cron: "0 * * * * *" },
			},
		]);

		await fireEvent("session_start");

		assert.deepEqual(stubCtx.statusCalls, [
			{ key: "runner", text: "<accent:runner> <success:2 scheduled>" },
		]);
	});

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

	it("loads stale persisted timeZone fields in the host zone, warns once, and removes them on the next write", async () => {
		const originalTimeZone = process.env.TZ;
		process.env.TZ = "Australia/Sydney";
		try {
			writePersistedJobs([
				{
					jobId: "stale-zone-one",
					action: { kind: "prompt", message: "First" },
					deliverAs: "followUp",
					trigger: { kind: "cron", cron: "0 0 9 * * *", timeZone: "America/Los_Angeles" },
				},
				{
					jobId: "stale-zone-two",
					action: { kind: "prompt", message: "Second" },
					deliverAs: "followUp",
					trigger: { kind: "cron", cron: "0 0 10 * * *", timeZone: "Europe/London" },
				},
			]);

			await assert.doesNotReject(fireEvent("session_start"));

			const listed = (await runTool("list", {})).details as ScheduledJob[];
			assert.equal(listed.length, 2);
			assert.deepEqual(listed.map(({ trigger }) => trigger), [
				{ kind: "cron", cron: "0 0 9 * * *" },
				{ kind: "cron", cron: "0 0 10 * * *" },
			]);
			assert.equal(new Date(listed[0]!.nextRunAt).getHours(), 9);
			assert.equal(new Date(listed[1]!.nextRunAt).getHours(), 10);
			const staleZoneWarnings = stubCtx.notifications.filter(({ message }) => /time.?zone/i.test(message));
			assert.equal(staleZoneWarnings.length, 1);
			assert.equal(staleZoneWarnings[0]!.type, "warning");

			assert.equal(JSON.stringify(readPersistedJobs()).includes("timeZone"), true);
			await runCreator({
				trigger: { kind: "cron", cron: "0 0 11 * * *" },
				action: { kind: "prompt", message: "Trigger the next persistence write" },
			});
			assert.equal(JSON.stringify(readPersistedJobs()).includes("timeZone"), false);
		} finally {
			if (originalTimeZone === undefined) delete process.env.TZ;
			else process.env.TZ = originalTimeZone;
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
		const oneShot = await runCreator({
			trigger: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
			action: { kind: "prompt", message: "One shot" },
		});
		const scheduled = await runCreator({
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
		const scheduled = await runCreator({
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
		const scheduled = await runCreator({
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
		const scheduled = await runCreator({
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
		const scheduled = await runCreator({
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

	it("cancels a running subagent and suppresses delivery", async () => {
		const scheduled = await runCreator({
			trigger: { kind: "now" },
			action: { kind: "subagent", prompt: "hang" },
		});
		const job = scheduled.details as ScheduledJob;
		await waitFor(async () => ((await runTool("list", {})).details as ScheduledJob[])[0]?.running === true);

		await runTool("cancel", { jobId: job.jobId });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(stub.sendMessageCalls.length, 0);
		assert.deepEqual((await runTool("list", {})).details, []);
	});

	it("kills running subagents on session_shutdown without delivery", async () => {
		await runCreator({
			trigger: { kind: "now" },
			action: { kind: "subagent", prompt: "hang" },
		});
		await waitFor(async () => ((await runTool("list", {})).details as ScheduledJob[])[0]?.running === true);

		await fireEvent("session_shutdown");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(stub.sendMessageCalls.length, 0);
		assert.deepEqual((await runTool("list", {})).details, []);
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

const renderTheme: RenderTheme = {
	fg(color, text) {
		return `<${color}:${text}>`;
	},
};

function renderCall(name: string, args: Record<string, unknown>): string {
	const renderer = stub.tools.get(name)?.renderCall;
	assert.ok(renderer);
	return renderer(args, renderTheme, {}).render(2_000).map((line) => line.trimEnd()).join("\n");
}

function renderResult(name: string, result: ToolResult, expanded = false): string {
	const renderer = stub.tools.get(name)?.renderResult;
	assert.ok(renderer);
	return renderer(result, { expanded, isPartial: false }, renderTheme, { isError: result.isError })
		.render(2_000)
		.map((line) => line.trimEnd())
		.join("\n");
}

function toolResultForRender(text: string, details: unknown): ToolResult {
	return { content: [{ type: "text", text }], details };
}

function createStubCtx(): StubCtx {
	const notifications: StubCtx["notifications"] = [];
	const statusCalls: StubCtx["statusCalls"] = [];
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
				setStatus(key, text) {
					statusCalls.push({ key, text });
				},
				theme: {
					fg(color, text) {
						return `<${color}:${text}>`;
					},
				},
			},
		},
		notifications,
		statusCalls,
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

async function runCreator(params: {
	action: PromptAction | CommandAction | SubagentAction;
	trigger: unknown;
	deliverAs?: "followUp" | "nextTurn" | "steer";
}): Promise<ToolResult> {
	const { kind, ...action } = params.action;
	const name = kind === "command" ? "process" : kind;
	return runTool(name, { ...action, trigger: params.trigger, deliverAs: params.deliverAs });
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

function readJobLog(jobId: string): string {
	return fs.readFileSync(jobLogPath(jobId), "utf8").trimEnd();
}

function jobLogPath(jobId: string): string {
	return path.join(tempAgentDir, "runner", "logs", `${jobId}.log`);
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function spawnFakeSubagentChild(action: SubagentAction) {
	const child = new EventEmitter() as ChildProcess;
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let input = "";
	let closed = false;
	const close = (code: number | null) => {
		if (closed) return;
		closed = true;
		queueMicrotask(() => child.emit("close", code, code === null ? "SIGTERM" : null));
	};
	const stdin = new Writable({
		write(chunk, _encoding, callback) {
			input += chunk.toString();
			if (action.cwd) fs.writeFileSync(path.join(action.cwd, "subagent-input.ndjson"), input);
			for (;;) {
				const newline = input.indexOf("\n");
				if (newline < 0) break;
				const line = input.slice(0, newline);
				input = input.slice(newline + 1);
				const command = JSON.parse(line) as { type: string };
				if (command.type !== "prompt") continue;
				if (action.prompt === "error-stderr") {
					stderr.write("stderr alongside error");
					queueMicrotask(() => child.emit("error", new Error("fake child error")));
					continue;
				}
				if (action.prompt === "fail") {
					stderr.write("fake stderr tail");
					close(7);
					continue;
				}
				if (action.prompt === "agent-end-only") {
					stdout.write(`${JSON.stringify({
						type: "agent_end",
						messages: [{ role: "assistant", content: [{ type: "text", text: "agent_end only text" }] }],
					})}\n`);
					stdout.write('{"type":"agent_settled"}\n');
					continue;
				}
				if (action.prompt === "split-unicode") {
					const event = Buffer.from(`${JSON.stringify({
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text: "split € text" }] },
					})}\n`);
					const euro = Buffer.from("€");
					const euroStart = event.indexOf(euro);
					stdout.write(event.subarray(0, euroStart + 1));
					stdout.write(event.subarray(euroStart + 1));
					stdout.write('{"type":"agent_settled"}\n');
					continue;
				}
				const text = action.prompt === "partial-hang" ? "partial answer" : "final from message_end";
				if (action.prompt === "tool-settle") {
					stdout.write(`${JSON.stringify({
						type: "tool_execution_start",
						toolName: "example_tool",
						args: { query: "compact", verbose: false },
					})}\n`);
				}
				const messageEndText = action.prompt === "fallback-order" ? "preferred message_end text" : text;
				stdout.write(`${JSON.stringify({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: messageEndText }] },
				})}\n`);
				if (action.prompt === "fallback-order") {
					stdout.write(`${JSON.stringify({
						type: "agent_end",
						messages: [{ role: "assistant", content: [{ type: "text", text: "later agent_end fallback" }] }],
					})}\n`);
					stdout.write('{"type":"agent_settled"}\n');
				}
				if (action.prompt === "settle-delayed") {
					setTimeout(() => stdout.write('{"type":"agent_settled"}\n'), 150);
				} else if (action.prompt === "settle" || action.prompt === "tool-settle") {
					setTimeout(() => stdout.write('{"type":"agent_settled"}\n'), 50);
				}
			}
			callback();
		},
	});
	Object.assign(child, {
		pid: 2_000_000_000,
		stdin,
		stdout,
		stderr,
		kill: () => {
			close(null);
			return true;
		},
	});
	queueMicrotask(() => child.emit("spawn"));
	return child;
}

function createFakeCommandChild() {
	const child = new EventEmitter() as ChildProcess;
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let closed = false;
	const close = (code: number | null) => {
		if (closed) return;
		closed = true;
		stdout.end();
		stderr.end();
		queueMicrotask(() => child.emit("close", code, null));
	};
	Object.assign(child, {
		pid: 2_000_000_001,
		stdin: null,
		stdout,
		stderr,
		kill: () => {
			close(null);
			return true;
		},
	});
	queueMicrotask(() => child.emit("spawn"));
	return { child, stdout, stderr, close };
}
