// target.test.ts — what the four tools do, and what they refuse.
//
// The runtime and the control channel are injected, so these tests never start a
// process, never call a provider and never touch a session file.

import { describe, expect, test } from "bun:test";
import { makeFakeRpcSession, makeFakeRuntime } from "./fakes.ts";
import { applyOwnModel, applyOwnThinking, applySessionModel, applySessionThinking } from "./target.ts";

const OWN_ID = "own-session-id";
const OWN_PATH = "/tmp/own/session.jsonl";

describe("set_own_thinking", () => {
	test("sets the level and reports the change", async () => {
		const runtime = makeFakeRuntime({ thinkingLevel: "off" });
		const result = await applyOwnThinking(runtime, "set_own_thinking", "high");
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("thinking");
		expect(result.changed).toBe(true);
		expect(result.thinking.before).toBe("off");
		expect(result.thinking.after).toBe("high");
		expect(runtime.calls.setThinkingLevel).toEqual(["high"]);
	});

	test("the same level again is a no-op: the setter is not called", async () => {
		const runtime = makeFakeRuntime({ thinkingLevel: "high" });
		const result = await applyOwnThinking(runtime, "set_own_thinking", "high");
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("none");
		expect(result.changed).toBe(false);
		expect(runtime.calls.setThinkingLevel).toEqual([]);
	});

	test("an unknown level is refused, never clamped", async () => {
		const runtime = makeFakeRuntime();
		const result = await applyOwnThinking(runtime, "set_own_thinking", "HIGH");
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("invalid_level");
		expect(runtime.calls.setThinkingLevel).toEqual([]);
	});

	test("a level the model does not support is refused, and the supported ones are named", async () => {
		const runtime = makeFakeRuntime({ supported: ["off", "low"] });
		const result = await applyOwnThinking(runtime, "set_own_thinking", "xhigh");
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("level_unsupported");
		expect(result.refusal?.detail?.supported).toEqual(["off", "low"]);
		expect(runtime.calls.setThinkingLevel).toEqual([]);
	});
});

describe("set_own_model", () => {
	test("sets the model and reports the change", async () => {
		const runtime = makeFakeRuntime({
			model: { provider: "anthropic", modelId: "claude-sonnet-4" },
			knownModels: [
				{ provider: "anthropic", modelId: "claude-sonnet-4" },
				{ provider: "anthropic", modelId: "claude-opus-4" },
			],
		});
		const result = await applyOwnModel(runtime, "set_own_model", "anthropic", "claude-opus-4");
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("model");
		expect(result.changed).toBe(true);
		expect(result.model.before?.modelId).toBe("claude-sonnet-4");
		expect(result.model.after?.modelId).toBe("claude-opus-4");
		expect(runtime.calls.setModel).toEqual([{ provider: "anthropic", modelId: "claude-opus-4" }]);
	});

	test("the same model again is a no-op: the setter is not called", async () => {
		const runtime = makeFakeRuntime({ model: { provider: "anthropic", modelId: "claude-sonnet-4" } });
		const result = await applyOwnModel(runtime, "set_own_model", "anthropic", "claude-sonnet-4");
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("none");
		expect(result.changed).toBe(false);
		expect(runtime.calls.setModel).toEqual([]);
	});

	test("a model the registry does not know is refused", async () => {
		const runtime = makeFakeRuntime();
		const result = await applyOwnModel(runtime, "set_own_model", "anthropic", "nope");
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("model_unknown");
		expect(runtime.calls.setModel).toEqual([]);
	});

	test("a provider without credentials is refused", async () => {
		const runtime = makeFakeRuntime({
			authed: false,
			knownModels: [
				{ provider: "anthropic", modelId: "claude-sonnet-4" },
				{ provider: "anthropic", modelId: "claude-opus-4" },
			],
		});
		const result = await applyOwnModel(runtime, "set_own_model", "anthropic", "claude-opus-4");
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("auth_missing");
	});

	test("a setter that throws is an apply failure, not an auth failure", async () => {
		const runtime = makeFakeRuntime({
			knownModels: [
				{ provider: "anthropic", modelId: "claude-sonnet-4" },
				{ provider: "anthropic", modelId: "claude-opus-4" },
			],
		});
		runtime.setOwnModel = async () => {
			throw new Error("boom");
		};
		const result = await applyOwnModel(runtime, "set_own_model", "anthropic", "claude-opus-4");
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("apply_failed");
	});
});

describe("set_session_thinking", () => {
	test("changes the named session and reports the before and after", async () => {
		const fake = makeFakeRpcSession({
			sessionId: "target-id",
			sessionFile: "/tmp/target/session.jsonl",
			thinkingLevel: "off",
		});
		const runtime = makeFakeRuntime({ openRemoteSession: async () => fake });
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "target-id", sessionPath: "/tmp/target/session.jsonl" },
			"high",
		);
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("thinking");
		expect(result.changed).toBe(true);
		expect(result.thinking.before).toBe("off");
		expect(result.thinking.after).toBe("high");
		expect(result.target.sessionId).toBe("target-id");
		expect(result.target.resolution?.source).toBe("session_file");
		expect(fake.commands.map((c) => c.type)).toContain("set_thinking_level");
	});

	test("a target that answers with another session id is refused, and nothing changes", async () => {
		const fake = makeFakeRpcSession({
			sessionId: "other-id",
			sessionFile: "/tmp/target/session.jsonl",
			thinkingLevel: "off",
		});
		const runtime = makeFakeRuntime({ openRemoteSession: async () => fake });
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "target-id", sessionPath: "/tmp/target/session.jsonl" },
			"high",
		);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("session_id_mismatch");
		expect(fake.commands.map((c) => c.type)).not.toContain("set_thinking_level");
	});

	test("a target that answers with another file is refused, and nothing changes", async () => {
		const fake = makeFakeRpcSession({
			sessionId: "target-id",
			sessionFile: "/tmp/other/session.jsonl",
			thinkingLevel: "off",
		});
		const runtime = makeFakeRuntime({ openRemoteSession: async () => fake });
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "target-id", sessionPath: "/tmp/target/session.jsonl" },
			"high",
		);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("session_identity_mismatch");
		expect(fake.commands.map((c) => c.type)).not.toContain("set_thinking_level");
	});

	test("two bindings at once is refused before the target is opened", async () => {
		const runtime = makeFakeRuntime();
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "target-id", sessionPath: "/tmp/target/session.jsonl", lane: "lane-a" },
			"high",
		);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("identity_binding_conflict");
		expect(runtime.calls.opened).toEqual([]);
	});

	test("no binding at all is refused before the target is opened", async () => {
		const runtime = makeFakeRuntime();
		const result = await applySessionThinking(runtime, "set_session_thinking", { sessionId: "target-id" }, "high");
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("identity_binding_required");
		expect(runtime.calls.opened).toEqual([]);
	});

	test("a target that cannot be reached is refused", async () => {
		const runtime = makeFakeRuntime({
			openRemoteSession: async () => {
				throw new Error("no such session");
			},
		});
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "target-id", sessionPath: "/tmp/target/session.jsonl" },
			"high",
		);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("target_not_reachable");
	});

	test("the caller's own session is changed in this process, not over the channel", async () => {
		const runtime = makeFakeRuntime({ sessionId: OWN_ID, sessionPath: OWN_PATH });
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: OWN_ID, sessionPath: OWN_PATH },
			"high",
		);
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("thinking");
		expect(runtime.calls.setThinkingLevel).toEqual(["high"]);
		expect(runtime.calls.opened).toEqual([]);
	});

	test("a lane binding resolves the lane to a session and then changes it", async () => {
		const fake = makeFakeRpcSession({
			sessionId: "target-id",
			sessionFile: "/tmp/lane/session.jsonl",
			thinkingLevel: "off",
		});
		const runtime = makeFakeRuntime({
			openRemoteSession: async () => fake,
			resolveLane: async () => ({
				ok: true,
				lane: { sessionPath: "/tmp/lane/session.jsonl", kind: "pi", paneId: "w1A:p1" },
			}),
		});
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "target-id", lane: "lane-a" },
			"high",
		);
		expect(result.ok).toBe(true);
		expect(result.target.resolution?.source).toBe("lane");
		expect(result.target.resolution?.lane).toBe("lane-a");
		expect(runtime.calls.laneResolutions).toEqual(["lane-a"]);
	});

	test("a lane that cannot be resolved is refused, and nothing is opened", async () => {
		const runtime = makeFakeRuntime({
			resolveLane: async () => ({
				ok: false,
				failure: { code: "target_lane_unknown", message: "no such lane" },
			}),
		});
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "target-id", lane: "lane-a" },
			"high",
		);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("target_lane_unknown");
		expect(runtime.calls.opened).toEqual([]);
	});
});

describe("set_session_model", () => {
	test("changes the named session's model", async () => {
		const fake = makeFakeRpcSession({
			sessionId: "target-id",
			sessionFile: "/tmp/target/session.jsonl",
			model: { provider: "anthropic", modelId: "claude-sonnet-4" },
		});
		const runtime = makeFakeRuntime({ openRemoteSession: async () => fake });
		const result = await applySessionModel(
			runtime,
			"set_session_model",
			{ sessionId: "target-id", sessionPath: "/tmp/target/session.jsonl" },
			"anthropic",
			"claude-opus-4",
		);
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("model");
		expect(result.changed).toBe(true);
		expect(result.model.after?.modelId).toBe("claude-opus-4");
		expect(result.records.modelChangeEntryId).not.toBeNull();
	});

	test("the same model again is a no-op: the target is not changed", async () => {
		const fake = makeFakeRpcSession({
			sessionId: "target-id",
			sessionFile: "/tmp/target/session.jsonl",
			model: { provider: "anthropic", modelId: "claude-sonnet-4" },
		});
		const runtime = makeFakeRuntime({ openRemoteSession: async () => fake });
		const result = await applySessionModel(
			runtime,
			"set_session_model",
			{ sessionId: "target-id", sessionPath: "/tmp/target/session.jsonl" },
			"anthropic",
			"claude-sonnet-4",
		);
		expect(result.ok).toBe(true);
		expect(result.applied).toBe("none");
		expect(result.changed).toBe(false);
		expect(fake.commands.map((c) => c.type)).not.toContain("set_model");
	});

	test("a model the target's registry does not know is refused", async () => {
		const fake = makeFakeRpcSession({
			sessionId: "target-id",
			sessionFile: "/tmp/target/session.jsonl",
			failModel: "Model not found: anthropic/nope",
		});
		const runtime = makeFakeRuntime({ openRemoteSession: async () => fake });
		const result = await applySessionModel(
			runtime,
			"set_session_model",
			{ sessionId: "target-id", sessionPath: "/tmp/target/session.jsonl" },
			"anthropic",
			"nope",
		);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("model_unknown");
	});

	test("a provider without credentials in the target is refused", async () => {
		const fake = makeFakeRpcSession({
			sessionId: "target-id",
			sessionFile: "/tmp/target/session.jsonl",
			failModel: "No API key for anthropic/claude-opus-4",
		});
		const runtime = makeFakeRuntime({ openRemoteSession: async () => fake });
		const result = await applySessionModel(
			runtime,
			"set_session_model",
			{ sessionId: "target-id", sessionPath: "/tmp/target/session.jsonl" },
			"anthropic",
			"claude-opus-4",
		);
		expect(result.ok).toBe(false);
		expect(result.refusal?.code).toBe("auth_missing");
	});
});

describe("isolation", () => {
	test("a change aimed at B changes B and leaves A alone", async () => {
		const a = makeFakeRpcSession({
			sessionId: "a-id",
			sessionFile: "/tmp/a/session.jsonl",
			thinkingLevel: "off",
		});
		const b = makeFakeRpcSession({
			sessionId: "b-id",
			sessionFile: "/tmp/b/session.jsonl",
			thinkingLevel: "off",
		});
		const runtime = makeFakeRuntime({
			openRemoteSession: async (path) => (path === "/tmp/b/session.jsonl" ? b : a),
		});
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "b-id", sessionPath: "/tmp/b/session.jsonl" },
			"high",
		);
		expect(result.ok).toBe(true);
		expect(b.state.thinkingLevel).toBe("high");
		expect(a.state.thinkingLevel).toBe("off");
		expect(a.commands.map((c) => c.type)).not.toContain("set_thinking_level");
	});

	test("and the other way round", async () => {
		const a = makeFakeRpcSession({
			sessionId: "a-id",
			sessionFile: "/tmp/a/session.jsonl",
			thinkingLevel: "off",
		});
		const b = makeFakeRpcSession({
			sessionId: "b-id",
			sessionFile: "/tmp/b/session.jsonl",
			thinkingLevel: "off",
		});
		const runtime = makeFakeRuntime({
			openRemoteSession: async (path) => (path === "/tmp/a/session.jsonl" ? a : b),
		});
		const result = await applySessionThinking(
			runtime,
			"set_session_thinking",
			{ sessionId: "a-id", sessionPath: "/tmp/a/session.jsonl" },
			"low",
		);
		expect(result.ok).toBe(true);
		expect(a.state.thinkingLevel).toBe("low");
		expect(b.state.thinkingLevel).toBe("off");
		expect(b.commands.map((c) => c.type)).not.toContain("set_thinking_level");
	});
});
