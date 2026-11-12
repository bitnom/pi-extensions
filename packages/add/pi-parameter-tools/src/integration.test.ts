// integration.test.ts — disposable running pi sessions, and one change at a time.
//
// These tests drive the real thing: real pi processes, each with this extension
// loaded, so each one runs its own receiver. The caller asks another session for a
// change; that session applies it with its own setters; the answer comes back from
// the session that made the change.
//
// The caller is a real pi too. A driver extension — a temporary fixture, not part of
// the package — registers a command that calls the same function the tool calls, and
// the test drives that command over pi's own control channel. A slash command runs
// in-process, so no provider is called: a parameter change is not a completion.
//
// No lane of the running fleet is touched, and every session lives in a temporary
// directory.
//
// The question these tests answer is the one that matters: **does a change aimed at
// one session change anything else?**

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChannelRequest, sendRequest, socketPathFor } from "./channel.ts";
import { openRpcSession, type RpcChild, type RpcSession } from "./rpc.ts";

const SRC_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

/**
 * The driver fixture: a pi extension that loads this package and adds one command.
 *
 * The command calls the package's own session-targeted function with the package's own
 * runtime, built from the real extension context. It is a way to *drive* the tool
 * without a model in the loop; it is not a second implementation of it.
 */
const DRIVER_SOURCE = `import { writeFileSync } from "node:fs";
import parameterTools, { createParameterRuntime } from "${SRC_DIR}/index.ts";
import { applySessionModel, applySessionThinking } from "${SRC_DIR}/target.ts";

export default function driver(pi: any): void {
	parameterTools(pi);
	pi.registerCommand("ft55-call", {
		description: "ft55 test driver: run one parameter tool and report its result",
		handler: async (args: string, ctx: any): Promise<void> => {
			const payload = JSON.parse(args);
			const runtime = createParameterRuntime(pi, ctx);
			const result =
				payload.tool === "set_session_model"
					? await applySessionModel(runtime, payload.tool, payload.request, payload.provider, payload.modelId)
					: await applySessionThinking(runtime, payload.tool, payload.request, payload.level);
			writeFileSync(payload.out, JSON.stringify(result));
		},
	});
}
`;

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

/**
 * The children's environment: the test's own, without the fleet's place markers.
 *
 * A test child is not a lane of the fleet, so it must not claim to be in one: the
 * holds are decided by the place ids in the environment.
 */
function hermeticEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("HERDR_")) delete env[key];
	}
	return env;
}

let driverPath = "";
/** pi, in RPC mode, with the extension (and the driver) loaded: a session with a receiver. */
const spawnPi = (command: string, args: string[], options: { stdio: ["pipe", "pipe", "pipe"] }) =>
	spawn(command, [...args, "--no-extensions", "--extension", driverPath], {
		stdio: options.stdio,
		env: hermeticEnv(),
	}) as unknown as RpcChild;

/** pi, in RPC mode, with no extension: a running session with no receiver. */
const spawnPiBare = (command: string, args: string[], options: { stdio: ["pipe", "pipe", "pipe"] }) =>
	spawn(command, [...args, "--no-extensions"], {
		stdio: options.stdio,
		env: hermeticEnv(),
	}) as unknown as RpcChild;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for something to become true, or say what never became true. */
async function waitFor<T>(
	what: string,
	check: () => T | null | undefined | Promise<T | null | undefined>,
	timeoutMs = 30_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value !== null && value !== undefined && value !== false) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

let workdir = "";
let runtimeDir = "";
let sessionA = "";
let sessionB = "";
let sessionC = "";
let sessionD = "";
let idA = "";
let idB = "";
let idC = "";
let idD = "";
let caller: RpcSession;
let target: RpcSession;
let unrelated: RpcSession;
let bare: RpcSession;
let callCount = 0;

/** The state a running session reports about itself. */
async function stateOf(session: RpcSession): Promise<Record<string, unknown>> {
	const outcome = await session.getState();
	expect(outcome.ok).toBe(true);
	return (outcome.data ?? {}) as Record<string, unknown>;
}

/**
 * Call the tool inside the caller's own pi process.
 *
 * The prompt is a slash command, so it runs in-process and the model is never asked
 * anything: pi answers "handled" for a command and "started" for a prompt. The
 * assertion below is what keeps this test provider-free.
 */
async function callTool(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
	callCount += 1;
	const out = join(workdir, `result-${callCount}.json`);
	const outcome = await caller.prompt(`/ft55-call ${JSON.stringify({ ...payload, out })}`);
	expect(outcome.ok).toBe(true);
	expect((outcome.data as { disposition?: string } | undefined)?.disposition).toBe("handled");
	return await waitFor("the tool's result", () =>
		existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>) : null,
	);
}

/** A request sent straight over the local channel, to the target's own receiver. */
async function askReceiver(sessionId: string, request: Partial<ChannelRequest>): Promise<ChannelResponseShape> {
	const response = await sendRequest({
		sessionId,
		request: {
			requestId: `probe-${Date.now().toString(36)}`,
			tool: "set_session_thinking",
			sessionId,
			sessionPath: "",
			action: "set_thinking",
			level: "high",
			...request,
		},
	});
	return response as ChannelResponseShape;
}

interface ChannelResponseShape {
	ok: boolean;
	refusal?: { code: string; message: string };
	result?: Record<string, unknown>;
	receiver?: { sessionId: string | null; sessionPath: string | null };
}

beforeAll(async () => {
	workdir = mkdtempSync(join(tmpdir(), "ft55-sessions-"));
	runtimeDir = mkdtempSync(join(tmpdir(), "ft55-runtime-"));
	// The sockets live under the runtime directory, so a test run never touches a
	// real lane's socket and never collides with one.
	process.env.XDG_RUNTIME_DIR = runtimeDir;
	driverPath = join(workdir, "driver.ts");
	writeFileSync(driverPath, DRIVER_SOURCE);

	idA = "aaaaaaaa-0000-4000-8000-00000000000a";
	idB = "bbbbbbbb-0000-4000-8000-00000000000b";
	idC = "cccccccc-0000-4000-8000-00000000000c";
	idD = "dddddddd-0000-4000-8000-00000000000d";
	sessionA = writeDisposableSession(workdir, "a.jsonl", idA);
	sessionB = writeDisposableSession(workdir, "b.jsonl", idB);
	sessionC = writeDisposableSession(workdir, "c.jsonl", idC);
	sessionD = writeDisposableSession(workdir, "d.jsonl", idD);

	caller = await openRpcSession({ spawn: spawnPi, sessionPath: sessionA, timeoutMs: 60_000 });
	target = await openRpcSession({ spawn: spawnPi, sessionPath: sessionB, timeoutMs: 60_000 });
	unrelated = await openRpcSession({ spawn: spawnPi, sessionPath: sessionC, timeoutMs: 60_000 });
	bare = await openRpcSession({ spawn: spawnPiBare, sessionPath: sessionD, timeoutMs: 60_000 });

	// Each session with the extension runs a receiver; the one without does not.
	await waitFor("the caller's receiver", () => (existsSync(socketPathFor(idA)) ? true : null));
	await waitFor("the target's receiver", () => (existsSync(socketPathFor(idB)) ? true : null));
	await waitFor("the unrelated session's receiver", () => (existsSync(socketPathFor(idC)) ? true : null));
	// The driver's command must exist before any prompt: a prompt that is not a
	// command would reach the model.
	await waitFor("the driver's command", async () => {
		const outcome = await caller.getCommands();
		const commands = (outcome.data as { commands?: { name?: string }[] } | undefined)?.commands ?? [];
		return commands.some((command) => command.name === "ft55-call") ? true : null;
	});
});

afterAll(async () => {
	for (const session of [caller, target, unrelated, bare]) {
		if (session) await session.close();
	}
	if (workdir) rmSync(workdir, { recursive: true, force: true });
	if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
});

describe("a change aimed at another running session", () => {
	test("changes that session's thinking level, and leaves this one alone", async () => {
		const beforeA = readFileSync(sessionA, "utf8");
		const beforeB = readFileSync(sessionB, "utf8");
		const beforeC = readFileSync(sessionC, "utf8");
		expect((await stateOf(target)).thinkingLevel).toBe("off");

		const result = await callTool({
			tool: "set_session_thinking",
			request: { sessionId: idB, sessionPath: sessionB },
			level: "high",
		});
		expect(result.ok).toBe(true);
		expect(result.changed).toBe(true);
		expect(result.applied).toBe("thinking");
		// the change was made by the target's own process, not by the caller
		expect((result.target as { resolution?: { source?: string } }).resolution?.source).toBe("receiver");
		// the answer is the target's own: before off, after high
		const thinking = result.thinking as { before: string; after: string };
		expect(thinking.before).toBe("off");
		expect(thinking.after).toBe("high");

		// the target's own running session says so
		expect((await stateOf(target)).thinkingLevel).toBe("high");

		// the caller did not move, and neither did the unrelated session
		expect((await stateOf(caller)).thinkingLevel).toBe("off");
		expect((await stateOf(unrelated)).thinkingLevel).toBe("off");
		expect(readFileSync(sessionA, "utf8")).toBe(beforeA);
		expect(readFileSync(sessionC, "utf8")).toBe(beforeC);
		expect(readFileSync(sessionB, "utf8")).not.toBe(beforeB);
	});

	test("changes that session's model too", async () => {
		const beforeB = readFileSync(sessionB, "utf8");
		const beforeA = readFileSync(sessionA, "utf8");
		const state = await stateOf(target);
		const current = state.model as { provider?: string; id?: string };
		const available = await target.getAvailableModels();
		const models = (available.data as { models?: { provider: string; id: string }[] } | undefined)?.models ?? [];
		// Another model of the provider that is already in use: that provider has
		// credentials, so the change is not refused for a missing key.
		const candidate = models.find((m) => m.provider === current.provider && m.id !== current.id) ?? null;
		if (!candidate) {
			console.warn("ft55: no second model of the current provider; the model change is not exercised");
			return;
		}

		const result = await callTool({
			tool: "set_session_model",
			request: { sessionId: idB, sessionPath: sessionB },
			provider: candidate.provider,
			modelId: candidate.id,
		});
		expect(result.ok).toBe(true);
		expect(result.changed).toBe(true);
		// The model changed; the thinking level may have moved with it, because the
		// new model supports different levels.
		expect(["model", "both"]).toContain(result.applied as string);
		expect((result.model as { after?: { modelId?: string } }).after?.modelId).toBe(candidate.id);

		// the target's own running session says so
		expect(((await stateOf(target)).model as { id?: string }).id).toBe(candidate.id);
		expect(readFileSync(sessionB, "utf8")).not.toBe(beforeB);
		// the caller did not move
		expect((await stateOf(caller)).thinkingLevel).toBe("off");
		expect(readFileSync(sessionA, "utf8")).toBe(beforeA);
	});
});

describe("a target that cannot be changed", () => {
	test("a running session with no receiver loaded is refused, and nothing is written", async () => {
		const beforeD = readFileSync(sessionD, "utf8");
		const result = await callTool({
			tool: "set_session_thinking",
			request: { sessionId: idD, sessionPath: sessionD },
			level: "high",
		});
		expect(result.ok).toBe(false);
		expect((result.refusal as { code?: string } | undefined)?.code).toBe("receiver_unavailable");
		expect(result.changed).toBe(false);
		expect(readFileSync(sessionD, "utf8")).toBe(beforeD);
	});

	test("a request that names another session is refused by the target itself", async () => {
		const beforeB = readFileSync(sessionB, "utf8");
		const response = await askReceiver(idB, { sessionId: idC, sessionPath: sessionC });
		expect(response.ok).toBe(false);
		expect(response.refusal?.code).toBe("session_id_mismatch");
		expect(readFileSync(sessionB, "utf8")).toBe(beforeB);
	});

	test("a request that names another session file is refused by the target itself", async () => {
		const beforeB = readFileSync(sessionB, "utf8");
		const response = await askReceiver(idB, { sessionId: idB, sessionPath: sessionC });
		expect(response.ok).toBe(false);
		expect(response.refusal?.code).toBe("session_identity_mismatch");
		expect(readFileSync(sessionB, "utf8")).toBe(beforeB);
	});

	test("an ambiguous binding is refused before anything is sent", async () => {
		const beforeB = readFileSync(sessionB, "utf8");
		const both = await callTool({
			tool: "set_session_thinking",
			request: { sessionId: idB, sessionPath: sessionB, lane: "lane-a" },
			level: "high",
		});
		expect(both.ok).toBe(false);
		expect((both.refusal as { code?: string } | undefined)?.code).toBe("identity_binding_conflict");

		const neither = await callTool({
			tool: "set_session_thinking",
			request: { sessionId: idB },
			level: "high",
		});
		expect(neither.ok).toBe(false);
		expect((neither.refusal as { code?: string } | undefined)?.code).toBe("identity_binding_required");

		expect(readFileSync(sessionB, "utf8")).toBe(beforeB);
	});

	test("a receiver that does not answer is a timeout", async () => {
		// A socket that accepts the connection and never answers: the caller must not
		// wait forever, and must say that it timed out.
		const id = "eeeeeeee-0000-4000-8000-00000000000e";
		const server = createServer(() => {
			// accept, and say nothing
		});
		await new Promise<void>((resolve) => server.listen(socketPathFor(id), resolve));
		try {
			const response = await sendRequest({
				sessionId: id,
				request: {
					requestId: "timeout-probe",
					tool: "set_session_thinking",
					sessionId: id,
					sessionPath: "",
					action: "set_thinking",
					level: "high",
				},
				timeoutMs: 300,
			});
			expect(response.ok).toBe(false);
			expect(response.refusal?.code).toBe("target_timeout");
		} finally {
			server.close();
		}
	});
});
