// Live smoke test for pi-dynamic-context: proves a mid-session AGENTS.md edit
// is picked up on the very next turn, through a REAL pi (RPC mode) and a REAL
// model call. Not part of `npm test` — it needs provider auth and spends a few
// model tokens. Run manually after pi upgrades:
//
//   node scripts/smoke-dynamic-context.mjs
//
// It builds a throwaway agent dir (copying auth/models from ~/.pi/agent — your
// real agent dir is never touched), asks for a codeword defined in AGENTS.md,
// rewrites the file, asks again, and expects the new value.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const realAgentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const T = fs.mkdtempSync(path.join(os.tmpdir(), "dynctx-smoke-"));

for (const f of ["auth.json", "models.json", "models-store.json"]) {
	const src = path.join(realAgentDir, f);
	if (fs.existsSync(src)) fs.copyFileSync(src, path.join(T, f));
}
const settings = JSON.parse(fs.readFileSync(path.join(realAgentDir, "settings.json"), "utf8"));
fs.writeFileSync(
	path.join(T, "settings.json"),
	JSON.stringify({ defaultProvider: settings.defaultProvider, defaultModel: settings.defaultModel }, null, "\t"),
);
fs.writeFileSync(path.join(T, "AGENTS.md"), "The current secret codeword is: BANANA");

const extensionPath = path.join(import.meta.dirname, "..", "packages", "pi-dynamic-context");
const child = spawn("pi", ["--mode", "rpc", "--no-skills", "-e", extensionPath], {
	env: { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: T },
	stdio: ["pipe", "pipe", "pipe"],
});

const QUESTION = "What is the current secret codeword per your context? Reply with just the codeword.";
let buf = "";
let lastText = "";
let step = 0;
const results = [];

function send(msg) {
	child.stdin.write(`${JSON.stringify(msg)}\n`);
}

function finish(code, message) {
	console.log(message);
	child.kill();
	fs.rmSync(T, { recursive: true, force: true });
	process.exit(code);
}

const deadline = setTimeout(() => finish(1, "SMOKE FAIL: timed out after 150s"), 150_000);
deadline.unref?.();

child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		let ev;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		if (ev.type === "message_end" && ev.message?.role === "assistant") {
			lastText = (ev.message.content ?? [])
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		if (ev.type === "agent_settled") {
			results.push(lastText.trim());
			if (step === 0) {
				step = 1;
				fs.writeFileSync(path.join(T, "AGENTS.md"), "The current secret codeword is: PINEAPPLE");
				send({ type: "prompt", message: QUESTION });
			} else {
				console.log("TURN1 (before edit):", results[0]);
				console.log("TURN2 (after edit): ", results[1]);
				const pass = results[0].includes("BANANA") && results[1].includes("PINEAPPLE");
				finish(pass ? 0 : 1, pass ? "SMOKE PASS: mid-session AGENTS.md edit picked up" : "SMOKE FAIL");
			}
		}
	}
});
child.stderr.on("data", (d) => {
	const s = String(d).trim();
	if (s) console.error("pi stderr:", s.slice(0, 200));
});
child.on("exit", (code, signal) => {
	if (step < 2) finish(1, `SMOKE FAIL: pi exited early (${code ?? signal})`);
});

send({ type: "prompt", message: QUESTION });
