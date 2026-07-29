import type { AlphaDomainEvent, FailureCategory } from "./events.js";

export type AlphaMode = "explicit" | "acu-auto" | "acu-high";
export type TriggerReason =
  | "explicit_model"
  | "new_task"
  | "human_message"
  | "plan_started"
  | "plan_finished"
  | "repeated_failure"
  | "safety_refresh"
  | "reuse_route";

export type FailureCounter = {
  signature: string;
  category: FailureCategory;
  count: number;
  progressSinceLast: boolean;
};

export type SegmentState = {
  segmentId: string;
  phase: string;
  acceptedModelResponsesSinceJudge: number;
  planningActive: boolean;
  failureCounters: Record<string, FailureCounter>;
};

export type TriggerInput = {
  mode: AlphaMode;
  isNewTask: boolean;
  events: AlphaDomainEvent[];
  segment?: SegmentState;
  maxUnjudgedModelResponses?: number;
};

export type TriggerDecision = {
  runJudge: boolean;
  reason: TriggerReason;
  createSegment: boolean;
  phase: string;
  temporaryPhaseOverride: number;
  routeDirection: "any" | "hold_or_upgrade";
};

const CAPABILITY_FAILURES = new Set<FailureCategory>([
  "tool_usage_error",
  "execution_or_verification_failure",
]);

export function applyFailureEvidence(
  counters: Record<string, FailureCounter>,
  events: AlphaDomainEvent[],
): Record<string, FailureCounter> {
  const next = structuredClone(counters);
  for (const item of events) {
    if (item.type === "tool_result" && item.metadata.isError === false) {
      for (const counter of Object.values(next)) counter.progressSinceLast = true;
    }
    if (item.type !== "execution_failure" || !item.failureSignature || !item.failureCategory
      || !CAPABILITY_FAILURES.has(item.failureCategory)) continue;
    const existing = next[item.failureSignature];
    if (!existing || existing.progressSinceLast) {
      next[item.failureSignature] = {
        signature: item.failureSignature,
        category: item.failureCategory,
        count: 1,
        progressSinceLast: false,
      };
    } else {
      existing.count += 1;
    }
  }
  return next;
}

function decision(reason: TriggerReason, overrides: Partial<TriggerDecision> = {}): TriggerDecision {
  return {
    runJudge: reason !== "explicit_model" && reason !== "reuse_route",
    reason,
    createSegment: reason !== "explicit_model" && reason !== "reuse_route",
    phase: "execution",
    temporaryPhaseOverride: 0,
    routeDirection: "any",
    ...overrides,
  };
}

export function decideTrigger(input: TriggerInput): TriggerDecision {
  if (input.mode === "explicit") return decision("explicit_model", { createSegment: input.isNewTask });
  if (input.events.some((item) => item.type === "plan_finished")) {
    return decision("plan_finished", { phase: "execution" });
  }
  if (input.events.some((item) => item.type === "plan_started")) {
    return decision("plan_started", { phase: "planning", temporaryPhaseOverride: 88 });
  }
  if (input.isNewTask) return decision("new_task");
  if (input.events.some((item) => (
    item.type === "user_rejected"
    || (item.type === "human_message" && item.evidenceStrength === "high")
  ))) {
    return decision("human_message");
  }
  const counters = applyFailureEvidence(input.segment?.failureCounters ?? {}, input.events);
  if (Object.values(counters).some((counter) => counter.count >= 2 && !counter.progressSinceLast)) {
    return decision("repeated_failure", { phase: "recovery", routeDirection: "hold_or_upgrade" });
  }
  if ((input.segment?.acceptedModelResponsesSinceJudge ?? 0) >= (input.maxUnjudgedModelResponses ?? 16)) {
    return decision("safety_refresh", { phase: input.segment?.phase ?? "execution" });
  }
  return decision("reuse_route", {
    phase: input.segment?.phase ?? "execution",
    temporaryPhaseOverride: input.segment?.planningActive ? 88 : 0,
  });
}

export function incrementAcceptedResponse(segment: SegmentState, logicalResponseAccepted: boolean): SegmentState {
  if (!logicalResponseAccepted) return segment;
  return {
    ...segment,
    acceptedModelResponsesSinceJudge: segment.acceptedModelResponsesSinceJudge + 1,
  };
}
