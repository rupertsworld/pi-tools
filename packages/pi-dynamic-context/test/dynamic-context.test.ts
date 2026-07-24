import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

function stubCtx(): { hasUI: boolean; ui: { notify: (message: string, type?: string) => void } } {
	return {
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
		},
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
		systemPromptOptions: {
			cwd: options.cwd ?? projectDir,
			customPrompt: options.customPrompt,
			appendSystemPrompt: options.appendSystemPrompt,
			contextFiles: options.contextFiles,
		},
	};
	const result = (await handler(event, stubCtx())) as { systemPrompt?: string } | undefined;
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
		const template = "date={{DATE}}\ntime={{TIME}}\ntz={{TZ}}\nagent={{AGENT_DIR}}\ncwd={{CWD}}";
		const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const otherTimeZone = hostTimeZone === "Australia/Sydney" ? "America/Los_Angeles" : "Australia/Sydney";
		await writeFile(join(agentDir, "dynamic-context.json"), JSON.stringify({ timeZone: otherTimeZone }), "utf8");
		await writeFile(join(agentDir, "SYSTEM.md"), template, "utf8");

		const result = await runTurn(buildPrompt({ customPrompt: template }), { customPrompt: template });

		assert.ok(result, "prompt must be modified");
		assert.match(result, /date=\d{4}-\d{2}-\d{2}\n/);
		assert.match(result, /time=\d{2}:\d{2}:\d{2}\n/);
		assert.match(result, /tz=(?:[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+|UTC[+-]\d{2}:\d{2})\n/);
		if (hostTimeZone) assert.ok(result.includes(`tz=${hostTimeZone}`));
		assert.ok(!result.includes(`tz=${otherTimeZone}`), "legacy config does not override the host time zone");
		assert.ok(result.includes(`agent=${agentDir}`));
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

	it("warns once per session for an unknown variable and leaves it verbatim", async () => {
		const template = "hello {{BOGUS_VAR}} in {{CWD}}";
		await writeFile(join(agentDir, "SYSTEM.md"), template, "utf8");
		const base = buildPrompt({ customPrompt: template });

		const first = await runTurn(base, { customPrompt: template });
		const second = await runTurn(base, { customPrompt: template });

		assert.ok(first?.includes("{{BOGUS_VAR}}"), "unknown token left verbatim");
		assert.ok(first?.includes(`in ${projectDir}`), "known variables still render");
		assert.ok(second?.includes("{{BOGUS_VAR}}"));
		assert.equal(warningsMatching(/BOGUS_VAR/), 1);
	});

	it("never renders variables inside context files", async () => {
		const contextPath = join(projectDir, "AGENTS.md");
		await writeFile(contextPath, "ctx v1 {{CWD}}", "utf8");
		const contextFiles = [{ path: contextPath, content: "ctx v1 {{CWD}}" }];
		const base = buildPrompt({ contextFiles });

		await runTurn(base, { contextFiles });
		await writeFile(contextPath, "ctx v2 {{CWD}}", "utf8");
		const second = await runTurn(base, { contextFiles });

		assert.ok(second?.includes("ctx v2 {{CWD}}"), "context content refreshed but token left verbatim");
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
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "SYSTEM.md"), "project prompt v1", "utf8");
		await writeFile(join(agentDir, "SYSTEM.md"), "unrelated global prompt", "utf8");
		const base = buildPrompt({ customPrompt: "project prompt v1" });

		await runTurn(base, { customPrompt: "project prompt v1" });
		await writeFile(join(projectDir, ".pi", "SYSTEM.md"), "project prompt v2", "utf8");
		const second = await runTurn(base, { customPrompt: "project prompt v1" });

		assert.ok(second?.includes("project prompt v2"));
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

	it("does nothing when pi loaded no custom prompt and no context files", async () => {
		const base = "You are pi, a coding agent. Today is {{DATE}}.\n\n<tools>\nread\n</tools>";

		const result = await runTurn(base, {});

		assert.equal(result, undefined);
		assert.ok(base.includes("{{DATE}}"), "default-prompt tokens are never rendered");
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
	it("reports variable values and watched files with their last-read result", async () => {
		const template = "sys {{CWD}}";
		await writeFile(join(agentDir, "SYSTEM.md"), template, "utf8");
		const contextPath = join(projectDir, "AGENTS.md");
		await writeFile(contextPath, "context body", "utf8");
		const contextFiles = [{ path: contextPath, content: "context body" }];
		const base = buildPrompt({ customPrompt: template, contextFiles });

		await runTurn(base, { customPrompt: template, contextFiles });

		const command = stub.commands.get("dynamic-context");
		assert.ok(command, "/dynamic-context command must be registered");

		notifications = [];
		await command.handler("", stubCtx());
		assert.equal(notifications.length, 1);
		const status = notifications[0]!.message;

		for (const name of ["DATE", "TIME", "TZ", "AGENT_DIR", "CWD"]) {
			assert.ok(status.includes(`{{${name}}}`), `status mentions {{${name}}}`);
		}
		assert.ok(status.includes(projectDir), "status shows the CWD value");
		assert.ok(status.includes(join(agentDir, "SYSTEM.md")), "status lists the watched SYSTEM.md");
		assert.ok(status.includes(contextPath), "status lists the watched context file");
		assert.match(status, /ok/i, "status reports the last-read result");

		await unlink(contextPath);
		await runTurn(base, { customPrompt: template, contextFiles });

		notifications = [];
		await command.handler("", stubCtx());
		assert.match(notifications[0]!.message, /unreadable/i, "status reports an unreadable file");
	});
});
