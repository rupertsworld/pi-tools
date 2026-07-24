/**
 * Runner extension: schedule prompts for injection into the active session.
 *
 * Jobs are session-scoped and held only in memory. See SPEC.md.
 */

import { randomUUID } from "node:crypto";

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

interface Job {
	jobId: string;
	message: string;
	trigger: Trigger;
	cron: Cron;
	context: ExtensionContext;
}

interface JobDetails {
	jobId: string;
	message: string;
	trigger: Trigger;
	nextRunAt: string;
}

export default function (pi: ExtensionAPI) {
	const jobs = new Map<string, Job>();

	pi.on("session_shutdown", () => {
		for (const job of jobs.values()) stopJob(job);
		jobs.clear();
	});

	pi.registerTool({
		name: "schedule",
		label: "Schedule Prompt",
		description: "Schedule a prompt to be injected into this session on a recurring cron schedule or once in the future.",
		parameters: Type.Object({
			message: Type.String({ minLength: 1, description: "Prompt to inject when the schedule fires" }),
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
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const jobId = randomUUID();
			const job = createJob(jobId, params.message, params.trigger, ctx);
			jobs.set(jobId, job);
			const details = describeJob(job);
			return toolResult(`Scheduled prompt ${jobId} for ${details.nextRunAt}.`, details);
		},
	});

	pi.registerTool({
		name: "cancel",
		label: "Cancel Scheduled Prompt",
		description: "Cancel an active scheduled prompt by job ID.",
		parameters: Type.Object({
			jobId: Type.String({ description: "ID returned by schedule" }),
		}),
		async execute(_toolCallId, params) {
			const job = jobs.get(params.jobId);
			if (!job) {
				const details = { jobId: params.jobId, found: false, cancelled: false };
				return toolResult(`No active scheduled prompt found for ${params.jobId}.`, details);
			}
			jobs.delete(params.jobId);
			stopJob(job);
			const details = { jobId: params.jobId, found: true, cancelled: true };
			return toolResult(`Cancelled scheduled prompt ${params.jobId}.`, details);
		},
	});

	pi.registerTool({
		name: "list",
		label: "List Scheduled Prompts",
		description: "List active prompts scheduled in this session.",
		parameters: Type.Object({}),
		async execute() {
			const details = [...jobs.values()].map(describeJob);
			return toolResult(`${details.length} active scheduled prompt${details.length === 1 ? "" : "s"}.`, details);
		},
	});

	function createJob(jobId: string, message: string, trigger: Trigger, context: ExtensionContext): Job {
		if (trigger.kind === "once") {
			const runAt = parseOnceTime(trigger.at);
			const cron = new Cron(
				runAt,
				{
					name: jobId,
					catch: (error) => notify(context, `Runner one-shot ${jobId} failed (${describeError(error)}).`, "error"),
				},
				() => fireJob(jobId),
			);
			return { jobId, message, trigger, context, cron };
		}

		validateTimeZone(trigger.timeZone);
		let cron: Cron;
		try {
			cron = new Cron(
				trigger.cron,
				{
					mode: "6-part",
					name: jobId,
					timezone: trigger.timeZone,
					catch: (error) => notify(context, `Runner cron ${jobId} failed (${describeError(error)}).`, "error"),
				},
				() => fireJob(jobId),
			);
		} catch (error) {
			throw new Error(`Invalid cron expression "${trigger.cron}": ${describeError(error)}`);
		}
		if (!cron.nextRun()) {
			cron.stop();
			throw new Error(`Invalid cron expression "${trigger.cron}": it has no future run.`);
		}
		return {
			jobId,
			message,
			trigger,
			context,
			cron,
		};
	}

	function fireJob(jobId: string): void {
		const job = jobs.get(jobId);
		if (!job) return;
		if (job.trigger.kind === "once") {
			jobs.delete(jobId);
			stopJob(job);
		}
		try {
			pi.sendMessage(
				{ customType: "runner", content: job.message, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch (error) {
			notify(job.context, `Runner could not inject scheduled prompt ${jobId} (${describeError(error)}).`, "error");
		}
	}
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
	if (!nextRun) throw new Error(`Scheduled prompt ${job.jobId} has no future run.`);
	return {
		jobId: job.jobId,
		message: job.message,
		trigger: job.trigger,
		nextRunAt: nextRun.toISOString(),
	};
}

function stopJob(job: Job): void {
	job.cron.stop();
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

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
