import type { AlphaDomainEvent } from "./events.js";
import type { CanonicalEnvelope } from "./protocol/types.js";
import type { FailureCounter, TriggerDecision } from "./state-machine.js";
import { classifyToolCall } from "./tool-family.js";

export type WorkPhase = "planning" | "inspection" | "implementation" | "verification" | "recovery" | "general";

export type WorkPhaseDecision = {
  phase: WorkPhase;
  confidence: "high" | "medium" | "low";
  signals: string[];
  qualityTargetOffset: number;
  policyVersion: "acu-work-phase-policy-v1";
};

export type WorkPhaseInput = {
  envelope: CanonicalEnvelope;
  events: AlphaDomainEvent[];
  planningActive: boolean;
  failureCounters: Record<string, FailureCounter>;
  trigger: TriggerDecision;
};

const OFFSETS: Record<WorkPhase, number> = {
  recovery: 6,
  planning: 4,
  verification: 0,
  implementation: 0,
  inspection: -4,
  general: 0,
};

function result(phase: WorkPhase, signals: string[], confidence: WorkPhaseDecision["confidence"] = "high"): WorkPhaseDecision {
  return { phase, confidence, signals, qualityTargetOffset: OFFSETS[phase], policyVersion: "acu-work-phase-policy-v1" };
}

export function detectWorkPhase(input: WorkPhaseInput): WorkPhaseDecision {
  const { events } = input;
  if (input.trigger.reason === "repeated_failure") return result("recovery", ["trigger:repeated_failure"]);
  if (events.some((item) => item.type === "user_rejected")) return result("recovery", ["event:user_rejected"]);
  const repeated = Object.values(input.failureCounters).find((counter) => counter.count >= 2 && !counter.progressSinceLast);
  if (repeated) return result("recovery", [`failure:${repeated.category}:repeated_without_progress`]);
  const replanning = events.find((item) => item.type === "plan_updated" && item.metadata.replanning === true);
  if (replanning) return result("recovery", ["event:explicit_replanning"]);

  const planEvents = events.filter((item) => item.type === "plan_started" || item.type === "plan_updated");
  if (planEvents.length > 0) return result("planning", planEvents.map((item) => `event:${item.type}`));
  if (input.planningActive || input.envelope.planning.started) {
    return result("planning", [input.planningActive ? "metadata:planning_active" : "protocol:planning_fingerprint"]);
  }

  const newestResult = events
    .filter((item) => item.type === "tool_result")
    .sort((left, right) => (right.sourceIndex ?? -1) - (left.sourceIndex ?? -1))[0];
  if (!newestResult?.toolCallId) return result("general", ["fallback:no_incremental_tool_result"], "low");
  const call = input.envelope.toolCalls.find((candidate) => candidate.id === newestResult.toolCallId);
  if (!call) return result("general", ["fallback:unmatched_tool_result"], "low");
  const family = classifyToolCall(call);
  if (family === "verification") return result("verification", [`tool:${call.name}`]);
  if (family === "implementation") return result("implementation", [`tool:${call.name}`]);
  if (family === "inspection") return result("inspection", [`tool:${call.name}`]);
  return result("general", [`fallback:unknown_tool:${call.name}`], "low");
}
