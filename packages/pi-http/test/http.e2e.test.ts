import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import createHttpExtension from "../index.ts";

describe("http extension registration", () => {
	it("registers a TypeBox schema that accepts valid arguments and rejects invalid arguments", async () => {
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			extensionFactories: [{ name: "pi-http", factory: createHttpExtension }],
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
			tools: ["http"],
		});

		try {
			assert.deepEqual(extensionsResult.errors, []);
			assert.deepEqual(session.getAllTools().map((tool) => tool.name), ["http"]);
			const schema = session.getToolDefinition("http")?.parameters;
			assert.ok(schema);
			assert.equal(Object.getOwnPropertyDescriptor(schema, "~kind")?.value, "Object");

			for (const value of [
				{ url: "https://example.test" },
				{ url: "http://example.test", method: "POST", headers: { accept: "application/json" }, body: { ok: true }, timeoutSeconds: 0.2 },
				{ url: "https://example.test", method: "PUT", body: "raw" },
			]) assert.equal(Value.Check(schema, value), true, `should accept ${JSON.stringify(value)}`);

			for (const value of [
				{},
				{ method: "GET" },
				{ url: "https://example.test", method: "TRACE" },
				{ url: "https://example.test", timeoutSeconds: 0 },
				{ url: "https://example.test", timeoutSeconds: -1 },
			]) assert.equal(Value.Check(schema, value), false, `should reject ${JSON.stringify(value)}`);
		} finally {
			session.dispose();
		}
	});
});
