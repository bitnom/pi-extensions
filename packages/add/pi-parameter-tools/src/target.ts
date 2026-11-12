// target.ts — resolve a target, then change it.
//
// Two kinds of change, one rule: the change lands in the session the request named,
// and in no other.
//
//   * the **own** session — the caller's own session, changed in the caller's own
//     process through pi's own session-control methods;
//   * a **target session** — an explicitly identified session, reached over pi's own
//     RPC control channel.
//
// The runtime is injected, so every path in this file can be exercised without a
// process (the unit tests) and against a real disposable pi (the integration test).

import type { HerdrLaneResult } from "./herdr.ts";
import { isOwnSession, type ResolvedBinding, resolveBinding, type TargetRequest } from "./identity.ts";
import {
	type Applied,
	emptyTarget,
	isThinkingLevel,
	type ModelRef,
	type ParameterToolResult,
	type RefusalCode,
	refusal,
	type TargetReport,
} from "./params.ts";
import type { RpcOutcome, RpcSession } from "./rpc.ts";

/** What the caller can do to its own session. */
export interface ParameterRuntime {
	own: {
		sessionId: string | null;
		sessionPath: string | null;
		model: ModelRef | null;
		thinkingLevel: string | null;
	};
	getModel(): ModelRef | null;
	getThinkingLevel(): string | null;
	/** The thinking levels the current model supports. */
	supportedThinkingLevels(): string[];
	/** Resolve a provider/model pair in pi's model registry. Null when it is unknown. */
	resolveModel(ref: ModelRef): ModelRef | null;
	/** Change the caller's own session's model. False when the provider has no auth. */
	setOwnModel(ref: ModelRef): Promise<boolean>;
	/** Change the caller's own session's thinking level. */
	setOwnThinkingLevel(level: string): void;
	/** The record ids the own session's branch gained, if any. */
	ownRecords(): { modelChangeEntryId: string | null; thinkingLevelEntryId: string | null };
	/** Open a session over pi's RPC control channel. */
	openRemoteSession(sessionPath: string): Promise<RpcSession>;
	/** Resolve a herdr lane to the session behind it. */
	resolveLane(lane: string): Promise<HerdrLaneResult>;
}

export interface SessionRequest extends TargetRequest {
	sessionId?: unknown;
	sessionPath?: unknown;
	lane?: unknown;
}

/* -------------------------------------------------------------------------- */
/* the own session                                                             */
/* -------------------------------------------------------------------------- */

function modelRefOf(model: unknown): ModelRef | null {
	if (!model || typeof model !== "object") return null;
	const record = model as { provider?: unknown; id?: unknown; modelId?: unknown };
	const provider = typeof record.provider === "string" ? record.provider : null;
	const id = typeof record.id === "string" ? record.id : typeof record.modelId === "string" ? record.modelId : null;
	if (!provider || !id) return null;
	return { provider, modelId: id };
}

function sameModel(a: ModelRef | null, b: ModelRef | null): boolean {
	if (!a || !b) return false;
	return a.provider === b.provider && a.modelId === b.modelId;
}

/**
 * Set the caller's own thinking level.
 *
 * The level is validated against pi's own list before anything is touched, and
 * against the levels the current model supports after that: pi clamps an unsupported
 * level to the nearest one it does support, and a clamp is not what the caller asked
 * for, so it is refused with the supported levels named.
 */
export async function applyOwnThinking(
	runtime: ParameterRuntime,
	tool: string,
	level: unknown,
): Promise<ParameterToolResult> {
	const requested = { level: typeof level === "string" ? level : String(level ?? "") };
	if (!isThinkingLevel(level)) {
		return refusal(tool, "invalid_level", "that is not a thinking level pi accepts", emptyTarget(requested));
	}
	const supported = runtime.supportedThinkingLevels();
	const before = runtime.getThinkingLevel();
	const target: TargetReport = {
		kind: "own",
		sessionId: runtime.own.sessionId,
		sessionPath: runtime.own.sessionPath,
		requested: requested,
		resolution: { source: "in_memory" },
	};

	if (!supported.includes(level)) {
		return refusal(
			tool,
			"level_unsupported",
			`the current model does not support that thinking level (supported: ${supported.join(", ") || "none"})`,
			target,
			{ supported },
		);
	}

	const alreadyThere = before === level;
	if (!alreadyThere) runtime.setOwnThinkingLevel(level);
	const after = runtime.getThinkingLevel();
	const records = runtime.ownRecords();

	const changed = !alreadyThere && after === level;
	return {
		ok: true,
		tool,
		target,
		model: { before: modelRefOf(runtime.getModel()), requested: null, after: modelRefOf(runtime.getModel()) },
		thinking: { before, requested: level, after, supported },
		applied: changed ? "thinking" : "none",
		changed,
		records,
		disk: { state: runtime.own.sessionPath ? "unknown" : "not_applicable" },
		effective: "next_request",
		partial: changed && !records.thinkingLevelEntryId,
		warnings: [],
	};
}

/**
 * Set the caller's own model.
 *
 * The provider and the model id are resolved in pi's model registry first: an
 * unregistered model is refused before any credential is touched, and the same model
 * that is already selected is a no-op — no credential check, no setter call, no
 * record.
 */
export async function applyOwnModel(
	runtime: ParameterRuntime,
	tool: string,
	provider: unknown,
	modelId: unknown,
): Promise<ParameterToolResult> {
	const requested = {
		provider: typeof provider === "string" ? provider : String(provider ?? ""),
		modelId: typeof modelId === "string" ? modelId : String(modelId ?? ""),
	};
	const target: TargetReport = {
		kind: "own",
		sessionId: runtime.own.sessionId,
		sessionPath: runtime.own.sessionPath,
		requested: requested,
		resolution: { source: "in_memory" },
	};
	const ref: ModelRef = { provider: requested.provider.trim(), modelId: requested.modelId.trim() };
	if (!ref.provider || !ref.modelId) {
		return refusal(tool, "invalid_identifier", "a model needs a provider and a model id", target);
	}
	const resolved = runtime.resolveModel(ref);
	if (!resolved) {
		return refusal(tool, "model_unknown", "that provider/model is not in the model registry", target, {
			requested: ref,
		});
	}
	const beforeModel = modelRefOf(runtime.getModel());
	const beforeThinking = runtime.getThinkingLevel();
	if (sameModel(beforeModel, resolved)) {
		return {
			ok: true,
			tool,
			target,
			model: { before: beforeModel, requested: resolved, after: beforeModel },
			thinking: {
				before: beforeThinking,
				requested: null,
				after: beforeThinking,
				supported: runtime.supportedThinkingLevels(),
			},
			applied: "none",
			changed: false,
			records: { modelChangeEntryId: null, thinkingLevelEntryId: null },
			disk: { state: runtime.own.sessionPath ? "unknown" : "not_applicable" },
			effective: "next_request",
			partial: false,
			warnings: [],
		};
	}

	let authed = false;
	try {
		authed = await runtime.setOwnModel(resolved);
	} catch (error) {
		return refusal(tool, "apply_failed", "the model change failed", target, {
			cause: error instanceof Error ? error.message : "unknown",
		});
	}
	if (!authed) {
		return refusal(tool, "auth_missing", "that provider has no configured credentials", target, {
			requested: resolved,
		});
	}
	const afterModel = modelRefOf(runtime.getModel());
	const afterThinking = runtime.getThinkingLevel();
	const records = runtime.ownRecords();
	const modelChanged = sameModel(afterModel, resolved);
	const thinkingChanged = afterThinking !== beforeThinking;
	const applied: Applied = modelChanged ? (thinkingChanged ? "both" : "model") : "none";
	return {
		ok: true,
		tool,
		target,
		model: { before: beforeModel, requested: resolved, after: afterModel },
		thinking: {
			before: beforeThinking,
			requested: null,
			after: afterThinking,
			supported: runtime.supportedThinkingLevels(),
		},
		applied,
		changed: modelChanged,
		records,
		disk: { state: runtime.own.sessionPath ? "unknown" : "not_applicable" },
		effective: "next_request",
		partial: modelChanged && !records.modelChangeEntryId,
		warnings: [],
	};
}

/* -------------------------------------------------------------------------- */
/* a target session                                                             */
/* -------------------------------------------------------------------------- */

/** The target of a session-targeted request, once the binding is resolved. */
interface ResolvedTarget {
	binding: ResolvedBinding;
	sessionPath: string;
	lane: string | null;
}

/**
 * Resolve the target of a session-targeted request.
 *
 * The binding comes first (shape, then grammar), then the lane is resolved to a
 * session file, and only then is anything opened. A request that names the caller's
 * own session is resolved to the in-process path.
 */
async function resolveTarget(
	runtime: ParameterRuntime,
	tool: string,
	request: SessionRequest,
): Promise<{ ok: true; target: ResolvedTarget } | { ok: false; result: ParameterToolResult }> {
	const requested = {
		sessionId: typeof request.sessionId === "string" ? request.sessionId : undefined,
		sessionPath: typeof request.sessionPath === "string" ? request.sessionPath : undefined,
		lane: typeof request.lane === "string" ? request.lane : undefined,
	};
	const binding = resolveBinding(request);
	if (!binding.ok) {
		return {
			ok: false,
			result: refusal(tool, binding.failure.code, binding.failure.message, emptyTarget(requested)),
		};
	}

	let sessionPath = binding.binding.sessionPath;
	let lane: string | null = binding.binding.lane;
	if (binding.binding.kind === "lane") {
		const resolved = await runtime.resolveLane(binding.binding.lane as string);
		if (!resolved.ok) {
			return {
				ok: false,
				result: refusal(
					tool,
					resolved.failure.code as RefusalCode,
					resolved.failure.message,
					emptyTarget(requested),
					resolved.failure.detail,
				),
			};
		}
		sessionPath = resolved.lane.sessionPath;
		lane = binding.binding.lane;
	}

	return { ok: true, target: { binding: binding.binding, sessionPath: sessionPath as string, lane } };
}

/**
 * The target's own answer to "which session are you?".
 *
 * A target that answers with a different session id, or a different file, is not the
 * target the request named: the request is refused and nothing is changed.
 */
function identityMatches(
	state: Record<string, unknown>,
	binding: ResolvedBinding,
	sessionPath: string,
): { ok: true } | { ok: false; code: RefusalCode; message: string } {
	const stateId = typeof state.sessionId === "string" ? state.sessionId : null;
	if (!stateId) {
		return { ok: false, code: "no_session_file", message: "that session has no session id" };
	}
	if (stateId !== binding.sessionId) {
		return {
			ok: false,
			code: "session_id_mismatch",
			message: "that session is not the session the request named",
		};
	}
	const stateFile = typeof state.sessionFile === "string" ? state.sessionFile : null;
	if (stateFile && stateFile !== sessionPath) {
		return {
			ok: false,
			code: "session_identity_mismatch",
			message: "that session file is not the session file the request named",
		};
	}
	return { ok: true };
}

/** Read the record ids a target session gained, over the control channel. */
function recordsFromEntries(data: unknown): {
	modelChangeEntryId: string | null;
	thinkingLevelEntryId: string | null;
} {
	const out = { modelChangeEntryId: null as string | null, thinkingLevelEntryId: null as string | null };
	const entries = (data as { entries?: unknown })?.entries;
	if (!Array.isArray(entries)) return out;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as { type?: unknown; id?: unknown };
		if (typeof record.id !== "string") continue;
		if (record.type === "model_change") out.modelChangeEntryId = record.id;
		if (record.type === "thinking_level_change") out.thinkingLevelEntryId = record.id;
	}
	return out;
}

/** Classify an error pi reported for a command. */
function classifyCommandError(error: string | undefined): { code: RefusalCode; message: string } {
	const text = (error ?? "").toLowerCase();
	if (text.includes("no api key") || text.includes("auth") || text.includes("oauth")) {
		return { code: "auth_missing", message: "that provider has no configured credentials" };
	}
	if (text.includes("model not found")) {
		return { code: "model_unknown", message: "that provider/model is not in the model registry" };
	}
	return { code: "apply_failed", message: "the change failed" };
}

/**
 * Set the thinking level of an explicitly identified session.
 *
 * When the target is the caller's own session the change happens in the caller's own
 * process. Otherwise the target is reached over pi's RPC control channel: the target
 * session is opened, asked which session it is, and only then changed.
 */
export async function applySessionThinking(
	runtime: ParameterRuntime,
	tool: string,
	request: SessionRequest,
	level: unknown,
): Promise<ParameterToolResult> {
	const requested = {
		sessionId: typeof request.sessionId === "string" ? request.sessionId : undefined,
		sessionPath: typeof request.sessionPath === "string" ? request.sessionPath : undefined,
		lane: typeof request.lane === "string" ? request.lane : undefined,
	};
	if (!isThinkingLevel(level)) {
		return refusal(tool, "invalid_level", "that is not a thinking level pi accepts", emptyTarget(requested), {
			requestedLevel: typeof level === "string" ? level : String(level ?? ""),
		});
	}
	const resolved = await resolveTarget(runtime, tool, request);
	if (!resolved.ok) return resolved.result;
	const { binding, sessionPath, lane } = resolved.target;

	const target: TargetReport = {
		kind: "session",
		sessionId: binding.sessionId,
		sessionPath,
		requested,
		resolution: { source: lane ? "lane" : "session_file", ...(lane ? { lane } : {}) },
	};

	// The caller's own session: change it here, in this process.
	if (isOwnSession(binding, runtime.own) && runtime.own.sessionPath === sessionPath) {
		const own = await applyOwnThinking(runtime, tool, level);
		return {
			...own,
			target,
		};
	}

	let session: RpcSession;
	try {
		session = await runtime.openRemoteSession(sessionPath);
	} catch (error) {
		return refusal(tool, "target_not_reachable", "the target session could not be reached", target, {
			cause: error instanceof Error ? error.message : "unknown",
		});
	}
	try {
		const state = await session.getState();
		if (!state.ok) {
			const classified = classifyCommandError(state.error);
			return refusal(tool, classified.code, classified.message, target);
		}
		const stateData = (state.data ?? {}) as Record<string, unknown>;
		const identity = identityMatches(stateData, binding, sessionPath);
		if (!identity.ok) {
			return refusal(tool, identity.code, identity.message, target);
		}
		const beforeModel = modelRefOf(stateData.model);
		const beforeThinking = typeof stateData.thinkingLevel === "string" ? stateData.thinkingLevel : null;
		const alreadyThere = beforeThinking === level;

		let outcome: RpcOutcome;
		if (alreadyThere) {
			outcome = { ok: true };
		} else {
			outcome = await session.setThinkingLevel(level);
			if (!outcome.ok) {
				const classified = classifyCommandError(outcome.error);
				return refusal(tool, classified.code, classified.message, target);
			}
		}
		const after = await session.getState();
		const afterData = (after.ok ? (after.data ?? {}) : {}) as Record<string, unknown>;
		const afterThinking = typeof afterData.thinkingLevel === "string" ? afterData.thinkingLevel : null;
		const entries = await session.getEntries();
		const records = entries.ok
			? recordsFromEntries(entries.data)
			: { modelChangeEntryId: null, thinkingLevelEntryId: null };
		const changed = afterThinking === level && beforeThinking !== level;
		const warnings = ["the target session's running process keeps its current parameters until it resumes"];
		return {
			ok: true,
			tool,
			target,
			model: { before: beforeModel, requested: null, after: modelRefOf(afterData.model) },
			thinking: { before: beforeThinking, requested: level, after: afterThinking, supported: [] },
			applied: changed ? "thinking" : "none",
			changed,
			records,
			disk: { state: "unknown" },
			effective: "next_request",
			partial: changed && !records.thinkingLevelEntryId,
			warnings,
		};
	} finally {
		await session.close();
	}
}

/**
 * Set the model of an explicitly identified session.
 *
 * The same shape as the thinking variant: the target is identified first, asked who
 * it is, and only then changed. The model is resolved in the **target's** registry —
 * the control channel runs in the target's process, so the target decides whether it
 * knows the model.
 */
export async function applySessionModel(
	runtime: ParameterRuntime,
	tool: string,
	request: SessionRequest,
	provider: unknown,
	modelId: unknown,
): Promise<ParameterToolResult> {
	const requested = {
		sessionId: typeof request.sessionId === "string" ? request.sessionId : undefined,
		sessionPath: typeof request.sessionPath === "string" ? request.sessionPath : undefined,
		lane: typeof request.lane === "string" ? request.lane : undefined,
	};
	const ref: ModelRef = {
		provider: typeof provider === "string" ? provider.trim() : "",
		modelId: typeof modelId === "string" ? modelId.trim() : "",
	};
	if (!ref.provider || !ref.modelId) {
		return refusal(tool, "invalid_identifier", "a model needs a provider and a model id", emptyTarget(requested));
	}
	const resolved = await resolveTarget(runtime, tool, request);
	if (!resolved.ok) return resolved.result;
	const { binding, sessionPath, lane } = resolved.target;

	const target: TargetReport = {
		kind: "session",
		sessionId: binding.sessionId,
		sessionPath,
		requested,
		resolution: { source: lane ? "lane" : "session_file", ...(lane ? { lane } : {}) },
	};

	if (isOwnSession(binding, runtime.own) && runtime.own.sessionPath === sessionPath) {
		const own = await applyOwnModel(runtime, tool, ref.provider, ref.modelId);
		return { ...own, target };
	}

	let session: RpcSession;
	try {
		session = await runtime.openRemoteSession(sessionPath);
	} catch (error) {
		return refusal(tool, "target_not_reachable", "the target session could not be reached", target, {
			cause: error instanceof Error ? error.message : "unknown",
		});
	}
	try {
		const state = await session.getState();
		if (!state.ok) {
			const classified = classifyCommandError(state.error);
			return refusal(tool, classified.code, classified.message, target);
		}
		const stateData = (state.data ?? {}) as Record<string, unknown>;
		const identity = identityMatches(stateData, binding, sessionPath);
		if (!identity.ok) {
			return refusal(tool, identity.code, identity.message, target);
		}
		const beforeModel = modelRefOf(stateData.model);
		const beforeThinking = typeof stateData.thinkingLevel === "string" ? stateData.thinkingLevel : null;
		const alreadyThere = sameModel(beforeModel, ref);

		let outcome: RpcOutcome;
		if (alreadyThere) {
			outcome = { ok: true };
		} else {
			outcome = await session.setModel(ref.provider, ref.modelId);
			if (!outcome.ok) {
				const classified = classifyCommandError(outcome.error);
				return refusal(tool, classified.code, classified.message, target);
			}
		}
		const after = await session.getState();
		const afterData = (after.ok ? (after.data ?? {}) : {}) as Record<string, unknown>;
		const entries = await session.getEntries();
		const records = entries.ok
			? recordsFromEntries(entries.data)
			: { modelChangeEntryId: null, thinkingLevelEntryId: null };
		const afterModel = modelRefOf(afterData.model);
		const changed = sameModel(afterModel, ref) && !sameModel(beforeModel, ref);
		const warnings = ["the target session's running process keeps its current parameters until it resumes"];
		return {
			ok: true,
			tool,
			target,
			model: { before: beforeModel, requested: ref, after: afterModel },
			thinking: {
				before: beforeThinking,
				requested: null,
				after: typeof afterData.thinkingLevel === "string" ? afterData.thinkingLevel : null,
				supported: [],
			},
			applied: changed ? "model" : "none",
			changed,
			records,
			disk: { state: "unknown" },
			effective: "next_request",
			partial: changed && !records.modelChangeEntryId,
			warnings,
		};
	} finally {
		await session.close();
	}
}
