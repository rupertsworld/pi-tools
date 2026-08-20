/**
 * Keep pi's prompt resources current and append configured context files each turn.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
	CONFIG_DIR_NAME,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface WatchedPiece {
	path?: string;
	content: string;
	loadedText: string;
	lastRead: "ok" | "unreadable";
}

interface AdditionalFile {
	path: string;
	lastRead: "ok" | "unreadable";
}

interface SessionState {
	initialized: boolean;
	agentDir: string;
	cwd: string;
	pieces: WatchedPiece[];
	additionalFiles: AdditionalFile[];
	warnedConfigs: Set<string>;
	warnedStartupFiles: Set<string>;
	warnedEmptyLoadedFiles: Set<string>;
	warnedAdditionalFiles: Set<string>;
	warnedVariables: Set<string>;
}

interface ClaimedRegion {
	start: number;
	end: number;
}

const TEMPLATE_VARIABLE = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;

export default function (pi: ExtensionAPI) {
	let state = createSessionState();

	pi.on("session_start", () => {
		state = createSessionState();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (!state.initialized) await initialize(state, event.systemPromptOptions, ctx);

			state.cwd = event.systemPromptOptions.cwd;
			const variables = getVariables(state);
			let systemPrompt = event.systemPrompt;
			const claimedRegions: ClaimedRegion[] = [];

			for (const piece of state.pieces) {
				await refreshPiece(piece, state, ctx);
				const freshText = renderTemplate(piece.content, variables, state, ctx);
				systemPrompt = substituteClaimedOccurrence(systemPrompt, piece.loadedText, freshText, claimedRegions);
			}

			const additionalSection = await buildAdditionalSection(state, variables, ctx);
			if (additionalSection !== undefined) systemPrompt += `\n\n${additionalSection}`;

			if (systemPrompt !== event.systemPrompt) return { systemPrompt };
		} catch (error) {
			notify(ctx, `Dynamic context could not refresh the system prompt (${describeError(error)}).`, "warning");
		}
	});

	pi.registerCommand("dynamic-context", {
		description: "Report dynamic system-prompt variables and watched files",
		handler: async (_args, ctx) => {
			try {
				const options = ctx.getSystemPromptOptions();
				if (!state.initialized) await initialize(state, options, ctx);
				state.cwd = options.cwd;
				await refreshAdditionalFiles(state, ctx);
				const variables = getVariables(state);
				const variableLines = Object.entries(variables).map(([name, value]) => `{{${name}}}: ${value}`);
				const startupFileLines = state.pieces
					.filter((piece): piece is WatchedPiece & { path: string } => piece.path !== undefined)
					.map((piece) => `${piece.path}: ${piece.lastRead}`);
				const additionalFileLines = state.additionalFiles.map((file) => `${file.path}: ${file.lastRead}`);
				const startupFiles = startupFileLines.length > 0 ? startupFileLines.join("\n") : "(none)";
				const additionalFiles = additionalFileLines.length > 0 ? additionalFileLines.join("\n") : "(none)";
				notify(
					ctx,
					`Dynamic context\n\nVariables\n${variableLines.join("\n")}\n\nWatched files\n${startupFiles}\n\nAdditional files\n${additionalFiles}`,
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
		additionalFiles: [],
		warnedConfigs: new Set(),
		warnedStartupFiles: new Set(),
		warnedEmptyLoadedFiles: new Set(),
		warnedAdditionalFiles: new Set(),
		warnedVariables: new Set(),
	};
}

async function initialize(
	state: SessionState,
	options: BuildSystemPromptOptions,
	ctx: ExtensionContext,
): Promise<void> {
	state.initialized = true;
	state.agentDir = resolveAgentDir();
	state.cwd = options.cwd;

	const { customPrompt, appendSystemPrompt, contextFiles } = options;
	const projectTrusted = ctx.isProjectTrusted();
	if (customPrompt !== undefined) {
		state.pieces.push({
			path: await resolvePromptPath(customPrompt, "SYSTEM.md", state.cwd, state.agentDir, projectTrusted),
			content: customPrompt,
			loadedText: customPrompt,
			lastRead: "ok",
		});
	}
	if (appendSystemPrompt !== undefined) {
		state.pieces.push({
			path: await resolvePromptPath(appendSystemPrompt, "APPEND_SYSTEM.md", state.cwd, state.agentDir, projectTrusted),
			content: appendSystemPrompt,
			loadedText: appendSystemPrompt,
			lastRead: "ok",
		});
	}
	for (const file of contextFiles ?? []) {
		state.pieces.push({
			path: file.path,
			content: file.content,
			loadedText: file.content,
			lastRead: "ok",
		});
	}
}

async function resolvePromptPath(
	loadedContent: string,
	fileName: "SYSTEM.md" | "APPEND_SYSTEM.md",
	cwd: string,
	agentDir: string,
	projectTrusted: boolean,
): Promise<string | undefined> {
	const paths = [join(agentDir, fileName)];
	if (projectTrusted) paths.unshift(join(cwd, CONFIG_DIR_NAME, fileName));
	for (const path of paths) {
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
		if (piece.loadedText === "" && piece.content !== "" && !state.warnedEmptyLoadedFiles.has(piece.path)) {
			state.warnedEmptyLoadedFiles.add(piece.path);
			notify(ctx, `Dynamic context found content in ${piece.path}, which was empty when loaded; run /reload to pick it up.`, "warning");
		}
	} catch (error) {
		piece.lastRead = "unreadable";
		if (!state.warnedStartupFiles.has(piece.path)) {
			state.warnedStartupFiles.add(piece.path);
			notify(ctx, `Dynamic context could not read ${piece.path}; keeping its last-read content (${describeError(error)}).`, "warning");
		}
	}
}

function substituteClaimedOccurrence(
	systemPrompt: string,
	loadedText: string,
	freshText: string,
	claimedRegions: ClaimedRegion[],
): string {
	if (loadedText === "") return systemPrompt;
	let index = systemPrompt.indexOf(loadedText);
	while (index !== -1) {
		const end = index + loadedText.length;
		if (!claimedRegions.some((region) => index < region.end && end > region.start)) {
			const lengthChange = freshText.length - loadedText.length;
			for (const region of claimedRegions) {
				if (region.start < end) continue;
				region.start += lengthChange;
				region.end += lengthChange;
			}
			claimedRegions.push({ start: index, end: index + freshText.length });
			if (loadedText === freshText) return systemPrompt;
			return systemPrompt.slice(0, index) + freshText + systemPrompt.slice(end);
		}
		index = systemPrompt.indexOf(loadedText, index + 1);
	}
	return systemPrompt;
}

async function buildAdditionalSection(
	state: SessionState,
	variables: Record<string, string>,
	ctx: ExtensionContext,
): Promise<string | undefined> {
	const files = await refreshAdditionalFiles(state, ctx);
	if (files.length === 0) return undefined;
	const blocks = files.map((file) =>
		`<context_file path="${file.path}">\n${renderTemplate(file.content, variables, state, ctx)}\n</context_file>`,
	);
	return `<dynamic_context>\n\nAdditional context files:\n\n${blocks.join("\n\n")}\n\n</dynamic_context>`;
}

async function refreshAdditionalFiles(
	state: SessionState,
	ctx: ExtensionContext,
): Promise<Array<{ path: string; content: string }>> {
	const sources = [{ path: join(state.agentDir, "dynamic-context.json"), base: state.agentDir }];
	if (ctx.isProjectTrusted()) {
		sources.push({
			path: join(state.cwd, CONFIG_DIR_NAME, "dynamic-context.json"),
			base: state.cwd,
		});
	}

	const paths = new Set<string>();
	for (const source of sources) {
		const configuredPaths = await readConfig(source.path, state, ctx);
		for (const configuredPath of configuredPaths) {
			const path = configuredPath.startsWith("~/")
				? resolve(homedir(), configuredPath.slice(2))
				: resolve(source.base, configuredPath);
			paths.add(path);
		}
	}

	state.additionalFiles = [...paths].map((path) => ({ path, lastRead: "unreadable" }));
	const readableFiles: Array<{ path: string; content: string }> = [];
	for (const file of state.additionalFiles) {
		try {
			const content = await readFile(file.path, "utf8");
			file.lastRead = "ok";
			readableFiles.push({ path: file.path, content });
		} catch (error) {
			if (!state.warnedAdditionalFiles.has(file.path)) {
				state.warnedAdditionalFiles.add(file.path);
				notify(ctx, `Dynamic context could not read ${file.path}; omitting it this turn (${describeError(error)}).`, "warning");
			}
		}
	}
	return readableFiles;
}

async function readConfig(path: string, state: SessionState, ctx: ExtensionContext): Promise<string[]> {
	try {
		const config = JSON.parse(await readFile(path, "utf8")) as unknown;
		const files = typeof config === "object" && config !== null && "files" in config
			? config.files
			: undefined;
		if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) {
			throw new Error('expected an object with a string array at "files"');
		}
		return files;
	} catch (error) {
		if (isMissingFile(error)) return [];
		warnConfig(path, error, state, ctx);
		return [];
	}
}

function warnConfig(path: string, error: unknown, state: SessionState, ctx: ExtensionContext): void {
	if (state.warnedConfigs.has(path)) return;
	state.warnedConfigs.add(path);
	notify(ctx, `Dynamic context could not load ${path}; treating it as empty (${describeError(error)}).`, "warning");
}

function getVariables(state: SessionState, now = new Date()): Record<string, string> {
	const timeZone = hostTimeZone();
	return {
		DATE: formatLocalDate(now),
		TIME: formatLocalTime(now),
		TZ: timeZone || formatTimezoneOffset(now),
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

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
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
