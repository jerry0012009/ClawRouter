import { canonicalHash, record } from "./protocol/common.js";
import type { CanonicalEnvelope, CanonicalToolCall, CanonicalToolResult } from "./protocol/types.js";

export const ALPHA_EVENT_TYPES = [
  "human_message",
  "tool_call",
  "tool_result",
  "plan_started",
  "plan_updated",
  "plan_finished",
  "execution_failure",
  "user_rejected",
  "provider_error",
  "retry_attempt",
] as const;

export type AlphaEventType = (typeof ALPHA_EVENT_TYPES)[number];
export type FailureCategory =
  | "provider_error"
  | "protocol_or_compatibility_error"
  | "environment_or_permission_error"
  | "tool_usage_error"
  | "execution_or_verification_failure";

export type AlphaDomainEvent = {
  type: AlphaEventType;
  hash: string;
  evidenceStrength: "high" | "candidate";
  sourceIndex?: number;
  toolCallId?: string;
  failureCategory?: FailureCategory;
  failureSignature?: string;
  metadata: Record<string, unknown>;
};

export type EventExtractionState = {
  previousHistoryLength: number;
  planningActive: boolean;
  activePlanHash?: string;
  activePlanComplete?: boolean;
};

const REJECTION_PATTERN = /\b(?:redo|wrong|not satisfied|not what i asked|try again)\b|重做|还是不对|不满意|理解错|重新做/i;
const PROVIDER_PATTERN = /\b(?:429|rate.?limit|overload|503|502|provider|upstream|gateway timeout|connection reset|econnreset)\b/i;
const ENVIRONMENT_PATTERN = /\b(?:permission denied|eacces|command not found|not recognized|missing dependency|no space left|address already in use|environment variable|enoent)\b/i;
const VERIFICATION_PATTERN = /\b(?:test|build|typecheck|compile|assert|expected|failed|failure|error)\b/i;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function event(type: AlphaEventType, evidence: unknown, fields: Partial<AlphaDomainEvent> = {}): AlphaDomainEvent {
  return {
    type,
    hash: canonicalHash({ version: "alpha-event-v1", type, evidence }),
    evidenceStrength: "high",
    metadata: {},
    ...fields,
  };
}

function toolResultText(result: CanonicalToolResult): string {
  return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
}

export function classifyToolFailure(result: CanonicalToolResult, toolName?: string): FailureCategory | undefined {
  if (!result.isError) return undefined;
  const text = toolResultText(result);
  if (PROVIDER_PATTERN.test(text)) return "provider_error";
  if (ENVIRONMENT_PATTERN.test(text)) return "environment_or_permission_error";
  if (VERIFICATION_PATTERN.test(text) || /test|build|typecheck/i.test(toolName ?? "")) {
    return "execution_or_verification_failure";
  }
  return "tool_usage_error";
}

function normalizeFailureCore(value: string): string {
  return value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<uuid>")
    .replace(/\b(?:req|trace|request)[-_ ]?id[:= ]+[A-Za-z0-9._-]+/gi, "request_id:<id>")
    .replace(/\/tmp\/[A-Za-z0-9._/-]+/g, "/tmp/<path>")
    .replace(/\b\d+(?:\.\d+)?ms\b/gi, "<duration>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
}

export function failureSignature(
  category: FailureCategory,
  result: CanonicalToolResult,
  tool?: CanonicalToolCall,
): string {
  return canonicalHash({
    version: "failure-signature-v1",
    category,
    tool: tool?.name ?? "unknown",
    core: normalizeFailureCore(toolResultText(result)),
  });
}

function planIsComplete(call: CanonicalToolCall): boolean {
  const input = record(call.input);
  const plan = Array.isArray(input?.plan) ? input.plan : [];
  return plan.length > 0 && plan.every((item) => {
    const status = record(item)?.status;
    return status === "completed";
  });
}

function isExecutionTool(call: CanonicalToolCall): boolean {
  if (/(?:edit|write|patch|apply_patch|test|build|typecheck)/i.test(call.name)) return true;
  if (call.name !== "exec_command") return false;
  const command = typeof record(call.input)?.cmd === "string" ? String(record(call.input)?.cmd) : "";
  return /(?:^|[;&|\n]\s*)(?:apply_patch\b|npm\s+(?:run\s+)?(?:test|build|typecheck)\b|node\s+--test\b)/i.test(command);
}

export function extractIncrementalEvents(
  envelope: CanonicalEnvelope,
  state: EventExtractionState,
): AlphaDomainEvent[] {
  const from = state.previousHistoryLength;
  const events: AlphaDomainEvent[] = [];
  for (const human of envelope.humanCandidates.filter((candidate) => candidate.sourceIndex >= from)) {
    events.push(event("human_message", { text: human.text, sourceIndex: human.sourceIndex }, {
      sourceIndex: human.sourceIndex,
      evidenceStrength: human.confidence,
      metadata: { text: human.text },
    }));
    if (REJECTION_PATTERN.test(human.text)) {
      events.push(event("user_rejected", { text: human.text, sourceIndex: human.sourceIndex }, {
        sourceIndex: human.sourceIndex,
        evidenceStrength: "high",
        metadata: { text: human.text },
      }));
    }
  }
  const calls = envelope.toolCalls.filter((call) => call.sourceIndex >= from);
  const results = envelope.toolResults.filter((result) => result.sourceIndex >= from);
  for (const call of calls) {
    events.push(event("tool_call", call, {
      sourceIndex: call.sourceIndex,
      toolCallId: call.id,
      metadata: { name: call.name, input: call.input },
    }));
    if (call.name === "update_plan") {
      const planHash = canonicalHash(call.input);
      const type = state.planningActive ? "plan_updated" : "plan_started";
      events.push(event(type, { id: call.id, planHash }, {
        sourceIndex: call.sourceIndex,
        toolCallId: call.id,
        metadata: { planHash, complete: planIsComplete(call) },
      }));
    }
    if (call.name === "ExitPlanMode") {
      events.push(event("plan_finished", { id: call.id, name: call.name }, {
        sourceIndex: call.sourceIndex,
        toolCallId: call.id,
        metadata: { client: "claude-code" },
      }));
    }
  }
  if (state.planningActive) {
    const completedPlan = [...calls].reverse().find((call) => call.name === "update_plan" && planIsComplete(call));
    const executionCall = calls.find(isExecutionTool);
    const completionEstablished = completedPlan !== undefined || state.activePlanComplete === true;
    if (completionEstablished && executionCall
      && (!completedPlan || executionCall.sourceIndex >= completedPlan.sourceIndex)) {
      events.push(event("plan_finished", { plan: completedPlan?.id ?? state.activePlanHash, execution: executionCall.id }, {
        sourceIndex: executionCall.sourceIndex,
        toolCallId: executionCall.id,
        metadata: { client: "codex", executionTool: executionCall.name },
      }));
    }
  }
  for (const result of results) {
    events.push(event("tool_result", result, {
      sourceIndex: result.sourceIndex,
      toolCallId: result.toolCallId,
      metadata: { isError: result.isError, content: result.content },
    }));
    const call = envelope.toolCalls.find((candidate) => candidate.id === result.toolCallId);
    const category = classifyToolFailure(result, call?.name);
    if (category === "provider_error") {
      events.push(event("provider_error", { result, category }, {
        sourceIndex: result.sourceIndex,
        toolCallId: result.toolCallId,
        failureCategory: category,
        metadata: { content: result.content },
      }));
    } else if (category) {
      const signature = failureSignature(category, result, call);
      events.push(event("execution_failure", {
        signature,
        sourceIndex: result.sourceIndex,
        toolCallId: result.toolCallId,
      }, {
        sourceIndex: result.sourceIndex,
        toolCallId: result.toolCallId,
        failureCategory: category,
        failureSignature: signature,
        metadata: { content: result.content },
      }));
    }
  }
  if (!state.planningActive && envelope.planning.started && !events.some((item) => item.type === "plan_started")) {
    events.push(event("plan_started", envelope.planning.evidence, {
      metadata: {
        signalFamily: envelope.planning.signalFamily,
        fingerprintVersion: envelope.planning.fingerprintVersion,
      },
    }));
  }
  return events;
}
