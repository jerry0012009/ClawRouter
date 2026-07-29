import type { AcuVisibleMessage } from "../acu/types.js";
import type { CanonicalEnvelope } from "./protocol/types.js";
import type { TriggerReason } from "./state-machine.js";
import { extractWebIntentEvidence } from "./web-intent.js";

export type AlphaJudgeStateContext = {
  sessionId: string;
  taskId: string;
  segmentId?: string;
  rootGoalText?: string;
  phase: string;
  trigger: TriggerReason;
  currentPlan?: unknown;
  previousEvaluation?: unknown;
  previousRoute?: unknown;
  currentExecutionProfile?: unknown;
  recentEvents?: unknown[];
  acceptedModelResponsesSinceJudge: number;
  taskBaseQualityTarget: number;
  capabilityEscalationFloor: number;
  temporaryPhaseOverride: number;
};

export type AlphaJudgeContextEnvelope = {
  schemaVersion: "acu-judge-context-v1";
  nativeProtocol: CanonicalEnvelope["protocol"];
  nativeInstructions: unknown;
  nativeHistory: unknown[];
  nativeTools: unknown[];
  deterministicWebIntentEvidence: string[];
  state: AlphaJudgeStateContext;
};

export function buildAlphaJudgeContext(
  envelope: CanonicalEnvelope,
  state: AlphaJudgeStateContext,
): { envelope: AlphaJudgeContextEnvelope; messages: AcuVisibleMessage[]; tools: unknown[] } {
  const context: AlphaJudgeContextEnvelope = {
    schemaVersion: "acu-judge-context-v1",
    nativeProtocol: envelope.protocol,
    nativeInstructions: envelope.instructions,
    nativeHistory: envelope.history,
    nativeTools: envelope.tools,
    deterministicWebIntentEvidence: extractWebIntentEvidence(envelope, state.rootGoalText),
    state,
  };
  return {
    envelope: context,
    messages: [{ role: "user", content: context }],
    tools: envelope.tools,
  };
}
