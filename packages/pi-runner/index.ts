/**
 * Runner extension: schedule actions for delivery into the active session.
 *
 * Jobs are session-scoped and persisted between session loads. See SPEC.md.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Cron } from "croner";

type CronTrigger = {
	kind: "cron";
	cron: string;
	timeZone?: string;
};

type OnceTrigger = {
	kind: "once";
	at: string;
};

type NowTrigger = {
	kind: "now";
};

type Trigger = CronTrigger | OnceTrigger | NowTrigger;

type PromptAction = {
	kind: "prompt";
	message: string;
};

export type CommandAction = {
	kind: "command";
	command: string;
	cwd?: string;
};

export type SubagentAction = {
	kind: "subagent";
	prompt: string;
	model?: string;
	cwd?: string;
	appendSystemPrompt?: string;
	maxMinutes?: number;
};

type Action = PromptAction | CommandAction | SubagentAction;
type Delivery = "followUp" | "nextTurn" | "steer";

interface RunningProcess {
	child: ChildProcess;
	settled: Promise<void>;
	startedAt: string;
}

interface Job {
	jobId: string;
	trigger: Trigger;
	action: Action;
	deliverAs: Delivery;
	cron?: Cron;
	context: ExtensionContext;
	running?: RunningProcess;
	active: boolean;
	nextRunAt: string;
}

interface JobDetails {
	jobId: string;
	trigger: Trigger;
	action: Action;
	deliverAs: Delivery;
	nextRunAt: string;
	running?: true;
	startedAt?: string;
}

interface JobDefinition {
	jobId: string;
	trigger: Trigger;
	action: Action;
	deliverAs: Delivery;
}

interface LegacyJobDefinition {
	jobId: string;
	message: string;
	trigger: Trigger;
}

interface CommandResult {
	command: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	spawnError?: string;
}

interface StreamCapture {
	tail: Buffer;
	totalBytes: number;
}

interface LogStream {
	decoder: StringDecoder;
	pending: string;
}

const STREAM_LIMIT_BYTES = 8_192;
const KILL_GRACE_MS = 2_000;
const triggerSchema = Type.Union([
	Type.Object({
		kind: StringEnum(["cron"] as const),
		cron: Type.String({ description: "Six-field cron expression" }),
		timeZone: Type.Optional(Type.String({ description: "Optional IANA time zone" })),
	}),
	Type.Object({
		kind: StringEnum(["once"] as const),
		at: Type.String({ description: "Future relative time or absolute ISO timestamp" }),
	}),
	Type.Object({
		kind: StringEnum(["now"] as const),
	}),
]);
const deliverySchema = Type.Optional(StringEnum(["followUp", "nextTurn", "steer"] as const));

export interface RunnerDependencies {
	spawnSubagentChild: typeof spawnSubagentChild;
	spawnCommandChild?: (action: CommandAction) => ChildProcess;
}

export default function (pi: ExtensionAPI, dependencies: RunnerDependencies = { spawnSubagentChild }) {
	const jobs = new Map<string, Job>();
	const firingJobs = new Map<string, Job>();
	const logQueues = new Map<string, Promise<void>>();
	const warnedLogJobs = new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		try {
			const definitions = await readJobs(ctx);
			let droppedJob = false;
			for (const definition of definitions) {
				if (definition.trigger.kind === "once" && Date.parse(definition.trigger.at) <= Date.now()) {
					droppedJob = true;
					continue;
				}
				try {
					const job = createJob(definition, ctx);
					jobs.set(job.jobId, job);
				} catch (error) {
					notify(ctx, `Runner could not restore scheduled job ${definition.jobId} (${describeError(error)}).`, "warning");
				}
			}
			if (droppedJob) await writeJobs(ctx);
		} catch (error) {
			if (!isFileNotFound(error)) {
				notify(ctx, `Runner could not load persisted schedules (${describeError(error)}).`, "warning");
			}
		}
		updateRunnerStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		const stopping = [...new Set([...jobs.values(), ...firingJobs.values()])].map(async (job) => {
			if (job.running) await appendJobLog(job, `${job.action.kind} killed on session shutdown`);
			await stopJob(job);
		});
		jobs.clear();
		firingJobs.clear();
		await Promise.all(stopping);
	});

	async function createJobFromTool(
		action: Action,
		trigger: Trigger,
		deliverAs: Delivery | undefined,
		ctx: ExtensionContext,
	) {
		const definition: JobDefinition = {
			jobId: randomUUID(),
			trigger,
			action,
			deliverAs: deliverAs ?? "followUp",
		};
		const job = createJob(definition, ctx);
		jobs.set(job.jobId, job);
		const details = describeJob(job);
		updateRunnerStatus(ctx);
		await writeJobs(ctx);
		await appendJobLog(job, `scheduled ${describeTrigger(job.trigger)}`);
		if (job.trigger.kind === "now") {
			void fireJob(job);
			await waitForImmediateActionStart(job, firingJobs);
		}
		return toolResult(`Scheduled job ${job.jobId} for ${details.nextRunAt}.`, details);
	}

	pi.registerTool({
		name: "prompt",
		label: "Schedule Prompt",
		description: "Schedule a prompt for delivery into the current session.",
		parameters: Type.Object({
			message: Type.String({ minLength: 1, description: "Prompt to inject when the schedule fires" }),
			trigger: triggerSchema,
			deliverAs: deliverySchema,
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return createJobFromTool({ kind: "prompt", message: params.message }, params.trigger, params.deliverAs, ctx);
		},
		...toolRenderers("prompt"),
	});

	pi.registerTool({
		name: "process",
		label: "Run Process",
		description: "Run a shell command now or schedule it for later.",
		parameters: Type.Object({
			command: Type.String({ minLength: 1, description: "Shell command to run" }),
			cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the current directory" })),
			trigger: Type.Optional(triggerSchema),
			deliverAs: deliverySchema,
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return createJobFromTool(
				{ kind: "command", command: params.command, ...(params.cwd !== undefined ? { cwd: params.cwd } : {}) },
				params.trigger ?? { kind: "now" },
				params.deliverAs,
				ctx,
			);
		},
		...toolRenderers("process"),
	});

	pi.registerTool({
		name: "subagent",
		label: "Run Subagent",
		description: "Run an isolated subagent now or schedule it for later.",
		parameters: Type.Object({
			prompt: Type.String({ minLength: 1, description: "Prompt for the isolated agent" }),
			model: Type.Optional(Type.String({ description: "Optional pi model pattern" })),
			cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the current directory" })),
			appendSystemPrompt: Type.Optional(Type.String({ description: "Text appended to the child system prompt" })),
			maxMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Positive runtime cap in minutes" })),
			trigger: Type.Optional(triggerSchema),
			deliverAs: deliverySchema,
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { prompt, model, cwd, appendSystemPrompt, maxMinutes } = params;
			return createJobFromTool(
				{
					kind: "subagent",
					prompt,
					...(model !== undefined ? { model } : {}),
					...(cwd !== undefined ? { cwd } : {}),
					...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
					...(maxMinutes === undefined ? {} : { maxMinutes }),
				},
				params.trigger ?? { kind: "now" },
				params.deliverAs,
				ctx,
			);
		},
		...toolRenderers("subagent"),
	});

	pi.registerTool({
		name: "cancel",
		label: "Cancel Scheduled Job",
		description: "Cancel an active scheduled job by job ID.",
		parameters: Type.Object({
			jobId: Type.String({ description: "ID returned by schedule" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const job = jobs.get(params.jobId) ?? firingJobs.get(params.jobId);
			if (!job) {
				await writeJobs(ctx);
				const details = { jobId: params.jobId, found: false, cancelled: false };
				return toolResult(`No active scheduled job found for ${params.jobId}.`, details);
			}
			jobs.delete(params.jobId);
			firingJobs.delete(params.jobId);
			updateRunnerStatus(ctx);
			await appendJobLog(job, "cancelled");
			if (job.running) await appendJobLog(job, `${job.action.kind} killed`);
			await stopJob(job);
			await writeJobs(ctx);
			const details = { jobId: params.jobId, found: true, cancelled: true };
			return toolResult(`Cancelled scheduled job ${params.jobId}.`, details);
		},
		...toolRenderers("cancel"),
	});

	pi.registerTool({
		name: "steer",
		label: "Steer Running Subagent",
		description: "Redirect a running subagent by job ID.",
		parameters: Type.Object({
			jobId: Type.String({ description: "ID returned by schedule" }),
			message: Type.String({ minLength: 1, description: "Instruction to send to the running subagent" }),
		}),
		async execute(_toolCallId, params) {
			const job = jobs.get(params.jobId) ?? firingJobs.get(params.jobId);
			if (!job) throw new Error(`No active job found for ${params.jobId}.`);
			if (job.action.kind !== "subagent") throw new Error(`Job ${params.jobId} is not a subagent.`);
			if (!job.running?.child.stdin?.writable) throw new Error(`Subagent job ${params.jobId} is not running.`);
			job.running.child.stdin.write(`${JSON.stringify({ type: "steer", message: params.message })}\n`);
			await appendJobLog(job, `steer: ${params.message}`);
			return toolResult(`Steered subagent job ${params.jobId}.`, { jobId: params.jobId, steered: true });
		},
		...toolRenderers("steer"),
	});

	pi.registerTool({
		name: "peek",
		label: "Peek at Job Log",
		description: "Read the last lines of a running or completed job's log.",
		parameters: Type.Object({
			jobId: Type.String({
				minLength: 1,
				pattern: "^[^/\\\\]+$",
				description: "ID returned by schedule",
			}),
			lines: Type.Optional(Type.Integer({ minimum: 1, description: "Positive number of lines; defaults to 50" })),
		}),
		async execute(_toolCallId, params) {
			const lines = params.lines ?? 50;
			const filePath = jobLogPath(params.jobId);
			await (logQueues.get(params.jobId) ?? Promise.resolve());
			let contents: string;
			try {
				contents = await fs.readFile(filePath, "utf8");
			} catch (error) {
				if (isFileNotFound(error)) throw new Error(`No job log found for ${params.jobId}.`);
				throw error;
			}
			const withoutTrailingNewline = contents.replace(/\r?\n$/, "");
			const tail = withoutTrailingNewline ? withoutTrailingNewline.split(/\r?\n/).slice(-lines).join("\n") : "";
			return toolResult(tail, { jobId: params.jobId, lines, totalBytes: Buffer.byteLength(contents) });
		},
		...toolRenderers("peek"),
	});

	pi.registerTool({
		name: "list",
		label: "List Scheduled Jobs",
		description: "List active jobs scheduled in this session.",
		parameters: Type.Object({}),
		async execute() {
			const activeJobs = [...new Set([...jobs.values(), ...firingJobs.values()])];
			const details = activeJobs.map(describeJob);
			return toolResult(`${details.length} active scheduled job${details.length === 1 ? "" : "s"}.`, details);
		},
		...toolRenderers("list"),
	});

	function createJob(definition: JobDefinition, context: ExtensionContext): Job {
		let job: Job;
		const options = {
			name: definition.jobId,
			protect: definition.action.kind === "command" || definition.action.kind === "subagent",
			catch: (error: unknown) =>
				notify(context, `Runner job ${definition.jobId} failed (${describeError(error)}).`, "error"),
		};
		let cron: Cron | undefined;
		let nextRunAt: string;

		if (definition.trigger.kind === "now") {
			nextRunAt = new Date().toISOString();
		} else if (definition.trigger.kind === "once") {
			cron = new Cron(parseOnceTime(definition.trigger.at), options, () => fireJob(job));
			nextRunAt = requiredCronNextRun(cron, definition.jobId).toISOString();
		} else {
			validateTimeZone(definition.trigger.timeZone);
			try {
				cron = new Cron(
					definition.trigger.cron,
					{
						...options,
						mode: "6-part",
						timezone: definition.trigger.timeZone,
					},
					() => fireJob(job),
				);
			} catch (error) {
				throw new Error(`Invalid cron expression "${definition.trigger.cron}": ${describeError(error)}`);
			}
			if (!cron.nextRun()) {
				cron.stop();
				throw new Error(`Invalid cron expression "${definition.trigger.cron}": it has no future run.`);
			}
			nextRunAt = requiredCronNextRun(cron, definition.jobId).toISOString();
		}
		job = {
			...definition,
			context,
			active: true,
			cron,
			nextRunAt,
		};
		return job;
	}

	async function fireJob(job: Job): Promise<void> {
		if (!job.active) return;
		const isOnce = job.trigger.kind === "once" || job.trigger.kind === "now";
		if (isOnce) {
			jobs.delete(job.jobId);
			firingJobs.set(job.jobId, job);
			updateRunnerStatus(job.context);
			job.cron?.stop();
			await writeJobs(job.context);
			if (!job.active) {
				firingJobs.delete(job.jobId);
				return;
			}
		}

		try {
			let content: string;
			let details: CommandResult | undefined;
			if (job.action.kind === "prompt") {
				content = job.action.message;
			} else if (job.action.kind === "command") {
				details = await executeCommand(job);
				content = formatCommandResult(details);
			} else {
				content = await executeSubagent(job);
			}

			if (job.active) {
				try {
					if (job.action.kind === "prompt") await appendJobLog(job, "prompt fired/delivered");
					const message = details
						? { customType: "runner", content, display: true, details: commandDetails(details) }
						: { customType: "runner", content, display: true };
					await pi.sendMessage(
						message,
						deliveryOptions(job.deliverAs),
					);
					if (job.action.kind === "subagent") {
						await appendJobLog(job, `result delivered: ${content}`);
					}
				} catch (error) {
					notify(job.context, `Runner could not deliver scheduled job ${job.jobId} (${describeError(error)}).`, "error");
				}
			}
		} finally {
			if (isOnce) {
				firingJobs.delete(job.jobId);
				updateRunnerStatus(job.context);
			}
		}
	}

	async function executeCommand(job: Job): Promise<CommandResult> {
		const action = job.action;
		if (action.kind !== "command") throw new Error("Expected a command action.");
		const stdout = createStreamCapture();
		const stderr = createStreamCapture();
		const stdoutLog = createLogStream();
		const stderrLog = createLogStream();
		let spawnError: string | undefined;
		let exitCode: number | null = null;

		let child: ChildProcess;
		await appendJobLog(job, `command started command=${action.command} cwd=${action.cwd ?? process.cwd()}`);
		try {
			child = dependencies.spawnCommandChild?.(action) ?? spawnCommandChild(action);
		} catch (error) {
			await appendJobLog(job, `command failed to spawn: ${describeError(error)}`);
			return {
				command: action.command,
				exitCode: null,
				stdout: "",
				stderr: "",
				truncated: false,
				spawnError: describeError(error),
			};
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			appendTail(stdout, chunk);
			appendLogStream(stdoutLog, chunk, (line) => appendJobLog(job, `stdout: ${line}`));
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			appendTail(stderr, chunk);
			appendLogStream(stderrLog, chunk, (line) => appendJobLog(job, `stderr: ${line}`));
		});
		const settled = new Promise<void>((resolve) => {
			child.once("error", (error) => {
				spawnError = describeError(error);
				resolve();
			});
			child.once("close", (code) => {
				if (!spawnError) exitCode = code;
				resolve();
			});
		});
		job.running = { child, settled, startedAt: new Date().toISOString() };
		updateRunnerStatus(job.context);
		await settled;
		flushLogStream(stdoutLog, (line) => appendJobLog(job, `stdout: ${line}`));
		flushLogStream(stderrLog, (line) => appendJobLog(job, `stderr: ${line}`));
		await appendJobLog(
			job,
			spawnError ? `command failed: ${spawnError}` : `command exited code=${exitCode}`,
		);
		job.running = undefined;
		updateRunnerStatus(job.context);

		const stdoutResult = finalizeTail(stdout);
		const stderrResult = finalizeTail(stderr);
		return {
			command: action.command,
			exitCode,
			stdout: stdoutResult.content,
			stderr: stderrResult.content,
			truncated: stdoutResult.truncated || stderrResult.truncated,
			...(spawnError ? { spawnError } : {}),
		};
	}

	async function executeSubagent(job: Job): Promise<string> {
		const action = job.action;
		if (action.kind !== "subagent") throw new Error("Expected a subagent action.");
		const stderr = createStreamCapture();
		let latestText = "";
		let sawMessageEndText = false;
		let stdoutBuffer = "";
		const stdoutDecoder = new StringDecoder("utf8");
		let stdoutEnded = false;
		const endStdoutDecoding = () => {
			if (stdoutEnded) return;
			stdoutEnded = true;
			stdoutBuffer += stdoutDecoder.end();
		};
		let settledByAgent = false;
		let childError: string | undefined;
		let resolveExit!: () => void;
		const exited = new Promise<void>((resolve) => {
			resolveExit = resolve;
		});
		let child: ChildProcess;
		try {
			child = dependencies.spawnSubagentChild(action);
		} catch (error) {
			await appendJobLog(job, `subagent failed: ${describeError(error)}`);
			return formatSubagentResult("", "failed", describeError(error));
		}
		const completed = new Promise<"settled" | "exited">((resolve) => {
			child.stdout?.on("data", (chunk: Buffer) => {
				stdoutBuffer += stdoutDecoder.write(chunk);
				for (;;) {
					const newline = stdoutBuffer.indexOf("\n");
					if (newline < 0) break;
					const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
					stdoutBuffer = stdoutBuffer.slice(newline + 1);
					if (!line) continue;
					try {
						const event: unknown = JSON.parse(line);
						const eventText = assistantTextFromEvent(event);
						if (eventText !== undefined) {
							if (isRecord(event) && event.type === "message_end") {
								latestText = eventText;
								sawMessageEndText = true;
								void appendJobLog(job, `assistant: ${eventText}`);
							} else if (!sawMessageEndText) {
								latestText = eventText;
							}
						}
						const toolExecution = toolExecutionFromEvent(event);
						if (toolExecution) {
							void appendJobLog(job, `tool_execution ${toolExecution.name} ${toolExecution.arguments}`);
						}
						if (isRecord(event) && event.type === "agent_settled") {
							settledByAgent = true;
							resolve("settled");
						}
					} catch {
						// Non-JSON stdout cannot satisfy the RPC protocol.
					}
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => appendTail(stderr, chunk));
			child.once("error", (error) => {
				endStdoutDecoding();
				childError = describeError(error);
				resolveExit();
				resolve("exited");
			});
			child.once("close", () => {
				endStdoutDecoding();
				resolveExit();
				if (!settledByAgent) resolve("exited");
			});
		});
		job.running = { child, settled: exited, startedAt: new Date().toISOString() };
		updateRunnerStatus(job.context);
		await new Promise<void>((resolve) => {
			if (child.pid === undefined) {
				child.once("spawn", resolve);
				child.once("error", resolve);
			} else {
				child.once("spawn", resolve);
			}
		});
		await appendJobLog(
			job,
			`subagent spawned${action.model ? ` model=${action.model}` : ""}${action.cwd ? ` cwd=${action.cwd}` : ""}`,
		);
		if (child.stdin?.writable) {
			child.stdin.write(`${JSON.stringify({ type: "prompt", message: action.prompt })}\n`);
		}

		let timeout: NodeJS.Timeout | undefined;
		const outcome = action.maxMinutes === undefined
			? await completed
			: await Promise.race([
				completed,
				new Promise<"timedOut">((resolve) => {
					timeout = setTimeout(() => resolve("timedOut"), action.maxMinutes! * 60_000);
					timeout.unref();
				}),
			]);
		if (timeout) clearTimeout(timeout);
		if (outcome === "settled") {
			child.stdin?.end();
			await terminateProcessTree(job.running);
		} else if (outcome === "timedOut") {
			await terminateProcessTree(job.running);
		}
		job.running = undefined;
		updateRunnerStatus(job.context);

		if (outcome === "settled") {
			await appendJobLog(job, "subagent settled");
			return formatSubagentResult(latestText, "settled");
		}
		const stderrText = finalizeTail(stderr).content;
		const failure = [
			childError,
			stderrText ? `stderr: ${stderrText}` : undefined,
		].filter((part): part is string => part !== undefined)
			.join("; ") || "child exited before agent_settled";
		if (outcome === "timedOut") {
			await appendJobLog(job, "subagent timed out and killed");
			return formatSubagentResult(latestText, "timed out");
		}
		await appendJobLog(job, `subagent failed: ${failure}`);
		return formatSubagentResult(latestText, "failed", failure);
	}

	async function readJobs(ctx: ExtensionContext): Promise<JobDefinition[]> {
		const contents = await fs.readFile(persistencePath(ctx), "utf8");
		const definitions: unknown = JSON.parse(contents);
		if (!Array.isArray(definitions)) throw new Error("persisted schedules must be an array");
		return definitions.map(normalizeDefinition);
	}

	async function writeJobs(ctx: ExtensionContext): Promise<void> {
		try {
			const filePath = persistencePath(ctx);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			const definitions = [...jobs.values()]
				.filter((job) => job.trigger.kind !== "now")
				.map(serializeJob);
			await fs.writeFile(filePath, JSON.stringify(definitions, null, "\t"));
		} catch (error) {
			notify(ctx, `Runner could not persist schedules (${describeError(error)}).`, "warning");
		}
	}

	function updateRunnerStatus(ctx: ExtensionContext): void {
		const activeJobs = [...new Set([...jobs.values(), ...firingJobs.values()])];
		updateStatus(
			ctx,
			activeJobs.filter((job) => job.trigger.kind !== "now").length,
			activeJobs.filter((job) => job.running).length,
		);
	}

	function appendJobLog(job: Job, message: string): Promise<void> {
		const previous = logQueues.get(job.jobId) ?? Promise.resolve();
		const next = previous.then(async () => {
			try {
				const filePath = jobLogPath(job.jobId);
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				const lines = message.replace(/\r\n/g, "\n").split("\n");
				const timestamped = lines.map((line) => `${new Date().toISOString()} ${line}`).join("\n");
				await fs.appendFile(filePath, `${timestamped}\n`);
			} catch (error) {
				if (!warnedLogJobs.has(job.jobId)) {
					warnedLogJobs.add(job.jobId);
					notify(job.context, `Runner could not write log for job ${job.jobId} (${describeError(error)}).`, "warning");
				}
			}
		});
		logQueues.set(job.jobId, next);
		return next;
	}
}

async function waitForImmediateActionStart(job: Job, firingJobs: Map<string, Job>): Promise<void> {
	while (firingJobs.has(job.jobId) && job.action.kind !== "prompt" && !job.running) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

function persistencePath(ctx: ExtensionContext): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "runner", `${ctx.sessionManager.getSessionId()}.json`);
}

function jobLogPath(jobId: string): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	const logsDirectory = path.resolve(agentDir, "runner", "logs");
	if (
		!jobId
		|| path.basename(jobId) !== jobId
		|| path.win32.basename(jobId) !== jobId
	) {
		throw new Error(`Invalid job ID "${jobId}".`);
	}
	const filePath = path.resolve(logsDirectory, `${jobId}.log`);
	if (path.dirname(filePath) !== logsDirectory) throw new Error(`Invalid job ID "${jobId}".`);
	return filePath;
}

function describeTrigger(trigger: Trigger): string {
	if (trigger.kind === "cron") {
		return `cron ${trigger.cron}${trigger.timeZone ? ` timezone=${trigger.timeZone}` : ""}`;
	}
	if (trigger.kind === "once") return `once ${trigger.at}`;
	return "now";
}

function parseOnceTime(at: string): Date {
	const relative = at.match(/^\+(\d+)(s|m|h|d)$/);
	if (relative) {
		const amount = Number(relative[1]);
		const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "s" | "m" | "h" | "d"];
		const runAt = new Date(Date.now() + amount * unitMs);
		if (runAt.getTime() <= Date.now()) throw new Error(`One-shot time "${at}" must be in the future.`);
		return runAt;
	}

	if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(at)) {
		throw new Error(`Invalid one-shot time "${at}". Use +30s, +10m, +2h, +1d, or an absolute ISO timestamp.`);
	}
	const timestamp = Date.parse(at);
	if (!Number.isFinite(timestamp)) throw new Error(`Invalid one-shot time "${at}".`);
	if (timestamp <= Date.now()) throw new Error(`One-shot time "${at}" must be in the future.`);
	return new Date(timestamp);
}

function validateTimeZone(timeZone: string | undefined): void {
	if (!timeZone) return;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone }).format();
	} catch {
		throw new Error(`Invalid time zone "${timeZone}". Use an IANA time zone name.`);
	}
}

function describeJob(job: Job): JobDetails {
	return {
		jobId: job.jobId,
		trigger: job.trigger,
		action: job.action,
		deliverAs: job.deliverAs,
		nextRunAt: job.cron?.nextRun()?.toISOString() ?? job.nextRunAt,
		...(job.running ? { running: true as const, startedAt: job.running.startedAt } : {}),
	};
}

function serializeJob(job: Job): JobDefinition {
	const trigger =
		job.trigger.kind === "once"
			? { kind: "once" as const, at: requiredNextRun(job).toISOString() }
			: job.trigger;
	return {
		jobId: job.jobId,
		trigger,
		action: job.action,
		deliverAs: job.deliverAs,
	};
}

function requiredNextRun(job: Job): Date {
	const nextRun = job.cron?.nextRun();
	if (!nextRun) throw new Error(`Scheduled job ${job.jobId} has no future run.`);
	return nextRun;
}

function requiredCronNextRun(cron: Cron, jobId: string): Date {
	const nextRun = cron.nextRun();
	if (!nextRun) throw new Error(`Scheduled job ${jobId} has no future run.`);
	return nextRun;
}

function normalizeDefinition(value: unknown): JobDefinition {
	const definition = value as Partial<JobDefinition & LegacyJobDefinition>;
	if (!definition.jobId || !definition.trigger) throw new Error("persisted job is missing its id or trigger");
	if (definition.action) {
		return {
			jobId: definition.jobId,
			trigger: definition.trigger,
			action: definition.action,
			deliverAs: definition.deliverAs ?? "followUp",
		};
	}
	if (typeof definition.message === "string") {
		return {
			jobId: definition.jobId,
			trigger: definition.trigger,
			action: { kind: "prompt", message: definition.message },
			deliverAs: "followUp",
		};
	}
	throw new Error(`persisted job ${definition.jobId} has no action`);
}

async function stopJob(job: Job): Promise<void> {
	job.active = false;
	job.cron?.stop();
	if (job.running) await terminateProcessTree(job.running);
}

async function terminateProcessTree(running: RunningProcess): Promise<void> {
	const pid = running.child.pid;
	if (!pid) {
		await running.settled;
		return;
	}
	signalProcessGroup(running.child, pid, "SIGTERM");
	const forceKill = setTimeout(() => signalProcessGroup(running.child, pid, "SIGKILL"), KILL_GRACE_MS);
	forceKill.unref();
	await running.settled;
	clearTimeout(forceKill);
}

function signalProcessGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// The process already exited.
		}
	}
}

function createStreamCapture(): StreamCapture {
	return { tail: Buffer.alloc(0), totalBytes: 0 };
}

function createLogStream(): LogStream {
	return { decoder: new StringDecoder("utf8"), pending: "" };
}

function appendLogStream(stream: LogStream, chunk: Buffer, writeLine: (line: string) => Promise<void>): void {
	stream.pending += stream.decoder.write(chunk);
	for (;;) {
		const newline = stream.pending.indexOf("\n");
		if (newline < 0) return;
		const line = stream.pending.slice(0, newline).replace(/\r$/, "");
		stream.pending = stream.pending.slice(newline + 1);
		void writeLine(line);
	}
}

function flushLogStream(stream: LogStream, writeLine: (line: string) => Promise<void>): void {
	stream.pending += stream.decoder.end();
	if (!stream.pending) return;
	void writeLine(stream.pending);
	stream.pending = "";
}

function appendTail(capture: StreamCapture, chunk: Buffer): void {
	capture.totalBytes += chunk.byteLength;
	const combined = Buffer.concat([capture.tail, chunk]);
	capture.tail = combined.byteLength > STREAM_LIMIT_BYTES
		? combined.subarray(combined.byteLength - STREAM_LIMIT_BYTES)
		: combined;
}

function finalizeTail(capture: StreamCapture): { content: string; truncated: boolean } {
	if (capture.totalBytes <= STREAM_LIMIT_BYTES) {
		return { content: capture.tail.toString("utf8"), truncated: false };
	}
	let marker = `[... dropped ${capture.totalBytes - capture.tail.byteLength} bytes ...]\n`;
	let tail = utf8SafeTail(capture.tail, STREAM_LIMIT_BYTES - Buffer.byteLength(marker));
	marker = `[... dropped ${capture.totalBytes - tail.byteLength} bytes ...]\n`;
	tail = utf8SafeTail(capture.tail, STREAM_LIMIT_BYTES - Buffer.byteLength(marker));
	return { content: marker + tail.toString("utf8"), truncated: true };
}

function utf8SafeTail(buffer: Buffer, maxBytes: number): Buffer {
	let tail = buffer.byteLength > maxBytes ? buffer.subarray(buffer.byteLength - maxBytes) : buffer;
	let start = 0;
	while (start < tail.byteLength && (tail[start]! & 0xc0) === 0x80) start++;
	if (start > 0) tail = tail.subarray(start);
	return tail;
}

function formatCommandResult(result: CommandResult): string {
	const status = result.spawnError ? `Spawn error: ${result.spawnError}` : `Exit code: ${result.exitCode}`;
	return [
		`Command: ${result.command}`,
		status,
		"",
		"stdout:",
		result.stdout || "(empty)",
		"",
		"stderr:",
		result.stderr || "(empty)",
	].join("\n");
}

function commandDetails(result: CommandResult) {
	return {
		command: result.command,
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		truncated: result.truncated,
	};
}

function formatSubagentResult(text: string, status: "settled" | "timed out" | "failed", note?: string): string {
	const body = text || "(no assistant text)";
	const suffix = note ? `Subagent ${status}: ${note}` : `Subagent ${status}.`;
	return `${body}\n\n${suffix}`;
}

function assistantTextFromEvent(event: unknown): string | undefined {
	if (!isRecord(event)) return undefined;
	if (event.type === "message_end") return assistantTextFromMessage(event.message);
	if (event.type !== "agent_end" || !Array.isArray(event.messages)) return undefined;
	for (let index = event.messages.length - 1; index >= 0; index--) {
		const text = assistantTextFromMessage(event.messages[index]);
		if (text !== undefined) return text;
	}
	return undefined;
}

function assistantTextFromMessage(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	return message.content
		.filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text")
		.map((part) => typeof part.text === "string" ? part.text : "")
		.join("");
}

function toolExecutionFromEvent(event: unknown): { name: string; arguments: string } | undefined {
	if (!isRecord(event) || event.type !== "tool_execution_start" || typeof event.toolName !== "string") {
		return undefined;
	}
	let arguments_: string;
	try {
		arguments_ = JSON.stringify(event.args);
	} catch {
		arguments_ = "[unserializable args]";
	}
	const limit = 500;
	return {
		name: event.toolName,
		arguments: arguments_.length > limit ? `${arguments_.slice(0, limit - 1)}…` : arguments_,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function deliveryOptions(deliverAs: Delivery) {
	if (deliverAs === "nextTurn") return { deliverAs: "nextTurn" as const };
	return { deliverAs, triggerTurn: true };
}

type RunnerToolName = "prompt" | "process" | "subagent" | "cancel" | "steer" | "peek" | "list";
type RenderTheme = Pick<Theme, "fg">;
type RenderableResult = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
};

function toolRenderers(name: RunnerToolName) {
	return {
		renderCall(
			args: object,
			theme: RenderTheme,
			_context: unknown,
		) {
			return new Text(renderToolCall(name, args as Record<string, unknown>, theme), 0, 0);
		},
		renderResult(
			result: RenderableResult,
			options: { expanded: boolean; isPartial: boolean },
			theme: RenderTheme,
			context: { isError?: boolean },
		) {
			return new Text(renderToolResult(name, result, options.expanded, theme, context.isError === true), 0, 0);
		},
	};
}

function renderToolCall(name: RunnerToolName, args: Record<string, unknown>, theme: RenderTheme): string {
	const parts: string[] = [];
	const previewValue =
		name === "prompt" ? args.message
			: name === "process" ? args.command
				: name === "subagent" ? args.prompt
					: name === "steer" ? args.message
						: undefined;
	if (typeof args.jobId === "string") parts.push(shortJobId(args.jobId));
	if (typeof previewValue === "string") {
		const preview = truncatePreview(previewValue);
		parts.push(name === "process" ? preview : `"${preview}"`);
	}
	if (name === "peek" && typeof args.lines === "number") parts.push(`${args.lines} lines`);
	if (name === "subagent" && typeof args.maxMinutes === "number") parts.push(`max ${args.maxMinutes}m`);
	if (isTrigger(args.trigger)) parts.push(renderTrigger(args.trigger));
	return theme.fg("accent", name) + (parts.length ? theme.fg("muted", ` · ${parts.join(" · ")}`) : "");
}

function renderToolResult(
	name: RunnerToolName,
	result: RenderableResult,
	expanded: boolean,
	theme: RenderTheme,
	isError: boolean,
): string {
	const fallback = result.content.find((part) => part.type === "text")?.text ?? "";
	if (isError || result.isError) return theme.fg("error", fallback || `${name} failed`);
	if (name === "peek") return theme.fg("muted", fallback);
	if (name === "list") {
		const jobs = Array.isArray(result.details) ? result.details.filter(isJobDetails) : [];
		if (jobs.length === 0) return theme.fg("muted", "No active jobs");
		return jobs.map((job) => theme.fg("muted", renderJobLine(job, expanded))).join("\n");
	}
	if (name === "prompt" || name === "process" || name === "subagent") {
		if (!isJobDetails(result.details)) return theme.fg("muted", fallback);
		const status = result.details.trigger.kind === "now"
			? "running"
			: `next ${humanizeTime(result.details.nextRunAt)}`;
		let text = `${theme.fg("success", "✓")} ${theme.fg("muted", `${name} · ${shortJobId(result.details.jobId)} · ${status}`)}`;
		if (expanded) text += `\n${theme.fg("muted", renderJobLine(result.details, true))}`;
		return text;
	}
	if (name === "cancel") {
		const details = isRecord(result.details) ? result.details : {};
		const id = typeof details.jobId === "string" ? shortJobId(details.jobId) : "";
		const confirmation = details.cancelled === true ? `cancelled · ${id}` : `not found · ${id}`;
		return theme.fg(details.cancelled === true ? "success" : "muted", confirmation);
	}
	if (name === "steer") {
		const details = isRecord(result.details) ? result.details : {};
		const id = typeof details.jobId === "string" ? shortJobId(details.jobId) : "";
		return theme.fg("success", `steered · ${id}`);
	}
	return theme.fg("muted", fallback);
}

function renderJobLine(job: JobDetails, expanded: boolean): string {
	const preview =
		job.action.kind === "prompt" ? `"${expanded ? job.action.message : truncatePreview(job.action.message)}"`
			: job.action.kind === "command" ? (expanded ? job.action.command : truncatePreview(job.action.command))
				: `"${expanded ? job.action.prompt : truncatePreview(job.action.prompt)}"`;
	const next = job.running && job.startedAt
		? `running ${humanizeAge(job.startedAt)}`
		: job.trigger.kind === "now" ? "running" : `next ${humanizeTime(job.nextRunAt)}`;
	const compact = `${expanded ? job.jobId : shortJobId(job.jobId)} · ${job.action.kind} · ${preview} · ${next}`;
	if (!expanded) return compact;
	const actionOptions =
		job.action.kind === "command"
			? (job.action.cwd !== undefined ? [`cwd ${job.action.cwd}`] : [])
			: job.action.kind === "subagent"
				? [
					...(job.action.model !== undefined ? [`model ${job.action.model}`] : []),
					...(job.action.cwd !== undefined ? [`cwd ${job.action.cwd}`] : []),
					...(job.action.appendSystemPrompt !== undefined ? [`system "${job.action.appendSystemPrompt}"`] : []),
					...(job.action.maxMinutes !== undefined ? [`max ${job.action.maxMinutes}m`] : []),
				]
				: [];
	return `${compact}${actionOptions.length ? ` · ${actionOptions.join(" · ")}` : ""} · ${renderTrigger(job.trigger)} · ${job.deliverAs}`;
}

function shortJobId(jobId: string): string {
	return jobId.slice(0, 8);
}

function truncatePreview(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= 60 ? normalized : `${normalized.slice(0, 59)}…`;
}

function renderTrigger(trigger: Trigger): string {
	if (trigger.kind === "now") return "now";
	if (trigger.kind === "once") return trigger.at;
	return `cron ${trigger.cron}${trigger.timeZone ? ` ${trigger.timeZone}` : ""}`;
}

function humanizeTime(timestamp: string): string {
	const delta = Date.parse(timestamp) - Date.now();
	if (!Number.isFinite(delta)) return timestamp;
	if (delta <= 0) return "now";
	const seconds = Math.round(delta / 1_000);
	if (seconds < 60) return `in ${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `in ${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `in ${hours}h`;
	return `in ${Math.round(hours / 24)}d`;
}

function humanizeAge(timestamp: string): string {
	const elapsed = Math.max(0, Date.now() - Date.parse(timestamp));
	const seconds = Math.floor(elapsed / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h`;
}

function isTrigger(value: unknown): value is Trigger {
	return isRecord(value) && (value.kind === "now" || value.kind === "once" || value.kind === "cron");
}

function isJobDetails(value: unknown): value is JobDetails {
	return isRecord(value)
		&& typeof value.jobId === "string"
		&& isTrigger(value.trigger)
		&& isRecord(value.action)
		&& typeof value.nextRunAt === "string";
}

function toolResult<T>(text: string, details: T) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function updateStatus(ctx: ExtensionContext, scheduledCount: number, runningCount = 0): void {
	if (!ctx.hasUI) return;
	let text: string | undefined;
	if (scheduledCount === 0 && runningCount === 0) {
		text = undefined;
	} else {
		const scheduled = scheduledCount > 0 ? ` ${ctx.ui.theme.fg("success", `${scheduledCount} scheduled`)}` : "";
		const running =
			runningCount > 0
				? ctx.ui.theme.fg("warning", `${scheduledCount > 0 ? " · " : " "}${runningCount} running`)
				: "";
		text = `${ctx.ui.theme.fg("accent", "runner")}${scheduled}${running}`;
	}
	ctx.ui.setStatus("runner", text);
}

/** Spawn the lean pi RPC child used for a subagent action. */
export function spawnSubagentChild(
	action: SubagentAction,
	executable = "pi",
	overrideArguments?: string[],
): ChildProcess {
	const arguments_ = overrideArguments ?? [
		"--mode",
		"rpc",
		"--no-extensions",
		"--no-context-files",
		...(action.model ? ["--model", action.model] : []),
		...(action.appendSystemPrompt ? ["--append-system-prompt", action.appendSystemPrompt] : []),
	];
	return spawn(executable, arguments_, {
		cwd: action.cwd ?? process.cwd(),
		detached: true,
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function spawnCommandChild(action: CommandAction): ChildProcess {
	return spawn(action.command, {
		cwd: action.cwd ?? process.cwd(),
		detached: true,
		env: process.env,
		shell: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isFileNotFound(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
