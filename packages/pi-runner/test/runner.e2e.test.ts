import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
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
			tools: ["schedule", "cancel", "list"],
		});

		try {
			assert.deepEqual(extensionsResult.errors, []);
			assert.equal(extensionsResult.extensions.length, 1);
			assert.deepEqual(
				session.getAllTools().map((tool) => tool.name),
				["schedule", "cancel", "list"],
			);

			const cases = {
				schedule: {
					valid: [
						{ message: "Morning review", trigger: { kind: "cron", cron: "0 0 9 * * 1-5" } },
						{
							message: "Morning review",
							trigger: { kind: "cron", cron: "0 0 9 * * 1-5", timeZone: "Australia/Sydney" },
						},
						{ message: "Check the oven", trigger: { kind: "once", at: "+10m" } },
					],
					invalid: [
						{},
						{ message: "Missing trigger" },
						{ message: "Wrong trigger", trigger: { kind: "cron", at: "+10m" } },
						{ message: "Wrong trigger", trigger: { kind: "once", cron: "0 * * * * *" } },
					],
				},
				cancel: {
					valid: [{ jobId: "job-123" }],
					invalid: [{}, { jobId: 123 }],
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
		} finally {
			session.dispose();
		}
	});
});
