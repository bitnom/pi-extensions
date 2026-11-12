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
import { openRpcSession, type RpcChild } from "./rpc.ts";
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

const runtime: ParameterRuntime = {
	own: { sessionId: "caller-session", sessionPath: null, model: null, thinkingLevel: null },
	getModel: () => null,
	getThinkingLevel: () => null,
	supportedThinkingLevels: () => ["off", "low", "medium", "high"],
	resolveModel: () => null,
	setOwnModel: async () => false,
	setOwnThinkingLevel: () => {},
	ownRecords: () => ({ modelChangeEntryId: null, thinkingLevelEntryId: null }),
	openRemoteSession: (sessionPath) => openRpcSession({ spawn: spawnPi, sessionPath, timeoutMs: 30_000 }),
	resolveLane: async () => ({
		ok: false,
		failure: { code: "herdr_absent", message: "herdr is not available in this environment" },
	}),
};

/** Read a session's own answer about itself, over the same channel the tool uses. */
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

afterAll(() => {
	if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe("a change aimed at one session", () => {
	test(
		"changes that session and leaves the other one alone",
		async () => {
			const beforeA = readFileSync(sessionA, "utf8");
			const beforeB = readFileSync(sessionB, "utf8");

			const result = await applySessionThinking(
				runtime,
				"set_session_thinking",
				{ sessionId: idB, sessionPath: sessionB },
				"high",
			);

			expect(result.ok).toBe(true);
			expect(result.changed).toBe(true);
			expect(result.applied).toBe("thinking");
			expect(result.thinking.before).toBe("off");
			expect(result.thinking.after).toBe("high");
			expect(result.target.sessionId).toBe(idB);
			expect(result.target.sessionPath).toBe(sessionB);

			// the target's own session now says so
			const targetState = await askSession(sessionB);
			expect(targetState.thinkingLevel).toBe("high");

			// and the other session did not move
			const otherState = await askSession(sessionA);
			expect(otherState.thinkingLevel).toBe("off");
			expect(readFileSync(sessionA, "utf8")).toBe(beforeA);
			// the target's file carries the change
			expect(readFileSync(sessionB, "utf8")).not.toBe(beforeB);
			expect(readFileSync(sessionB, "utf8")).toContain('"thinkingLevel":"high"');
		},
		{ timeout: 60_000 },
	);

	test(
		"and the other way round",
		async () => {
			const beforeA = readFileSync(sessionA, "utf8");
			const beforeB = readFileSync(sessionB, "utf8");
			const otherBefore = (await askSession(sessionB)).thinkingLevel;

			const result = await applySessionThinking(
				runtime,
				"set_session_thinking",
				{ sessionId: idA, sessionPath: sessionA },
				"low",
			);

			expect(result.ok).toBe(true);
			expect(result.changed).toBe(true);
			expect(result.thinking.after).toBe("low");

			const targetState = await askSession(sessionA);
			expect(targetState.thinkingLevel).toBe("low");
			const otherState = await askSession(sessionB);
			expect(otherState.thinkingLevel).toBe(otherBefore);
			expect(readFileSync(sessionB, "utf8")).toBe(beforeB);
			expect(readFileSync(sessionA, "utf8")).not.toBe(beforeA);
		},
		{ timeout: 60_000 },
	);

	test(
		"a target that answers with another session is refused, and nothing changes",
		async () => {
			const beforeA = readFileSync(sessionA, "utf8");
			const beforeB = readFileSync(sessionB, "utf8");
			const result = await applySessionThinking(
				runtime,
				"set_session_thinking",
				{ sessionId: idA, sessionPath: sessionB },
				"high",
			);
			expect(result.ok).toBe(false);
			expect(result.refusal?.code).toBe("session_id_mismatch");
			expect(readFileSync(sessionA, "utf8")).toBe(beforeA);
			expect(readFileSync(sessionB, "utf8")).toBe(beforeB);
		},
		{ timeout: 60_000 },
	);
});

describe("a model change aimed at one session", () => {
	test(
		"changes that session's model and leaves the other one alone",
		async () => {
			const beforeA = readFileSync(sessionA, "utf8");
			const beforeB = readFileSync(sessionB, "utf8");

			// The model is the target's own: the target's registry decides what it knows.
			const probe = await openRpcSession({ spawn: spawnPi, sessionPath: sessionB, timeoutMs: 30_000 });
			let candidate: { provider: string; id: string } | null = null;
			try {
				const state = await probe.getState();
				const current = (state.data as { model?: { provider?: string; id?: string } } | undefined)?.model;
				const available = await probe.getAvailableModels();
				const models = ((available.data as { models?: { provider: string; id: string }[] } | undefined)?.models ??
					[]) as { provider: string; id: string }[];
				candidate = models.find((m) => m.provider === current?.provider && m.id !== current?.id) ?? null;
			} finally {
				await probe.close();
			}
			if (!candidate) {
				// This machine's catalog has no second model for the target's provider: the
				// change cannot be exercised here. Reported, not silently passed.
				console.warn("ft55: no second model available for the disposable session; model change not exercised");
				return;
			}

			const result = await applySessionModel(
				runtime,
				"set_session_model",
				{ sessionId: idB, sessionPath: sessionB },
				candidate.provider,
				candidate.id,
			);

			expect(result.ok).toBe(true);
			expect(result.changed).toBe(true);
			expect(result.model.after?.modelId).toBe(candidate.id);
			expect(result.applied).toBe("model");

			// the target's own session now says so
			const targetState = await askSession(sessionB);
			expect((targetState.model as { id?: string } | undefined)?.id).toBe(candidate.id);

			// and the other session did not move
			const otherState = await askSession(sessionA);
			expect((otherState.model as { id?: string } | undefined)?.id).not.toBe(candidate.id);
			expect(readFileSync(sessionA, "utf8")).toBe(beforeA);
			expect(readFileSync(sessionB, "utf8")).not.toBe(beforeB);
		},
		{ timeout: 60_000 },
	);
});
