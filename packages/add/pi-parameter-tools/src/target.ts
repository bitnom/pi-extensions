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
import { isHeldPlace } from "./holds.ts";
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

/**
 * Why a session this package cannot reach is refused.
 *
 * pi 1.5.0 exposes session control to the process that owns the session: the
 * ExtensionAPI's `setModel` / `setThinkingLevel`, and the RPC mode's `set_model` /
 * `set_thinking_level` — and the RPC channel belongs to the **parent** of an
 * RPC-mode child, over that child's stdin. There is no attach path, no socket, no
 * listener and no cross-process session control in pi.
 *
 * So a session running in another process cannot be changed from here. This is the
 * capability that is missing, and it is reported as a capability, not as a policy:
 * the target is named and identified, and the refusal says what would be needed.
 */
export const CAPABILITY_MISSING =
	"that session runs in another process, and pi exposes no supported channel to it: " +
	"session control (setModel, setThinkingLevel) is available only to the process that " +
	"owns the session, and the RPC channel belongs to the parent of an RPC-mode child";

/** What the caller would have to build for the cross-session case to work. */
export const CAPABILITY_RECEIVER =
	"an in-process receiver in the target lane (the same package, loaded there, applying " +
	"the change with its own session-control methods) plus a delivery channel to it";

/** What the caller can do to its own session. */
export interface ParameterRuntime {
	own: {
		sessionId: string | null;
		sessionPath: string | null;
		model: ModelRef | null;
		thinkingLevel: string | null;
	};
	getModel(): Promise<ModelRef | null>;
	getThinkingLevel(): Promise<string | null>;
	/** The thinking levels the current model supports. */
	supportedThinkingLevels(): string[];
	/** Resolve a provider/model pair in pi's model registry. Null when it is unknown. */
	resolveModel(ref: ModelRef): Promise<ModelRef | null>;
	/** Change the caller's own session's model. False when the provider has no auth. */
	setOwnModel(ref: ModelRef): Promise<boolean>;
	/** Change the caller's own session's thinking level. */
	setOwnThinkingLevel(level: string): Promise<void>;
	/** The record ids the own session's branch gained, if any. */
	ownRecords(): Promise<{ modelChangeEntryId: string | null; thinkingLevelEntryId: string | null }>;
	/** Resolve a herdr lane to the session behind it. */
	resolveLane(lane: string): Promise<HerdrLaneResult>;
	/** The session id recorded in a session file's header, or null when there is none. */
	readSessionHeaderId(sessionPath: string): Promise<string | null>;
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
	const before = await runtime.getThinkingLevel();
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
	if (!alreadyThere) await runtime.setOwnThinkingLevel(level);
	const after = await runtime.getThinkingLevel();
	const records = await runtime.ownRecords();

	const changed = !alreadyThere && after === level;
	return {
		ok: true,
		tool,
		target,
		model: {
			before: modelRefOf(await runtime.getModel()),
			requested: null,
			after: modelRefOf(await runtime.getModel()),
		},
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
	const resolved = await runtime.resolveModel(ref);
	if (!resolved) {
		return refusal(tool, "model_unknown", "that provider/model is not in the model registry", target, {
			requested: ref,
		});
	}
	const beforeModel = modelRefOf(await runtime.getModel());
	const beforeThinking = await runtime.getThinkingLevel();
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
	const afterModel = modelRefOf(await runtime.getModel());
	const afterThinking = await runtime.getThinkingLevel();
	const records = await runtime.ownRecords();
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
		// The fleet's holds: a lane in a held workspace or a reserved tab is not
		// changed, whoever asks.
		if (isHeldPlace({ paneId: resolved.lane.paneId })) {
			return {
				ok: false,
				result: refusal(tool, "held_lane", "that lane is in a held or reserved place", emptyTarget(requested), {
					held: true,
					lane: binding.binding.lane,
				}),
			};
		}
	}

	// The session file's own header names the session it holds. That is the last
	// check before anything is changed: a file that holds a different session is not
	// the session the request named, and the duplicate-id case is closed here.
	const headerId = await runtime.readSessionHeaderId(sessionPath as string);
	if (!headerId) {
		return {
			ok: false,
			result: refusal(tool, "no_session_file", "that session file has no session id", emptyTarget(requested), {
				sessionPath,
			}),
		};
	}
	if (headerId !== binding.binding.sessionId) {
		return {
			ok: false,
			result: refusal(
				tool,
				"session_id_mismatch",
				"that session file holds a different session than the one requested",
				emptyTarget(requested),
				{ sessionPath, requestedSessionId: binding.binding.sessionId, sessionFileId: headerId },
			),
		};
	}

	return { ok: true, target: { binding: binding.binding, sessionPath: sessionPath as string, lane } };
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

	// Another session. Its parameters live in the process that owns it, and pi
	// exposes no channel from here into that process. Say so, and change nothing.
	return unreachableTarget(tool, target, binding.sessionId, sessionPath);
}

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

	return unreachableTarget(tool, target, binding.sessionId, sessionPath);
}

/**
 * The refusal for a session that runs in another process.
 *
 * It names the session that was identified, the session file it lives in, and the
 * capability that is missing — so the caller learns what would have to be built, and
 * the refusal is not mistaken for a policy decision.
 */
function unreachableTarget(
	tool: string,
	target: TargetReport,
	sessionId: string,
	sessionPath: string,
): ParameterToolResult {
	return refusal(tool, "target_not_reachable", CAPABILITY_MISSING, target, {
		capability: "cross_process_session_control",
		requires: CAPABILITY_RECEIVER,
		targetSessionId: sessionId,
		targetSessionPath: sessionPath,
		changed: false,
	});
}
