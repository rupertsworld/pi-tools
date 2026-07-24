import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { validateToolCall } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

import createRunnerExtension from "../index.ts";

describe("runner extension registration", () => {
	it("registers TypeBox schemas that accept valid arguments and reject invalid arguments", async () => {
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			extensionFactories: [{ name: "pi-runner", factory: createRunnerExtension }],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});

		await loader.reload();

		const { session, extensionsResult } = await createAgentSession({
			cwd: process.cwd(),
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(),
			tools: ["prompt", "process", "subagent", "cancel", "steer", "peek", "list"],
		});

		try {
			assert.deepEqual(extensionsResult.errors, []);
			assert.equal(extensionsResult.extensions.length, 1);
			assert.deepEqual(
				session.getAllTools().map((tool) => tool.name),
				["prompt", "process", "subagent", "cancel", "steer", "peek", "list"],
			);

			const cases = {
				prompt: {
					valid: [
						{
							message: "Morning review",
							trigger: { kind: "cron", cron: "0 0 9 * * 1-5" },
						},
						{
							message: "Check the oven",
							trigger: { kind: "once", at: "+10m" },
							deliverAs: "followUp",
						},
					],
					invalid: [
						{},
						{ message: "Missing trigger" },
						{ trigger: { kind: "once", at: "+10m" } },
						{
							trigger: { kind: "once", at: "+10m" },
							message: "No",
							deliverAs: "later",
						},
						{ message: "Wrong trigger", trigger: { kind: "cron", at: "+10m" } },
						{ message: "Wrong trigger", trigger: { kind: "once", cron: "0 * * * * *" } },
						{ message: "Wrong trigger", trigger: { kind: "later" } },
					],
				},
				process: {
					valid: [
						{ command: "date" },
						{
							command: "printf hello",
							cwd: "/tmp",
							trigger: { kind: "cron", cron: "0 0 9 * * 1-5", timeZone: "Australia/Sydney" },
							deliverAs: "nextTurn",
						},
					],
					invalid: [
						{},
						{ trigger: { kind: "now" } },
						{ command: "date", deliverAs: "later" },
					],
				},
				subagent: {
					valid: [
						{ prompt: "Review this" },
						{
							prompt: "Review this",
							model: "provider/model",
							cwd: "/tmp",
							appendSystemPrompt: "Be concise",
							maxMinutes: 0.5,
							trigger: { kind: "now" },
						},
					],
					invalid: [
						{},
						{ trigger: { kind: "now" } },
						{ prompt: "No", maxMinutes: 0 },
						{ prompt: "No", maxMinutes: -1 },
					],
				},
				cancel: {
					valid: [{ jobId: "job-123" }],
					invalid: [{}, { jobId: 123 }],
				},
				steer: {
					valid: [{ jobId: "job-123", message: "Change course" }],
					invalid: [{}, { jobId: "job-123" }, { jobId: 123, message: "No" }],
				},
				peek: {
					valid: [{ jobId: "job-123" }, { jobId: "job-123", lines: 1 }, { jobId: "job-123", lines: 50 }],
					invalid: [{}, { jobId: 123 }, { jobId: "../secret" }, { jobId: "..\\secret" }, { jobId: "job-123", lines: 0 }, { jobId: "job-123", lines: -1 }, { jobId: "job-123", lines: 1.5 }],
				},
				list: {
					valid: [{}],
					invalid: [],
				},
			} as const;

			for (const [name, values] of Object.entries(cases)) {
				const schema = session.getToolDefinition(name)?.parameters;
				assert.ok(schema, `${name} should have a registered parameter schema`);
				assert.equal(
					Object.getOwnPropertyDescriptor(schema, "~kind")?.value,
					"Object",
					`${name} should use a TypeBox-built object schema`,
				);
				for (const value of values.valid)
					assert.equal(Value.Check(schema, value), true, `${name} should accept ${JSON.stringify(value)}`);
				for (const value of values.invalid)
					assert.equal(Value.Check(schema, value), false, `${name} should reject ${JSON.stringify(value)}`);
			}

			assert.throws(
				() => validateToolCall(session.state.tools, {
					type: "toolCall",
					id: "missing-trigger",
					name: "prompt",
					arguments: { message: "This must not execute" },
				}),
				/Validation failed for tool "prompt"[\s\S]*trigger/i,
			);
		} finally {
			session.dispose();
		}
	});
});
