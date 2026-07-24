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

import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

type Trigger = CronTrigger | OnceTrigger;

type PromptAction = {
	kind: "prompt";
	message: string;
};

type CommandAction = {
	kind: "command";
	command: string;
	cwd?: string;
};

type Action = PromptAction | CommandAction;
type Delivery = "followUp" | "nextTurn" | "steer";

interface RunningCommand {
	child: ChildProcess;
	settled: Promise<void>;
}

interface Job {
	jobId: string;
	trigger: Trigger;
	action: Action;
	deliverAs: Delivery;
	cron: Cron;
	context: ExtensionContext;
	running?: RunningCommand;
	active: boolean;
}

interface JobDetails {
	jobId: string;
	trigger: Trigger;
	action: Action;
	deliverAs: Delivery;
	nextRunAt: string;
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

const STREAM_LIMIT_BYTES = 8_192;
const KILL_GRACE_MS = 2_000;

export default function (pi: ExtensionAPI) {
	const jobs = new Map<string, Job>();
	const firingJobs = new Map<string, Job>();

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
		updateStatus(ctx, jobs.size);
	});

	pi.on("session_shutdown", async () => {
		const stopping = [...new Set([...jobs.values(), ...firingJobs.values()])].map(stopJob);
		jobs.clear();
		firingJobs.clear();
		await Promise.all(stopping);
	});

	pi.registerTool({
		name: "schedule",
		label: "Schedule Job",
		description: "Schedule a prompt or shell command on a recurring cron schedule or once in the future.",
		parameters: Type.Object({
			trigger: Type.Union([
				Type.Object({
					kind: StringEnum(["cron"] as const),
					cron: Type.String({ description: "Six-field cron expression" }),
					timeZone: Type.Optional(Type.String({ description: "Optional IANA time zone" })),
				}),
				Type.Object({
					kind: StringEnum(["once"] as const),
					at: Type.String({ description: "Future relative time or absolute ISO timestamp" }),
				}),
			]),
			action: Type.Union([
				Type.Object({
					kind: StringEnum(["prompt"] as const),
					message: Type.String({ minLength: 1, description: "Prompt to inject when the schedule fires" }),
				}),
				Type.Object({
					kind: StringEnum(["command"] as const),
					command: Type.String({ minLength: 1, description: "Shell command to run when the schedule fires" }),
					cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the current directory" })),
				}),
			]),
			deliverAs: Type.Optional(StringEnum(["followUp", "nextTurn", "steer"] as const)),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const definition: JobDefinition = {
				jobId: randomUUID(),
				trigger: params.trigger,
				action: params.action,
				deliverAs: params.deliverAs ?? "followUp",
			};
			const job = createJob(definition, ctx);
			jobs.set(job.jobId, job);
			updateStatus(ctx, jobs.size);
			await writeJobs(ctx);
			const details = describeJob(job);
			return toolResult(`Scheduled job ${job.jobId} for ${details.nextRunAt}.`, details);
		},
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
			updateStatus(ctx, jobs.size);
			await stopJob(job);
			await writeJobs(ctx);
			const details = { jobId: params.jobId, found: true, cancelled: true };
			return toolResult(`Cancelled scheduled job ${params.jobId}.`, details);
		},
	});

	pi.registerTool({
		name: "list",
		label: "List Scheduled Jobs",
		description: "List active jobs scheduled in this session.",
		parameters: Type.Object({}),
		async execute() {
			const details = [...jobs.values()].map(describeJob);
			return toolResult(`${details.length} active scheduled job${details.length === 1 ? "" : "s"}.`, details);
		},
	});

	function createJob(definition: JobDefinition, context: ExtensionContext): Job {
		let job: Job;
		const options = {
			name: definition.jobId,
			protect: definition.action.kind === "command",
			catch: (error: unknown) =>
				notify(context, `Runner job ${definition.jobId} failed (${describeError(error)}).`, "error"),
		};
		let cron: Cron;

		if (definition.trigger.kind === "once") {
			cron = new Cron(parseOnceTime(definition.trigger.at), options, () => fireJob(job));
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
		}
		job = {
			...definition,
			context,
			active: true,
			cron,
		};
		return job;
	}

	async function fireJob(job: Job): Promise<void> {
		if (!job.active) return;
		const isOnce = job.trigger.kind === "once";
		if (isOnce) {
			jobs.delete(job.jobId);
			firingJobs.set(job.jobId, job);
			updateStatus(job.context, jobs.size);
			job.cron.stop();
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
			} else {
				details = await executeCommand(job);
				content = formatCommandResult(details);
			}

			if (job.active) {
				try {
					const message = details
						? { customType: "runner", content, display: true, details: commandDetails(details) }
						: { customType: "runner", content, display: true };
					await pi.sendMessage(
						message,
						deliveryOptions(job.deliverAs),
					);
				} catch (error) {
					notify(job.context, `Runner could not deliver scheduled job ${job.jobId} (${describeError(error)}).`, "error");
				}
			}
		} finally {
			if (isOnce) firingJobs.delete(job.jobId);
		}
	}

	async function executeCommand(job: Job): Promise<CommandResult> {
		const action = job.action;
		if (action.kind !== "command") throw new Error("Expected a command action.");
		const stdout = createStreamCapture();
		const stderr = createStreamCapture();
		let spawnError: string | undefined;
		let exitCode: number | null = null;

		let child: ChildProcess;
		try {
			child = spawn(action.command, {
				cwd: action.cwd ?? process.cwd(),
				detached: true,
				env: process.env,
				shell: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
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
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			appendTail(stderr, chunk);
		});
		const settled = new Promise<void>((resolve) => {
			child.once("error", (error) => {
				spawnError = describeError(error);
				resolve();
			});
			child.once("close", (code) => {
				exitCode = code;
				resolve();
			});
		});
		job.running = { child, settled };
		await settled;
		job.running = undefined;

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
			const definitions = [...jobs.values()].map(serializeJob);
			await fs.writeFile(filePath, JSON.stringify(definitions, null, "\t"));
		} catch (error) {
			notify(ctx, `Runner could not persist schedules (${describeError(error)}).`, "warning");
		}
	}
}

function persistencePath(ctx: ExtensionContext): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "runner", `${ctx.sessionManager.getSessionId()}.json`);
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
	const nextRun = job.cron.nextRun();
	if (!nextRun) throw new Error(`Scheduled job ${job.jobId} has no future run.`);
	return {
		jobId: job.jobId,
		trigger: job.trigger,
		action: job.action,
		deliverAs: job.deliverAs,
		nextRunAt: nextRun.toISOString(),
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
	const nextRun = job.cron.nextRun();
	if (!nextRun) throw new Error(`Scheduled job ${job.jobId} has no future run.`);
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
	job.cron.stop();
	if (job.running) await terminateProcessTree(job.running);
}

async function terminateProcessTree(running: RunningCommand): Promise<void> {
	const pid = running.child.pid;
	if (!pid) {
		await running.settled;
		return;
	}
	signalProcessGroup(pid, "SIGTERM");
	const forceKill = setTimeout(() => signalProcessGroup(pid, "SIGKILL"), KILL_GRACE_MS);
	forceKill.unref();
	await running.settled;
	clearTimeout(forceKill);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// The process already exited.
		}
	}
}

function createStreamCapture(): StreamCapture {
	return { tail: Buffer.alloc(0), totalBytes: 0 };
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

function deliveryOptions(deliverAs: Delivery) {
	if (deliverAs === "nextTurn") return { deliverAs: "nextTurn" as const };
	return { deliverAs, triggerTurn: true };
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

function updateStatus(ctx: ExtensionContext, jobCount: number): void {
	if (!ctx.hasUI) return;
	const text =
		jobCount === 0
			? undefined
			: `${ctx.ui.theme.fg("accent", "runner")} ${ctx.ui.theme.fg("success", `${jobCount} job${jobCount === 1 ? "" : "s"}`)}`;
	ctx.ui.setStatus("runner", text);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isFileNotFound(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
