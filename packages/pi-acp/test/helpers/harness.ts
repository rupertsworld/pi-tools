/**
 * Fake ExtensionAPI/ExtensionContext harness for driving the pi-acp extension
 * in tests without a real pi runtime. Ports the spirit of pino's fake-session
 * helper onto pi's extension surface: captured `pi.on` handlers with an `emit`
 * to fire them, recorded `sendUserMessage` calls, a toggleable `isIdle`, an
 * abort counter, and captured command registrations.
 */

import assert from "node:assert/strict";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import createAcpExtension from "../../index.ts";

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

export interface Notification {
	message: string;
	type?: string;
}

export interface SendUserMessageCall {
	content: unknown;
	options: unknown;
}

export interface Harness {
	pi: ExtensionAPI;
	/** All notifications delivered through ctx.ui.notify, in order. */
	readonly notifications: Notification[];
	/** All pi.sendUserMessage calls, in order. */
	readonly sendUserMessageCalls: SendUserMessageCall[];
	/** Toggle to drive the busy (mid-turn) path; ctx.isIdle() returns this. */
	idle: boolean;
	/** Number of times ctx.abort() was called. */
	readonly abortCount: number;
	/** Session id returned by ctx.sessionManager.getSessionId(). */
	sessionId: string;
	/** Make the next pi.sendUserMessage call throw (records the call first). */
	failNextSendUserMessage(error: Error): void;
	/** Fire every registered handler for an event type with the fake ctx. */
	emit(event: { type: string } & Record<string, unknown>): Promise<void>;
	/** Fire session_start (reason startup). */
	sessionStart(): Promise<void>;
	/** Fire session_shutdown. */
	shutdown(): Promise<void>;
	/** Invoke the /acp command handler; returns notifications produced by the call. */
	runCommand(args: string): Promise<Notification[]>;
}

export function createHarness(options: { sessionId?: string } = {}): Harness {
	const handlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const notifications: Notification[] = [];
	const sendUserMessageCalls: SendUserMessageCall[] = [];
	let abortCount = 0;
	let nextSendUserMessageError: Error | undefined;

	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/",
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
		},
		isIdle: () => harness.idle,
		abort: () => {
			abortCount += 1;
		},
		hasPendingMessages: () => false,
		signal: undefined,
		sessionManager: {
			getSessionId: () => harness.sessionId,
		},
	};

	const pi = {
		on(event: string, handler: EventHandler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, opts: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, opts);
		},
		sendUserMessage(content: unknown, opts?: unknown) {
			sendUserMessageCalls.push({ content, options: opts });
			if (nextSendUserMessageError) {
				const error = nextSendUserMessageError;
				nextSendUserMessageError = undefined;
				throw error;
			}
		},
	} as unknown as ExtensionAPI;

	const harness: Harness = {
		pi,
		notifications,
		sendUserMessageCalls,
		idle: true,
		sessionId: options.sessionId ?? "fake-session-id",
		get abortCount() {
			return abortCount;
		},
		failNextSendUserMessage(error: Error) {
			nextSendUserMessageError = error;
		},
		async emit(event) {
			for (const handler of handlers.get(event.type) ?? []) {
				await handler(event, ctx);
			}
		},
		async sessionStart() {
			await harness.emit({ type: "session_start", reason: "startup" });
		},
		async shutdown() {
			await harness.emit({ type: "session_shutdown", reason: "quit" });
		},
		async runCommand(args) {
			const command = commands.get("acp");
			assert.ok(command, "acp command not registered");
			const before = notifications.length;
			await command.handler(args, ctx);
			return notifications.slice(before);
		},
	};

	createAcpExtension(pi);
	return harness;
}

/** Poll until a predicate holds or time out. */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
