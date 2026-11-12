// fakes.ts — the test doubles.
//
// The runtime, the RPC session and the herdr command are all injected, so every path
// in this package can be exercised without a process, a provider or a network.

import type { HerdrLaneResult } from "./herdr.ts";
import type { ModelRef } from "./params.ts";
import type { RpcOutcome, RpcSession } from "./rpc.ts";
import type { ParameterRuntime } from "./target.ts";

export interface FakeRuntimeOptions {
	sessionId?: string | null;
	sessionPath?: string | null;
	model?: ModelRef | null;
	thinkingLevel?: string | null;
	supported?: string[];
	knownModels?: ModelRef[];
	authed?: boolean;
	ownRecords?: { modelChangeEntryId: string | null; thinkingLevelEntryId: string | null };
	openRemoteSession?: (sessionPath: string) => Promise<RpcSession>;
	resolveLane?: (lane: string) => Promise<HerdrLaneResult>;
}

export interface FakeRuntime extends ParameterRuntime {
	calls: {
		setModel: ModelRef[];
		setThinkingLevel: string[];
		opened: string[];
		laneResolutions: string[];
	};
	state: { model: ModelRef | null; thinkingLevel: string | null };
}

export function makeFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
	const state = {
		model: options.model ?? { provider: "anthropic", modelId: "claude-sonnet-4" },
		thinkingLevel: options.thinkingLevel ?? "off",
	};
	const calls = {
		setModel: [] as ModelRef[],
		setThinkingLevel: [] as string[],
		opened: [] as string[],
		laneResolutions: [] as string[],
	};
	const known = options.knownModels ?? [{ provider: "anthropic", modelId: "claude-sonnet-4" }];
	return {
		calls,
		state,
		own: {
			sessionId: options.sessionId ?? "own-session-id",
			sessionPath: options.sessionPath ?? "/tmp/own/session.jsonl",
			model: state.model,
			thinkingLevel: state.thinkingLevel,
		},
		getModel: () => state.model,
		getThinkingLevel: () => state.thinkingLevel,
		supportedThinkingLevels: () => options.supported ?? ["off", "low", "medium", "high"],
		resolveModel: (ref) => known.find((m) => m.provider === ref.provider && m.modelId === ref.modelId) ?? null,
		setOwnModel: async (ref) => {
			calls.setModel.push(ref);
			if (options.authed === false) return false;
			state.model = ref;
			return true;
		},
		setOwnThinkingLevel: (level) => {
			calls.setThinkingLevel.push(level);
			state.thinkingLevel = level;
		},
		ownRecords: () =>
			options.ownRecords ?? { modelChangeEntryId: "own-record-1", thinkingLevelEntryId: "own-record-2" },
		openRemoteSession: async (sessionPath) => {
			calls.opened.push(sessionPath);
			if (options.openRemoteSession) return options.openRemoteSession(sessionPath);
			return makeFakeRpcSession({ sessionId: "remote-session-id", sessionFile: sessionPath });
		},
		resolveLane: async (lane) => {
			calls.laneResolutions.push(lane);
			if (options.resolveLane) return options.resolveLane(lane);
			return {
				ok: false,
				failure: { code: "herdr_absent", message: "herdr is not available in this environment" },
			};
		},
	};
}

export interface FakeRpcState {
	sessionId: string;
	sessionFile: string;
	model?: ModelRef | null;
	thinkingLevel?: string | null;
	entries?: { type: string; id: string }[];
	/** The commands the session refuses. */
	failModel?: string;
	failThinking?: string;
}

export interface FakeRpcSession extends RpcSession {
	state: FakeRpcState;
	commands: { type: string; [key: string]: unknown }[];
}

export function makeFakeRpcSession(state: FakeRpcState): FakeRpcSession {
	const commands: { type: string; [key: string]: unknown }[] = [];
	const entries = state.entries ?? [];
	return {
		state,
		commands,
		async getState(): Promise<RpcOutcome> {
			commands.push({ type: "get_state" });
			return {
				ok: true,
				data: {
					sessionId: state.sessionId,
					sessionFile: state.sessionFile,
					model: state.model ? { provider: state.model.provider, id: state.model.modelId } : null,
					thinkingLevel: state.thinkingLevel ?? null,
				},
			};
		},
		async getEntries(): Promise<RpcOutcome> {
			commands.push({ type: "get_entries" });
			return { ok: true, data: { entries } };
		},
		async getAvailableModels(): Promise<RpcOutcome> {
			commands.push({ type: "get_available_models" });
			return { ok: true, data: { models: [] } };
		},
		async setModel(provider: string, modelId: string): Promise<RpcOutcome> {
			commands.push({ type: "set_model", provider, modelId });
			if (state.failModel) return { ok: false, error: state.failModel };
			state.model = { provider, modelId };
			entries.push({ type: "model_change", id: `model-${entries.length}` });
			return { ok: true };
		},
		async setThinkingLevel(level: string): Promise<RpcOutcome> {
			commands.push({ type: "set_thinking_level", level });
			if (state.failThinking) return { ok: false, error: state.failThinking };
			state.thinkingLevel = level;
			entries.push({ type: "thinking_level_change", id: `thinking-${entries.length}` });
			return { ok: true };
		},
		async close(): Promise<void> {
			commands.push({ type: "close" });
		},
	};
}
