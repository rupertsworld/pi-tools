/**
 * Keep pi's startup-loaded prompt resources current for every agent turn.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface WatchedPiece {
	path?: string;
	content: string;
	loadedText: string;
	previousText: string;
	lastRead: "ok" | "unreadable";
	renderVariables: boolean;
}

interface SessionState {
	initialized: boolean;
	agentDir: string;
	cwd: string;
	pieces: WatchedPiece[];
	warnedFiles: Set<string>;
	warnedVariables: Set<string>;
}

const TEMPLATE_VARIABLE = /\{\{([A-Z0-9_]+)\}\}/g;

export default function (pi: ExtensionAPI) {
	let state = createSessionState();

	pi.on("session_start", () => {
		state = createSessionState();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (!state.initialized) await initialize(state, event);

			state.cwd = event.systemPromptOptions.cwd;
			const variables = getVariables(state);
			let systemPrompt = event.systemPrompt;

			for (const piece of state.pieces) {
				await refreshPiece(piece, state, ctx);
				const freshText = piece.renderVariables
					? renderTemplate(piece.content, variables, state, ctx)
					: piece.content;

				const staleText = findStaleText(systemPrompt, piece, freshText);
				if (staleText === undefined) continue;
				const index = systemPrompt.indexOf(staleText);
				if (index === -1) continue;

				systemPrompt =
					systemPrompt.slice(0, index) +
					freshText +
					systemPrompt.slice(index + staleText.length);
				piece.previousText = freshText;
			}

			if (systemPrompt !== event.systemPrompt) return { systemPrompt };
		} catch (error) {
			notify(ctx, `Dynamic context could not refresh the system prompt (${describeError(error)}).`, "warning");
		}
	});

	pi.registerCommand("dynamic-context", {
		description: "Report dynamic system-prompt variables and watched files",
		handler: async (_args, ctx) => {
			try {
				const variables = getVariables(state);
				const variableLines = Object.entries(variables).map(([name, value]) => `{{${name}}}: ${value}`);
				const fileLines = state.pieces
					.filter((piece): piece is WatchedPiece & { path: string } => piece.path !== undefined)
					.map((piece) => `${piece.path}: ${piece.lastRead}`);
				const watchedFiles = fileLines.length > 0 ? fileLines.join("\n") : "(none)";
				notify(
					ctx,
					`Dynamic context\n\nVariables\n${variableLines.join("\n")}\n\nWatched files\n${watchedFiles}`,
					"info",
				);
			} catch (error) {
				notify(ctx, `Dynamic context status is unavailable (${describeError(error)}).`, "warning");
			}
		},
	});
}

function createSessionState(): SessionState {
	return {
		initialized: false,
		agentDir: resolveAgentDir(),
		cwd: process.cwd(),
		pieces: [],
		warnedFiles: new Set(),
		warnedVariables: new Set(),
	};
}

async function initialize(
	state: SessionState,
	event: BeforeAgentStartEvent,
): Promise<void> {
	state.initialized = true;
	state.agentDir = resolveAgentDir();
	state.cwd = event.systemPromptOptions.cwd;

	const { customPrompt, appendSystemPrompt, contextFiles } = event.systemPromptOptions;
	if (customPrompt !== undefined) {
		state.pieces.push({
			path: await resolvePromptPath(customPrompt, "SYSTEM.md", state.cwd, state.agentDir),
			content: customPrompt,
			loadedText: customPrompt,
			previousText: customPrompt,
			lastRead: "ok",
			renderVariables: true,
		});
	}
	if (appendSystemPrompt !== undefined) {
		state.pieces.push({
			path: await resolvePromptPath(appendSystemPrompt, "APPEND_SYSTEM.md", state.cwd, state.agentDir),
			content: appendSystemPrompt,
			loadedText: appendSystemPrompt,
			previousText: appendSystemPrompt,
			lastRead: "ok",
			renderVariables: true,
		});
	}
	for (const file of contextFiles ?? []) {
		state.pieces.push({
			path: file.path,
			content: file.content,
			loadedText: file.content,
			previousText: file.content,
			lastRead: "ok",
			renderVariables: false,
		});
	}
}

function findStaleText(systemPrompt: string, piece: WatchedPiece, freshText: string): string | undefined {
	for (const candidate of [piece.previousText, piece.loadedText]) {
		if (candidate !== "" && candidate !== freshText && systemPrompt.includes(candidate)) return candidate;
	}
	return undefined;
}

async function resolvePromptPath(
	loadedContent: string,
	fileName: "SYSTEM.md" | "APPEND_SYSTEM.md",
	cwd: string,
	agentDir: string,
): Promise<string | undefined> {
	for (const path of [join(cwd, ".pi", fileName), join(agentDir, fileName)]) {
		try {
			if ((await readFile(path, "utf8")) === loadedContent) return path;
		} catch {
			// Candidate discovery is best-effort; only selected files are watched.
		}
	}
	return undefined;
}

async function refreshPiece(piece: WatchedPiece, state: SessionState, ctx: ExtensionContext): Promise<void> {
	if (piece.path === undefined) return;
	try {
		piece.content = await readFile(piece.path, "utf8");
		piece.lastRead = "ok";
	} catch (error) {
		piece.lastRead = "unreadable";
		if (!state.warnedFiles.has(piece.path)) {
			state.warnedFiles.add(piece.path);
			notify(ctx, `Dynamic context could not read ${piece.path}; keeping its last-read content (${describeError(error)}).`, "warning");
		}
	}
}

function getVariables(state: SessionState, now = new Date()): Record<string, string> {
	const timeZone = hostTimeZone();
	return {
		DATE: formatLocalDate(now),
		TIME: formatLocalTime(now),
		TZ: timeZone || formatTimezoneOffset(now),
		AGENT_DIR: state.agentDir,
		CWD: state.cwd,
	};
}

function formatLocalDate(date: Date): string {
	return [date.getFullYear(), pad2(date.getMonth() + 1), pad2(date.getDate())].join("-");
}

function formatLocalTime(date: Date): string {
	return [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad2).join(":");
}

function formatTimezoneOffset(date: Date): string {
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absoluteMinutes = Math.abs(offsetMinutes);
	return `UTC${sign}${pad2(Math.floor(absoluteMinutes / 60))}:${pad2(absoluteMinutes % 60)}`;
}

function hostTimeZone(): string | undefined {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
}

function renderTemplate(
	template: string,
	variables: Record<string, string>,
	state: SessionState,
	ctx: ExtensionContext,
): string {
	return template.replace(TEMPLATE_VARIABLE, (match, name: string) => {
		const value = variables[name];
		if (value !== undefined) return value;
		if (!state.warnedVariables.has(name)) {
			state.warnedVariables.add(name);
			notify(ctx, `Dynamic context does not recognize template variable ${match}; leaving it unchanged.`, "warning");
		}
		return match;
	});
}

function resolveAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
