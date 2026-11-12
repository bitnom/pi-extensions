// pi-parameter-tools — set the model and the thinking level of a pi session.
//
// Four tools:
//
//   set_own_thinking      the calling agent's thinking/reasoning effort
//   set_own_model         the calling agent's provider/model
//   set_session_thinking  an explicitly identified pi session's thinking effort
//   set_session_model     an explicitly identified pi session's provider/model
//
// The own tools change the caller's own session, in the caller's own process, through
// pi's own session-control methods.
//
// The session-targeted tools name their target explicitly: a session id **and** one
// unambiguous binding (a session path or a herdr lane). A session id alone is never
// enough, because ids can repeat across session files. The target is reached over
// pi's own RPC control channel — the documented way to drive a session's parameters
// from outside that session's process — and the target is asked which session it is
// before anything is changed.
//
// What this package does NOT do: write a session file by hand, type into another
// pane's terminal, relay a slash command, edit settings, or restart anything. The
// change is made by pi's own setter, in a pi process, for one named session.

import { spawn } from "node:child_process";
import { getSupportedThinkingLevels, type JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readHerdrEnvironment, resolveLaneSession } from "./herdr.ts";
import { type ModelRef, type ParameterToolResult, summarise, THINKING_LEVELS } from "./params.ts";
import { openRpcSession, type RpcChild, type SpawnFn } from "./rpc.ts";
import {
	applyOwnModel,
	applyOwnThinking,
	applySessionModel,
	applySessionThinking,
	type ParameterRuntime,
} from "./target.ts";

const MUTATION_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: false,
} as const;

const RESULT_SCHEMA = Type.Object(
	{
		ok: Type.Boolean(),
		tool: Type.String(),
		target: Type.Object({}, { additionalProperties: true }),
		model: Type.Object({}, { additionalProperties: true }),
		thinking: Type.Object({}, { additionalProperties: true }),
		applied: Type.String(),
		changed: Type.Boolean(),
		records: Type.Object({}, { additionalProperties: true }),
		disk: Type.Object({}, { additionalProperties: true }),
		effective: Type.String(),
		partial: Type.Boolean(),
		warnings: Type.Array(Type.String()),
		refusal: Type.Optional(Type.Object({}, { additionalProperties: true })),
	},
	{ additionalProperties: true },
);

const TARGET_PARAMETERS = {
	sessionId: Type.String({
		description: "The target session's id, exactly as the target reports it.",
	}),
	sessionPath: Type.Optional(
		Type.String({
			description: "Absolute path of the target session file (ends in .jsonl). Give this OR a lane.",
		}),
	),
	lane: Type.Optional(
		Type.String({
			description: "The herdr lane that runs the target session. Give this OR a session path.",
		}),
	),
};

function modelRef(model: unknown): ModelRef | null {
	if (!model || typeof model !== "object") return null;
	const record = model as { provider?: unknown; id?: unknown };
	if (typeof record.provider !== "string" || typeof record.id !== "string") return null;
	return { provider: record.provider, modelId: record.id };
}

const spawnPi: SpawnFn = (command, args, options) =>
	spawn(command, args, { stdio: options.stdio }) as unknown as RpcChild;

/** The record ids the own session's branch gained, if any. */
function ownRecords(ctx: ExtensionContext): {
	modelChangeEntryId: string | null;
	thinkingLevelEntryId: string | null;
} {
	const out = { modelChangeEntryId: null as string | null, thinkingLevelEntryId: null as string | null };
	let branch: unknown[] = [];
	try {
		branch = (ctx.sessionManager.getBranch() ?? []) as unknown[];
	} catch {
		return out;
	}
	for (const entry of branch) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as { type?: unknown; id?: unknown };
		if (typeof record.id !== "string") continue;
		if (record.type === "model_change") out.modelChangeEntryId = record.id;
		if (record.type === "thinking_level_change") out.thinkingLevelEntryId = record.id;
	}
	return out;
}

/** The runtime the tools work against: the caller's own session, plus the reach. */
function makeRuntime(pi: ExtensionAPI, ctx: ExtensionContext): ParameterRuntime {
	return {
		own: {
			sessionId: ctx.sessionManager.getSessionId() ?? null,
			sessionPath: ctx.sessionManager.getSessionFile() ?? null,
			model: modelRef(ctx.model),
			thinkingLevel: pi.getThinkingLevel() ?? null,
		},
		getModel: () => modelRef(ctx.model),
		getThinkingLevel: () => pi.getThinkingLevel() ?? null,
		supportedThinkingLevels: () => {
			const model = ctx.model;
			if (!model) return [...THINKING_LEVELS];
			return getSupportedThinkingLevels(model);
		},
		resolveModel: (ref) => {
			const found = ctx.modelRegistry.find(ref.provider, ref.modelId);
			return found ? { provider: found.provider, modelId: found.id } : null;
		},
		setOwnModel: async (ref) => {
			const found = ctx.modelRegistry.find(ref.provider, ref.modelId);
			if (!found) return false;
			return pi.setModel(found);
		},
		setOwnThinkingLevel: (level) => {
			pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
		},
		ownRecords: () => ownRecords(ctx),
		openRemoteSession: (sessionPath) => openRpcSession({ spawn: spawnPi, sessionPath, timeoutMs: 30_000 }),
		resolveLane: async (lane) =>
			resolveLaneSession(
				lane,
				async (command, args, options) => {
					const result = await pi.exec(command, args, { timeout: options.timeoutMs });
					return { code: result.code, stdout: result.stdout, stderr: result.stderr, killed: result.killed };
				},
				readHerdrEnvironment(process.env as Record<string, string | undefined>),
			),
	};
}

function toolResult(result: ParameterToolResult) {
	return {
		content: [{ type: "text" as const, text: summarise(result) }],
		details: result,
		structuredContent: result as unknown as JsonValue,
		isError: !result.ok,
	};
}

export default function parameterTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "set_own_thinking",
		label: "Set Own Thinking",
		description:
			"Set the calling agent's thinking/reasoning effort for this session. Levels: off, minimal, low, medium, high, xhigh, max. A level the current model does not support is refused, not clamped. Same level again is a no-op.",
		promptSnippet: "Set this session's thinking/reasoning effort",
		promptGuidelines: [
			"Use set_own_thinking to change this session's reasoning effort; use set_session_thinking for another session.",
			"Read the returned before/after; a level the model does not support comes back as level_unsupported.",
		],
		parameters: Type.Object({
			level: Type.String({ description: "off | minimal | low | medium | high | xhigh | max" }),
		}),
		annotations: MUTATION_ANNOTATIONS,
		executionMode: "sequential",
		outputSchema: RESULT_SCHEMA,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return toolResult(await applyOwnThinking(makeRuntime(pi, ctx), "set_own_thinking", params.level));
		},
	});

	pi.registerTool({
		name: "set_own_model",
		label: "Set Own Model",
		description:
			"Set the calling agent's provider/model for this session. The provider and model id must be a model pi's registry knows. The same model again is a no-op. The new model takes effect on the next request.",
		promptSnippet: "Set this session's provider and model",
		promptGuidelines: [
			"Use set_own_model to change this session's model; use set_session_model for another session.",
			"An unknown model comes back as model_unknown and a provider without credentials as auth_missing.",
		],
		parameters: Type.Object({
			provider: Type.String({ description: "The provider id, e.g. anthropic." }),
			modelId: Type.String({ description: "The model id within that provider." }),
		}),
		annotations: MUTATION_ANNOTATIONS,
		executionMode: "sequential",
		outputSchema: RESULT_SCHEMA,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return toolResult(await applyOwnModel(makeRuntime(pi, ctx), "set_own_model", params.provider, params.modelId));
		},
	});

	pi.registerTool({
		name: "set_session_thinking",
		label: "Set Session Thinking",
		description:
			"Set the thinking/reasoning effort of an explicitly identified pi session. Name the session id and one unambiguous binding: a session file path OR a herdr lane. The target is asked which session it is before anything changes; a target that does not answer with the named session is refused and nothing is changed.",
		promptSnippet: "Set another pi session's thinking/reasoning effort by explicit target",
		promptGuidelines: [
			"Give both a sessionId and exactly one of sessionPath or lane; a session id alone is refused as ambiguous.",
			"A refusal names the reason (session_id_mismatch, session_identity_mismatch, target_lane_unknown, ...); nothing is changed on a refusal.",
		],
		parameters: Type.Object({
			...TARGET_PARAMETERS,
			level: Type.String({ description: "off | minimal | low | medium | high | xhigh | max" }),
		}),
		annotations: MUTATION_ANNOTATIONS,
		executionMode: "sequential",
		outputSchema: RESULT_SCHEMA,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return toolResult(
				await applySessionThinking(
					makeRuntime(pi, ctx),
					"set_session_thinking",
					{ sessionId: params.sessionId, sessionPath: params.sessionPath, lane: params.lane },
					params.level,
				),
			);
		},
	});

	pi.registerTool({
		name: "set_session_model",
		label: "Set Session Model",
		description:
			"Set the provider/model of an explicitly identified pi session. Name the session id and one unambiguous binding: a session file path OR a herdr lane. The target is asked which session it is before anything changes; a target that does not answer with the named session is refused and nothing is changed.",
		promptSnippet: "Set another pi session's provider and model by explicit target",
		promptGuidelines: [
			"Give both a sessionId and exactly one of sessionPath or lane; a session id alone is refused as ambiguous.",
			"The model is resolved in the target's own registry: an unknown model comes back as model_unknown.",
		],
		parameters: Type.Object({
			...TARGET_PARAMETERS,
			provider: Type.String({ description: "The provider id, e.g. anthropic." }),
			modelId: Type.String({ description: "The model id within that provider." }),
		}),
		annotations: MUTATION_ANNOTATIONS,
		executionMode: "sequential",
		outputSchema: RESULT_SCHEMA,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return toolResult(
				await applySessionModel(
					makeRuntime(pi, ctx),
					"set_session_model",
					{ sessionId: params.sessionId, sessionPath: params.sessionPath, lane: params.lane },
					params.provider,
					params.modelId,
				),
			);
		},
	});
}
