import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";

import createDynamicContextExtension from "../index.ts";

describe("dynamic-context extension registration", () => {
	it("loads through a real pi session with no errors and registers its command", async () => {
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			extensionFactories: [{ name: "pi-dynamic-context", factory: createDynamicContextExtension }],
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
		});

		try {
			assert.deepEqual(extensionsResult.errors, []);
			assert.equal(extensionsResult.extensions.length, 1);
			const commands = [...extensionsResult.extensions[0]!.commands.keys()];
			assert.ok(commands.includes("dynamic-context"), `expected /dynamic-context command, got: ${commands.join(", ")}`);
		} finally {
			session.dispose();
		}
	});
});
