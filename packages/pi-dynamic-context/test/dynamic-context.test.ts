import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
	CONFIG_DIR_NAME,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import createDynamicContextExtension from "../index.ts";

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface StubPi {
	pi: ExtensionAPI;
	handlers: Map<string, EventHandler>;
	commands: Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
}

interface ContextFile {
	path: string;
	content: string;
}

interface TurnOptions {
	customPrompt?: string;
	appendSystemPrompt?: string;
	contextFiles?: ContextFile[];
	cwd?: string;
	projectTrusted?: boolean;
}

let agentDir: string;
let projectDir: string;
let previousAgentDirEnv: string | undefined;
let stub: StubPi;
let notifications: Array<{ message: string; type?: string }>;

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-dynamic-context-agent-"));
	projectDir = await mkdtemp(join(tmpdir(), "pi-dynamic-context-project-"));
	previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	notifications = [];
	stub = createStubPi();
	createDynamicContextExtension(stub.pi);
});

afterEach(async () => {
	if (previousAgentDirEnv === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv;
	}
	await rm(agentDir, { recursive: true, force: true });
	await rm(projectDir, { recursive: true, force: true });
});

function createStubPi(): StubPi {
	const handlers = new Map<string, EventHandler>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, options);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands };
}

function stubCtx(projectTrusted = true, options: TurnOptions = {}): {
	hasUI: boolean;
	getSystemPromptOptions: () => BuildSystemPromptOptions;
	isProjectTrusted: () => boolean;
	ui: { notify: (message: string, type?: string) => void };
} {
	return {
		hasUI: true,
		getSystemPromptOptions: () => getSystemPromptOptions(options),
		isProjectTrusted: () => projectTrusted,
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
		},
	};
}

function getSystemPromptOptions(options: TurnOptions = {}): BuildSystemPromptOptions {
	return {
		cwd: options.cwd ?? projectDir,
		customPrompt: options.customPrompt,
		appendSystemPrompt: options.appendSystemPrompt,
		contextFiles: options.contextFiles,
	};
}

// Simulates one turn: pi rebuilds the base prompt from the ORIGINAL as-loaded
// options each turn, so callers pass the same base prompt (and the same
// systemPromptOptions) on every turn unless simulating another extension.
async function runTurn(systemPrompt: string, options: TurnOptions = {}): Promise<string | undefined> {
	const handler = stub.handlers.get("before_agent_start");
	assert.ok(handler, "before_agent_start handler must be registered");
	const event = {
		type: "before_agent_start",
		prompt: "hello",
		systemPrompt,
		systemPromptOptions: getSystemPromptOptions(options),
	};
	const result = (await handler(event, stubCtx(options.projectTrusted, options))) as { systemPrompt?: string } | undefined;
	return result?.systemPrompt;
}

// Simulates the shape of pi's assembled base prompt: custom prompt (or the
// default), a tools section, embedded context files, then appended text.
function buildPrompt(options: TurnOptions = {}): string {
	let prompt = options.customPrompt ?? "You are pi, a coding agent.";
	prompt += "\n\n<tools>\nread, bash, edit, write\n</tools>";
	for (const file of options.contextFiles ?? []) {
		prompt += `\n\n<context path="${file.path}">\n${file.content}\n</context>`;
	}
	if (options.appendSystemPrompt) {
		prompt += `\n\n${options.appendSystemPrompt}`;
	}
	return prompt;
}

function warningsMatching(pattern: RegExp): number {
	return notifications.filter((entry) => pattern.test(entry.message)).length;
}

describe("template variables", () => {
	it("renders all variables in SYSTEM.md content using the host time zone", async () => {
		const template = "date={{ DATE }}\ntime={{TIME}}\ntz={{\tTZ }}\ncwd={{  CWD  }}";
		const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		await writeFile(join(agentDir, "SYSTEM.md"), template, "utf8");

		const result = await runTurn(buildPrompt({ customPrompt: template }), { customPrompt: template });

		assert.ok(result, "prompt must be modified");
		assert.match(result, /date=\d{4}-\d{2}-\d{2}\n/);
		assert.match(result, /time=\d{2}:\d{2}:\d{2}\n/);
		if (hostTimeZone) {
			assert.ok(result.includes(`tz=${hostTimeZone}\n`));
		} else {
			assert.match(result, /tz=UTC[+-]\d{2}:\d{2}\n/);
		}
		assert.ok(result.includes(`cwd=${projectDir}`));
		assert.ok(result.includes("<tools>"), "the rest of the prompt is preserved");
		assert.equal(notifications.length, 0);
	});

	it("renders variables in a custom prompt not backed by any file", async () => {
		const template = "flag-provided prompt, cwd is {{CWD}}";

		const result = await runTurn(buildPrompt({ customPrompt: template }), { customPrompt: template });

		assert.ok(result);
		assert.ok(result.includes(`flag-provided prompt, cwd is ${projectDir}`));
	});

	it("re-renders variable values before each turn", async () => {
		const template = "cwd is {{ CWD }}";
		const base = buildPrompt({ customPrompt: template });

		const first = await runTurn(base, { customPrompt: template, cwd: projectDir });
		const second = await runTurn(base, { customPrompt: template, cwd: agentDir });

		assert.ok(first?.includes(`cwd is ${projectDir}`));
		assert.ok(second?.includes(`cwd is ${agentDir}`));
	});

	it("re-renders the current local time before each turn", async () => {
		const template = "time={{ TIME }}";
		const base = buildPrompt({ customPrompt: template });
		const readCurrentTime = (result: string | undefined): string => {
			assert.ok(result);
			const match = /time=(\d{2}):(\d{2}):(\d{2})/.exec(result);
			assert.ok(match);
			const renderedSeconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
			const now = new Date();
			const currentSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
			const difference = Math.abs(renderedSeconds - currentSeconds);
			assert.ok(Math.min(difference, 86400 - difference) <= 2, `${match[0]} must be current`);
			return match[0];
		};

		const firstTime = readCurrentTime(await runTurn(base, { customPrompt: template }));
		await new Promise<void>((done) => setTimeout(done, 1100 - new Date().getMilliseconds()));
		const secondTime = readCurrentTime(await runTurn(base, { customPrompt: template }));

		assert.notEqual(secondTime, firstTime, "the second turn must not reuse the previous literal");
	});

	it("warns once per session for an unknown uppercase variable and leaves each token verbatim", async () => {
		const template = "hello {{ AGENT_DIR }} and {{AGENT_DIR}} in {{ CWD }}";
		await writeFile(join(agentDir, "SYSTEM.md"), template, "utf8");
		const base = buildPrompt({ customPrompt: template });

		const first = await runTurn(base, { customPrompt: template });
		const second = await runTurn(base, { customPrompt: template });

		assert.ok(first?.includes("{{ AGENT_DIR }} and {{AGENT_DIR}}"), "unknown tokens left verbatim");
		assert.ok(first?.includes(`in ${projectDir}`), "known variables still render");
		assert.ok(second?.includes("{{ AGENT_DIR }} and {{AGENT_DIR}}"));
		assert.equal(warningsMatching(/AGENT_DIR/), 1);
	});

	it("leaves non-token brace content byte-for-byte and does not warn", async () => {
		const template = "{{ lowercase }} {{ MixedCase }} {{ BAD-NAME }} {{ NAME! }} {{ }}";
		await writeFile(join(agentDir, "SYSTEM.md"), template, "utf8");

		const result = await runTurn(buildPrompt({ customPrompt: template }), { customPrompt: template });

		assert.equal(result, undefined);
		assert.equal(notifications.length, 0);
	});

	it("renders variables inside context files", async () => {
		const contextPath = join(projectDir, "AGENTS.md");
		await writeFile(contextPath, "ctx v1 {{ CWD }}", "utf8");
		const contextFiles = [{ path: contextPath, content: "ctx v1 {{ CWD }}" }];
		const base = buildPrompt({ contextFiles });

		const first = await runTurn(base, { contextFiles });
		await writeFile(contextPath, "ctx v2 {{ CWD }}", "utf8");
		const second = await runTurn(base, { contextFiles });

		assert.ok(first?.includes(`ctx v1 ${projectDir}`));
		assert.ok(second?.includes(`ctx v2 ${projectDir}`), "context content and token both refresh");
	});
});

describe("per-turn refresh", () => {
	it("picks up SYSTEM.md edits on the next turn", async () => {
		await writeFile(join(agentDir, "SYSTEM.md"), "system one", "utf8");
		const base = buildPrompt({ customPrompt: "system one" });

		const first = await runTurn(base, { customPrompt: "system one" });
		assert.equal(first, undefined, "no change while the file matches the loaded content");

		await writeFile(join(agentDir, "SYSTEM.md"), "system two", "utf8");
		const second = await runTurn(base, { customPrompt: "system one" });

		assert.ok(second?.includes("system two"));
		assert.ok(!second?.includes("system one"));
		assert.ok(second?.includes("<tools>"), "the rest of the prompt is preserved");
	});

	it("watches the project .pi/SYSTEM.md when its content matches", async () => {
		await mkdir(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		await writeFile(join(projectDir, CONFIG_DIR_NAME, "SYSTEM.md"), "project prompt v1", "utf8");
		await writeFile(join(agentDir, "SYSTEM.md"), "unrelated global prompt", "utf8");
		const base = buildPrompt({ customPrompt: "project prompt v1" });

		await runTurn(base, { customPrompt: "project prompt v1" });
		await writeFile(join(projectDir, CONFIG_DIR_NAME, "SYSTEM.md"), "project prompt v2", "utf8");
		const second = await runTurn(base, { customPrompt: "project prompt v1" });

		assert.ok(second?.includes("project prompt v2"));
	});

	it("does not probe project prompt files when the project is untrusted", async () => {
		const loadedPrompt = "same startup prompt";
		const projectPromptPath = join(projectDir, CONFIG_DIR_NAME, "SYSTEM.md");
		const globalPromptPath = join(agentDir, "SYSTEM.md");
		await mkdir(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		await writeFile(projectPromptPath, loadedPrompt, "utf8");
		await writeFile(globalPromptPath, loadedPrompt, "utf8");
		const base = buildPrompt({ customPrompt: loadedPrompt });

		await runTurn(base, { customPrompt: loadedPrompt, projectTrusted: false });
		await writeFile(projectPromptPath, "untrusted project edit", "utf8");
		assert.equal(
			await runTurn(base, { customPrompt: loadedPrompt, projectTrusted: false }),
			undefined,
			"an untrusted project edit is ignored",
		);

		await writeFile(globalPromptPath, "trusted global edit", "utf8");
		const globalEdit = await runTurn(base, { customPrompt: loadedPrompt, projectTrusted: false });
		assert.ok(globalEdit?.includes("trusted global edit"));
		assert.ok(!globalEdit?.includes("untrusted project edit"));
	});

	it("picks up APPEND_SYSTEM.md edits and renders its variables", async () => {
		await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "append v1 in {{CWD}}", "utf8");
		const base = buildPrompt({ appendSystemPrompt: "append v1 in {{CWD}}" });

		const first = await runTurn(base, { appendSystemPrompt: "append v1 in {{CWD}}" });
		assert.ok(first?.includes(`append v1 in ${projectDir}`));

		await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "append v2 in {{CWD}}", "utf8");
		const second = await runTurn(base, { appendSystemPrompt: "append v1 in {{CWD}}" });
		assert.ok(second?.includes(`append v2 in ${projectDir}`));
		assert.ok(!second?.includes("append v1"));
	});

	it("picks up context file edits on the next turn", async () => {
		const contextPath = join(projectDir, "AGENTS.md");
		await writeFile(contextPath, "context one", "utf8");
		const contextFiles = [{ path: contextPath, content: "context one" }];
		const base = buildPrompt({ contextFiles });

		const first = await runTurn(base, { contextFiles });
		assert.equal(first, undefined, "no change while the file matches the loaded content");

		await writeFile(contextPath, "context two", "utf8");
		const second = await runTurn(base, { contextFiles });

		assert.ok(second?.includes("context two"));
		assert.ok(!second?.includes("context one"));
	});

	it("keeps last content and warns once when a context file is deleted", async () => {
		const contextPath = join(projectDir, "AGENTS.md");
		await writeFile(contextPath, "context alive", "utf8");
		const contextFiles = [{ path: contextPath, content: "context alive" }];
		const base = buildPrompt({ contextFiles });

		await runTurn(base, { contextFiles });
		await unlink(contextPath);

		const second = await runTurn(base, { contextFiles });
		const third = await runTurn(base, { contextFiles });

		assert.ok(second === undefined || second.includes("context alive"), "last content kept");
		assert.ok(third === undefined || third.includes("context alive"));
		assert.equal(warningsMatching(new RegExp(contextPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))), 1, "warns once per file per session");
	});

	it("warns once when a startup-loaded empty file gains content and leaves its prompt slot unchanged", async () => {
		const contextPath = join(projectDir, "AGENTS.md");
		await writeFile(contextPath, "", "utf8");
		const contextFiles = [{ path: contextPath, content: "" }];
		const base = buildPrompt({ contextFiles });

		assert.equal(await runTurn(base, { contextFiles }), undefined);
		await writeFile(contextPath, "new context", "utf8");
		assert.equal(await runTurn(base, { contextFiles }), undefined);
		assert.equal(await runTurn(base, { contextFiles }), undefined);

		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]!.type, "warning");
		assert.ok(notifications[0]!.message.includes(contextPath));
		assert.match(notifications[0]!.message, /\/reload/);
	});

	it("does not warn about empty-at-load handling while a startup-loaded file remains empty", async () => {
		const contextPath = join(projectDir, "AGENTS.md");
		await writeFile(contextPath, "", "utf8");
		const contextFiles = [{ path: contextPath, content: "" }];
		const base = buildPrompt({ contextFiles });

		assert.equal(await runTurn(base, { contextFiles }), undefined);
		assert.equal(await runTurn(base, { contextFiles }), undefined);
		assert.equal(notifications.length, 0);
	});

	it("does not warn about empty-at-load handling for a file that was initially non-empty", async () => {
		const contextPath = join(projectDir, "AGENTS.md");
		await writeFile(contextPath, "initial context", "utf8");
		const contextFiles = [{ path: contextPath, content: "initial context" }];
		const base = buildPrompt({ contextFiles });

		await runTurn(base, { contextFiles });
		await writeFile(contextPath, "updated context", "utf8");
		const updated = await runTurn(base, { contextFiles });

		assert.ok(updated?.includes("updated context"));
		assert.equal(notifications.length, 0);
	});

	it("does nothing when pi loaded no custom prompt and no context files", async () => {
		const base = "You are pi, a coding agent. Today is {{DATE}}.\n\n<tools>\nread\n</tools>";

		const result = await runTurn(base, {});

		assert.equal(result, undefined);
		assert.ok(base.includes("{{DATE}}"), "default-prompt tokens are never rendered");
		assert.equal(notifications.length, 0);
	});

	it("does not discover startup-loaded files that appear after initialization", async () => {
		const base = buildPrompt();

		await runTurn(base);
		await writeFile(join(projectDir, "AGENTS.md"), "late context", "utf8");
		const second = await runTurn(base);

		assert.equal(second, undefined);
		assert.equal(notifications.length, 0);
	});

	it("leaves a piece alone when its text is absent from the chained prompt", async () => {
		await writeFile(join(agentDir, "SYSTEM.md"), "system one", "utf8");
		const contextPath = join(projectDir, "AGENTS.md");
		await writeFile(contextPath, "context one", "utf8");
		const contextFiles = [{ path: contextPath, content: "context one" }];
		const base = buildPrompt({ customPrompt: "system one", contextFiles });

		await runTurn(base, { customPrompt: "system one", contextFiles });

		await writeFile(join(agentDir, "SYSTEM.md"), "system two", "utf8");
		await writeFile(contextPath, "context two", "utf8");
		// Another extension rewrote the system-prompt part but left the context part.
		const rewritten = base.replace("system one", "REWRITTEN BY ANOTHER EXTENSION");
		const second = await runTurn(rewritten, { customPrompt: "system one", contextFiles });

		assert.ok(second?.includes("REWRITTEN BY ANOTHER EXTENSION"), "rewritten piece left alone");
		assert.ok(!second?.includes("system two"), "no guessing where the rewritten piece went");
		assert.ok(second?.includes("context two"), "intact pieces still refresh");
	});

	it("never substitutes a previous turn's rendered text when loaded text is absent", async () => {
		const template = "dynamic cwd: {{ CWD }}";
		const base = buildPrompt({ customPrompt: template });
		await runTurn(base, { customPrompt: template, cwd: projectDir });
		const rewritten = base.replace(template, "REWRITTEN BY ANOTHER EXTENSION") +
			`\n\nQuoted output from before: dynamic cwd: ${projectDir}`;

		const second = await runTurn(rewritten, { customPrompt: template, cwd: agentDir });

		assert.equal(second, undefined, "unrelated text matching a prior rendering is left alone");
	});

	it("claims distinct occurrences for watched pieces with identical startup content", async () => {
		const loadedText = "shared text";
		const customPath = join(agentDir, "SYSTEM.md");
		const contextPath = join(projectDir, "AGENTS.md");
		await writeFile(customPath, loadedText, "utf8");
		await writeFile(contextPath, loadedText, "utf8");
		const contextFiles = [{ path: contextPath, content: loadedText }];
		const options = { customPrompt: loadedText, contextFiles };
		const base = buildPrompt(options);

		await runTurn(base, options);
		await writeFile(customPath, "custom update retaining shared text", "utf8");
		await writeFile(contextPath, "context update", "utf8");
		const updated = await runTurn(base, options);

		assert.equal(
			updated,
			buildPrompt({
				customPrompt: "custom update retaining shared text",
				contextFiles: [{ path: contextPath, content: "context update" }],
			}),
		);
	});
});

describe("additional context files", () => {
	it("resolves paths, deduplicates them, preserves global-then-project order, renders variables, and appends one section", async () => {
		const globalPath = join(agentDir, "docs", "global.md");
		const sharedPath = join(projectDir, "shared.md");
		const projectPath = join(projectDir, "docs", "project.md");
		await mkdir(join(agentDir, "docs"), { recursive: true });
		await mkdir(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		await mkdir(join(projectDir, "docs"), { recursive: true });
		await writeFile(globalPath, "global in {{ CWD }}", "utf8");
		await writeFile(sharedPath, "shared", "utf8");
		await writeFile(projectPath, "project", "utf8");
		await writeFile(
			join(agentDir, "dynamic-context.json"),
			JSON.stringify({ files: ["docs/global.md", "docs/../docs/global.md", sharedPath] }),
			"utf8",
		);
		await writeFile(
			join(projectDir, CONFIG_DIR_NAME, "dynamic-context.json"),
			JSON.stringify({ files: [sharedPath, "docs/project.md"] }),
			"utf8",
		);
		const base = buildPrompt();

		const result = await runTurn(base);

		const expectedSection = [
			"<dynamic_context>",
			"",
			"Additional context files:",
			"",
			`<context_file path="${globalPath}">`,
			`global in ${projectDir}`,
			"</context_file>",
			"",
			`<context_file path="${sharedPath}">`,
			"shared",
			"</context_file>",
			"",
			`<context_file path="${projectPath}">`,
			"project",
			"</context_file>",
			"",
			"</dynamic_context>",
		].join("\n");
		assert.equal(result, `${base}\n\n${expectedSection}`);
		assert.equal(notifications.length, 0);
	});

	it("expands ~/ against the home directory and reports an unreadable resolved path", async () => {
		const relativeHomePath = `.pi-dynamic-context-missing-${process.pid}-${Date.now()}.md`;
		const resolvedHomePath = join(homedir(), relativeHomePath);
		await writeFile(
			join(agentDir, "dynamic-context.json"),
			JSON.stringify({ files: [`~/${relativeHomePath}`] }),
			"utf8",
		);

		const first = await runTurn(buildPrompt());
		const second = await runTurn(buildPrompt());

		assert.equal(first, undefined);
		assert.equal(second, undefined);
		assert.equal(notifications.filter((entry) => entry.message.includes(resolvedHomePath)).length, 1);

		const command = stub.commands.get("dynamic-context");
		assert.ok(command);
		notifications = [];
		await command.handler("", stubCtx());
		assert.ok(notifications[0]!.message.includes(`${resolvedHomePath}: unreadable`));
	});

	it("re-reads missing, added, edited, and removed global config entries each turn", async () => {
		const firstPath = join(agentDir, "first.md");
		const secondPath = join(agentDir, "second.md");
		const configPath = join(agentDir, "dynamic-context.json");
		const base = buildPrompt();

		assert.equal(await runTurn(base), undefined, "a missing config is empty");
		await writeFile(firstPath, "first v1", "utf8");
		await writeFile(configPath, JSON.stringify({ files: ["first.md"] }), "utf8");
		const added = await runTurn(base);
		assert.ok(added?.includes("first v1"));

		await writeFile(firstPath, "first v2", "utf8");
		await writeFile(secondPath, "second", "utf8");
		await writeFile(configPath, JSON.stringify({ files: ["first.md", "second.md"] }), "utf8");
		const edited = await runTurn(base);
		assert.ok(edited?.includes("first v2"));
		assert.ok(edited?.includes("second"));
		assert.ok(!edited?.includes("first v1"));

		await unlink(configPath);
		assert.equal(await runTurn(base), undefined, "removing the config removes its section next turn");
		assert.equal(notifications.length, 0, "a missing config never warns");
	});

	it("warns once for malformed JSON, treats it as empty, and picks up a later fix", async () => {
		const contextPath = join(agentDir, "fixed.md");
		const configPath = join(agentDir, "dynamic-context.json");
		await writeFile(configPath, "{", "utf8");
		const base = buildPrompt();

		assert.equal(await runTurn(base), undefined);
		assert.equal(await runTurn(base), undefined);
		assert.equal(warningsMatching(/dynamic-context\.json/), 1);

		await writeFile(contextPath, "fixed", "utf8");
		await writeFile(configPath, JSON.stringify({ files: ["fixed.md"] }), "utf8");
		const fixed = await runTurn(base);
		assert.ok(fixed?.includes("fixed"));
	});

	it("warns once and treats a config with a non-string file entry as empty", async () => {
		await writeFile(join(agentDir, "valid.md"), "must not be partially loaded", "utf8");
		await writeFile(
			join(agentDir, "dynamic-context.json"),
			JSON.stringify({ files: ["valid.md", 42] }),
			"utf8",
		);

		assert.equal(await runTurn(buildPrompt()), undefined);
		assert.equal(await runTurn(buildPrompt()), undefined);
		assert.equal(warningsMatching(/dynamic-context\.json/), 1);
	});

	it("ignores project config while the project is untrusted and honors it once trusted", async () => {
		const projectContextPath = join(projectDir, "project-only.md");
		await mkdir(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
		await writeFile(projectContextPath, "trusted context", "utf8");
		await writeFile(
			join(projectDir, CONFIG_DIR_NAME, "dynamic-context.json"),
			JSON.stringify({ files: ["project-only.md"] }),
			"utf8",
		);
		const base = buildPrompt();

		assert.equal(await runTurn(base, { projectTrusted: false }), undefined);
		assert.equal(notifications.length, 0);
		const trusted = await runTurn(base, { projectTrusted: true });
		assert.ok(trusted?.includes("trusted context"));
		assert.equal(await runTurn(base, { projectTrusted: false }), undefined);
	});

	it("warns once and omits an unreadable file each turn, then includes it when readable", async () => {
		const readablePath = join(agentDir, "readable.md");
		const missingPath = join(agentDir, "missing.md");
		await writeFile(readablePath, "readable", "utf8");
		await writeFile(
			join(agentDir, "dynamic-context.json"),
			JSON.stringify({ files: ["readable.md", "missing.md"] }),
			"utf8",
		);
		const base = buildPrompt();

		const first = await runTurn(base);
		const second = await runTurn(base);
		assert.ok(first?.includes(`path="${readablePath}"`));
		assert.ok(!first?.includes(`path="${missingPath}"`));
		assert.ok(!second?.includes(`path="${missingPath}"`));
		assert.equal(notifications.filter((entry) => entry.message.includes(missingPath)).length, 1);

		const command = stub.commands.get("dynamic-context");
		assert.ok(command);
		notifications = [];
		await command.handler("", stubCtx());
		assert.ok(notifications[0]!.message.includes(`${readablePath}: ok`));
		assert.ok(notifications[0]!.message.includes(`${missingPath}: unreadable`));

		await writeFile(missingPath, "now readable", "utf8");
		const recovered = await runTurn(base);
		assert.ok(recovered?.includes(`path="${missingPath}"`));
		assert.ok(recovered?.includes("now readable"));
	});
});

describe("session lifecycle", () => {
	it("resets per-session state on session_start", async () => {
		const template = "hi {{NOPE}}";
		await writeFile(join(agentDir, "SYSTEM.md"), template, "utf8");
		const base = buildPrompt({ customPrompt: template });

		await runTurn(base, { customPrompt: template });
		await runTurn(base, { customPrompt: template });
		assert.equal(warningsMatching(/NOPE/), 1);

		const sessionStart = stub.handlers.get("session_start");
		assert.ok(sessionStart, "session_start handler must be registered");
		await sessionStart({ type: "session_start" }, stubCtx());

		await runTurn(base, { customPrompt: template });
		assert.equal(warningsMatching(/NOPE/), 2, "warn-once state is per session");
	});
});

describe("/dynamic-context command", () => {
	it("initializes and reads current additional-file status before the first turn", async () => {
		const additionalPath = join(agentDir, "before-turn.md");
		await writeFile(additionalPath, "available", "utf8");
		await writeFile(
			join(agentDir, "dynamic-context.json"),
			JSON.stringify({ files: ["before-turn.md"] }),
			"utf8",
		);
		const command = stub.commands.get("dynamic-context");
		assert.ok(command);

		await command.handler("", stubCtx(true, { cwd: projectDir }));

		assert.equal(notifications.length, 1);
		assert.ok(notifications[0]!.message.includes(`{{CWD}}: ${projectDir}`));
		assert.ok(notifications[0]!.message.includes(`${additionalPath}: ok`));
	});

	it("reports variable values, startup-loaded files, and additional files with their last-read result", async () => {
		const template = "sys {{CWD}}";
		await writeFile(join(agentDir, "SYSTEM.md"), template, "utf8");
		const contextPath = join(projectDir, "AGENTS.md");
		const additionalPath = join(agentDir, "additional.md");
		const currentAdditionalPath = join(agentDir, "current-additional.md");
		await writeFile(contextPath, "context body", "utf8");
		await writeFile(additionalPath, "additional body", "utf8");
		await writeFile(
			join(agentDir, "dynamic-context.json"),
			JSON.stringify({ files: ["additional.md"] }),
			"utf8",
		);
		const contextFiles = [{ path: contextPath, content: "context body" }];
		const base = buildPrompt({ customPrompt: template, contextFiles });

		await runTurn(base, { customPrompt: template, contextFiles });
		await writeFile(currentAdditionalPath, "current additional body", "utf8");
		await writeFile(
			join(agentDir, "dynamic-context.json"),
			JSON.stringify({ files: ["current-additional.md"] }),
			"utf8",
		);

		const command = stub.commands.get("dynamic-context");
		assert.ok(command, "/dynamic-context command must be registered");

		notifications = [];
		await command.handler("", stubCtx());
		assert.equal(notifications.length, 1);
		const status = notifications[0]!.message;

		for (const name of ["DATE", "TIME", "TZ", "CWD"]) {
			assert.ok(status.includes(`{{${name}}}`), `status mentions {{${name}}}`);
		}
		assert.ok(!status.includes("{{AGENT_DIR}}"), "removed variables are not reported");
		assert.ok(status.includes(projectDir), "status shows the CWD value");
		assert.ok(status.includes(join(agentDir, "SYSTEM.md")), "status lists the watched SYSTEM.md");
		assert.ok(status.includes(contextPath), "status lists the watched context file");
		assert.ok(status.includes(currentAdditionalPath), "status re-reads the configured additional files");
		assert.ok(!status.includes(additionalPath), "status does not report stale additional-file state");
		assert.match(status, /ok/i, "status reports the last-read result");

		await unlink(contextPath);
		await runTurn(base, { customPrompt: template, contextFiles });

		notifications = [];
		await command.handler("", stubCtx());
		assert.match(notifications[0]!.message, /unreadable/i, "status reports an unreadable file");
	});
});
