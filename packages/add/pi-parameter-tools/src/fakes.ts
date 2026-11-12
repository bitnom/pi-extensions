// fakes.ts — the test doubles.
//
// The runtime and the herdr command are injected, so every path in this package can
// be exercised without a process, a provider or a network.

import type { HerdrLaneResult } from "./herdr.ts";
import type { ModelRef } from "./params.ts";
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
	resolveLane?: (lane: string) => Promise<HerdrLaneResult>;
	/** The session id recorded in a session file's header. */
	sessionHeaderIds?: Record<string, string>;
}

export interface FakeRuntime extends ParameterRuntime {
	calls: {
		setModel: ModelRef[];
		setThinkingLevel: string[];
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
		getModel: async () => state.model,
		getThinkingLevel: async () => state.thinkingLevel,
		supportedThinkingLevels: () => options.supported ?? ["off", "low", "medium", "high"],
		resolveModel: async (ref) => known.find((m) => m.provider === ref.provider && m.modelId === ref.modelId) ?? null,
		setOwnModel: async (ref) => {
			calls.setModel.push(ref);
			if (options.authed === false) return false;
			state.model = ref;
			return true;
		},
		setOwnThinkingLevel: async (level) => {
			calls.setThinkingLevel.push(level);
			state.thinkingLevel = level;
		},
		ownRecords: async () =>
			options.ownRecords ?? { modelChangeEntryId: "own-record-1", thinkingLevelEntryId: "own-record-2" },
		readSessionHeaderId: async (sessionPath) => options.sessionHeaderIds?.[sessionPath] ?? null,
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
