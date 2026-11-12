// integration.test.ts — two disposable pi sessions, and one change at a time.
//
// These tests drive the real thing: a real pi process, opened over pi's own RPC
// control channel, on a session file in a temporary directory. No provider is
// called (a parameter change is not a completion), no lane is touched, and the
// sessions are disposed with the temporary directory.
//
// The question these tests answer is the one that matters: **does a change aimed at
// one session change anything else?**

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRpcSession, type RpcChild, type RpcSession } from "./rpc.ts";
import { readSessionHeaderId } from "./session-file.ts";
import { applySessionModel, applySessionThinking, type ParameterRuntime } from "./target.ts";

/** A disposable session: a header, a model, a level, and one message so pi persists it. */
function writeDisposableSession(dir: string, name: string, id: string): string {
	const path = join(dir, name);
	const lines = [
		{ type: "session", version: 3, id, timestamp: "2026-11-12T00:00:00.000Z", cwd: dir },
		{
			type: "model_change",
			id: "m0000001",
			parentId: null,
			timestamp: "2026-11-12T00:00:00.000Z",
			provider: "test-provider",
			modelId: "test-model",
		},
		{
			type: "thinking_level_change",
			id: "t0000001",
			parentId: "m0000001",
			timestamp: "2026-11-12T00:00:00.000Z",
			thinkingLevel: "off",
		},
		{
			type: "message",
			id: "msg00001",
			parentId: "t0000001",
			timestamp: "2026-11-12T00:00:00.000Z",
			message: { role: "user", content: "disposable", timestamp: 1762896000000 },
		},
	];
	writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return path;
}

/** pi, in RPC mode, with extension discovery off: a disposable child touches nothing. */
const spawnPi = (command: string, args: string[], options: { stdio: ["pipe", "pipe", "pipe"] }) =>
	spawn(command, [...args, "--no-extensions"], { stdio: options.stdio }) as unknown as RpcChild;

let workdir = "";
let sessionA = "";
let sessionB = "";
let idA = "";
let idB = "";
let channelA: RpcSession | null = null;

/** Read a session's own answer about itself, over pi's control channel. */
async function askSession(sessionPath: string): Promise<Record<string, unknown>> {
	const session = await openRpcSession({ spawn: spawnPi, sessionPath, timeoutMs: 30_000 });
	try {
		const state = await session.getState();
		expect(state.ok).toBe(true);
		return (state.data ?? {}) as Record<string, unknown>;
	} finally {
		await session.close();
	}
}

beforeAll(() => {
	workdir = mkdtempSync(join(tmpdir(), "ft55-sessions-"));
	idA = "aaaaaaaa-0000-4000-8000-00000000000a";
	idB = "bbbbbbbb-0000-4000-8000-00000000000b";
	sessionA = writeDisposableSession(workdir, "a.jsonl", idA);
	sessionB = writeDisposableSession(workdir, "b.jsonl", idB);
});

afterAll(async () => {
	if (channelA) await channelA.close();
	if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe("a change aimed at one session", () => {
	test("changes that session and leaves the other one alone", async () => {
		const beforeA = readFileSync(sessionA, "utf8");
		const beforeB = readFileSync(sessionB, "utf8");

		// The runtime's own session IS the disposable pi A: the tool changes the
		// session of the process that owns it.
		channelA = await openRpcSession({ spawn: spawnPi, sessionPath: sessionA, timeoutMs: 30_000 });
		const runtime = await liveRuntime(channelA, { id: idA, path: sessionA });

		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: idA, sessionPath: sessionA },
			"high",
		);

		expect(result.ok).toBe(true);
		expect(result.changed).toBe(true);
		expect(result.applied).toBe("thinking");
		expect(result.thinking.before).toBe("off");
		expect(result.thinking.after).toBe("high");

		// the target's own session now says so, in the process that owns it
		const targetState = await askSession(sessionA);
		expect(targetState.thinkingLevel).toBe("high");

		// and the other session did not move
		const otherState = await askSession(sessionB);
		expect(otherState.thinkingLevel).toBe("off");
		expect(readFileSync(sessionA, "utf8")).not.toBe(beforeA);
		expect(readFileSync(sessionB, "utf8")).toBe(beforeB);
	});

	test("a change aimed at another session is refused, and that session is not touched", async () => {
		const beforeA = readFileSync(sessionA, "utf8");
		const beforeB = readFileSync(sessionB, "utf8");
		const levelBefore = (await askSession(sessionA)).thinkingLevel;

		const channel = await openRpcSession({ spawn: spawnPi, sessionPath: sessionA, timeoutMs: 30_000 });
		try {
			const runtime = await liveRuntime(channel, { id: idA, path: sessionA });
			const result = await applySessionThinking(
				runtime,
				"set_session_thinking",
				{ sessionId: idB, sessionPath: sessionB },
				"high",
			);
			expect(result.ok).toBe(false);
			expect(result.refusal?.code).toBe("target_not_reachable");
			expect(result.refusal?.detail?.capability).toBe("cross_process_session_control");
			expect(result.changed).toBe(false);
		} finally {
			await channel.close();
		}

		// neither session moved
		const stateA = await askSession(sessionA);
		const stateB = await askSession(sessionB);
		expect(stateA.thinkingLevel).toBe(levelBefore);
		expect(stateB.thinkingLevel).toBe("off");
		expect(readFileSync(sessionA, "utf8")).toBe(beforeA);
		expect(readFileSync(sessionB, "utf8")).toBe(beforeB);
	});
});

describe("a model change aimed at one session", () => {
	test("changes that session's model and leaves the other one alone", async () => {
		const beforeA = readFileSync(sessionA, "utf8");
		const beforeB = readFileSync(sessionB, "utf8");

		const channel = await openRpcSession({ spawn: spawnPi, sessionPath: sessionA, timeoutMs: 30_000 });
		let candidate: { provider: string; id: string } | null = null;
		try {
			const state = await channel.getState();
			const current = (state.data as { model?: { provider?: string; id?: string } } | undefined)?.model;
			const available = await channel.getAvailableModels();
			const models = ((available.data as { models?: { provider: string; id: string }[] } | undefined)?.models ??
				[]) as { provider: string; id: string }[];
			candidate = models.find((m) => m.provider === current?.provider && m.id !== current?.id) ?? null;
		} finally {
			await channel.close();
		}
		if (!candidate) {
			console.warn("ft55: no second model available for the disposable session; model change not exercised");
			return;
		}

		const channel2 = await openRpcSession({ spawn: spawnPi, sessionPath: sessionA, timeoutMs: 30_000 });
		try {
			const runtime = await liveRuntime(channel2, { id: idA, path: sessionA });
			const result = await applySessionModel(
				runtime,
				"set_session_model",
				{ sessionId: idA, sessionPath: sessionA },
				candidate.provider,
				candidate.id,
			);
			expect(result.ok).toBe(true);
			expect(result.changed).toBe(true);
			expect(result.model.after?.modelId).toBe(candidate.id);
		} finally {
			await channel2.close();
		}

		const targetState = await askSession(sessionA);
		expect((targetState.model as { id?: string } | undefined)?.id).toBe(candidate.id);
		const otherState = await askSession(sessionB);
		expect((otherState.model as { id?: string } | undefined)?.id).not.toBe(candidate.id);
		expect(readFileSync(sessionA, "utf8")).not.toBe(beforeA);
		expect(readFileSync(sessionB, "utf8")).toBe(beforeB);
	});
});

/** A runtime whose own session is a real disposable pi, driven over its own channel. */
async function liveRuntime(channel: RpcSession, own: { id: string; path: string }): Promise<ParameterRuntime> {
	return {
		own: { sessionId: own.id, sessionPath: own.path, model: null, thinkingLevel: null },
		getModel: async () => {
			const state = await channel.getState();
			const model = (state.data as { model?: { provider?: string; id?: string } } | undefined)?.model;
			return model?.provider && model?.id ? { provider: model.provider, modelId: model.id } : null;
		},
		getThinkingLevel: async () => {
			const state = await channel.getState();
			const level = (state.data as { thinkingLevel?: string } | undefined)?.thinkingLevel;
			return level ?? null;
		},
		supportedThinkingLevels: () => ["off", "low", "medium", "high"],
		resolveModel: async (ref: { provider: string; modelId: string }) => {
			const available = await channel.getAvailableModels();
			const models = ((available.data as { models?: { provider: string; id: string }[] } | undefined)?.models ??
				[]) as { provider: string; id: string }[];
			const found = models.find((m) => m.provider === ref.provider && m.id === ref.modelId);
			return found ? { provider: found.provider, modelId: found.id } : null;
		},
		setOwnModel: async (ref: { provider: string; modelId: string }) => {
			const outcome = await channel.setModel(ref.provider, ref.modelId);
			return outcome.ok;
		},
		setOwnThinkingLevel: async (level: string) => {
			await channel.setThinkingLevel(level);
		},
		ownRecords: () => ({ modelChangeEntryId: null, thinkingLevelEntryId: null }),
		resolveLane: async () => ({
			ok: false,
			failure: { code: "herdr_absent", message: "herdr is not available in this environment" },
		}),
		readSessionHeaderId: async (path: string) => readSessionHeaderId(path),
	} as unknown as ParameterRuntime;
}
