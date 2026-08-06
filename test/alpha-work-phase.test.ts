import { describe, expect, it } from "vitest";
import { detectWorkPhase } from "../src/alpha/work-phase.js";
import { extractIncrementalEvents, type AlphaDomainEvent } from "../src/alpha/events.js";
import { normalizeMessagesRequest } from "../src/alpha/protocol/messages.js";
import type { CanonicalEnvelope } from "../src/alpha/protocol/types.js";
import { decideTrigger, type FailureCounter } from "../src/alpha/state-machine.js";

function envelope(name = "unknown", command?: string): CanonicalEnvelope {
  return {
    protocol: "responses", requestedModel: "acu-auto", stream: true, instructions: "", history: [], tools: [],
    requiredToolTypes: [], clientDeclaredWebTool: false, hostedWebRequired: false, webIntent: "not_required",
    webIntentConfidence: 1, webIntentReason: "test", webIntentEvidence: [], webActuallyInvoked: false,
    humanCandidates: [], toolCalls: [{ id: "call-new", name, input: command ? { cmd: command } : {}, sourceIndex: 10 }],
    toolResults: [{ toolCallId: "call-new", content: "ok", isError: false, sourceIndex: 11 }],
    planning: { started: false, finished: false, updated: false, evidence: [] }, containsThinking: false,
    thinkingSignatures: [], historyHash: "hash", raw: {},
  };
}

function event(type: AlphaDomainEvent["type"], fields: Partial<AlphaDomainEvent> = {}): AlphaDomainEvent {
  return { type, hash: `${type}-hash`, evidenceStrength: "high", metadata: {}, ...fields };
}

function phase(name = "unknown", options: { events?: AlphaDomainEvent[]; planning?: boolean; failures?: Record<string, FailureCounter>; trigger?: ReturnType<typeof decideTrigger>; command?: string } = {}) {
  const events = options.events ?? [event("tool_result", { toolCallId: "call-new", sourceIndex: 11, metadata: { isError: false } })];
  return detectWorkPhase({ envelope: envelope(name, options.command), events, planningActive: options.planning ?? false,
    failureCounters: options.failures ?? {}, trigger: options.trigger ?? decideTrigger({ mode: "acu-auto", isNewTask: false, events }) });
}

function messagesPhase(toolName: string, command = "ok") {
  const messagesEnvelope = normalizeMessagesRequest({ model: "acu-auto", messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "messages-tool", name: toolName,
      input: toolName === "Bash" ? { command } : {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "messages-tool", content: "ok" }] },
  ], tools: [{ name: toolName, input_schema: { type: "object" } }] });
  const events = extractIncrementalEvents(messagesEnvelope, { previousHistoryLength: 0, planningActive: false });
  return detectWorkPhase({ envelope: messagesEnvelope, events, planningActive: false, failureCounters: {},
    trigger: decideTrigger({ mode: "acu-auto", isNewTask: false, events }) });
}

describe("deterministic Work Phase detector", () => {
  it.each([
    ["Read", "inspection", -4], ["Grep", "inspection", -4], ["Glob", "inspection", -4],
    ["apply_patch", "implementation", 0], ["Edit", "implementation", 0], ["Write", "implementation", 0],
    ["test", "verification", 0], ["build", "verification", 0], ["typecheck", "verification", 0],
    ["unknown", "general", 0],
  ])("classifies %s as %s", (tool, expected, offset) => {
    expect(phase(tool)).toMatchObject({ phase: expected, qualityTargetOffset: offset, policyVersion: "acu-work-phase-policy-v1" });
  });

  it("classifies Codex update_plan and Claude planning metadata", () => {
    expect(phase("unknown", { events: [event("plan_started")] })).toMatchObject({ phase: "planning", qualityTargetOffset: 4 });
    expect(phase("unknown", { planning: true, events: [] })).toMatchObject({ phase: "planning", qualityTargetOffset: 4 });
  });

  it("gives explicit replanning recovery priority", () => {
    expect(phase("update_plan", {
      events: [event("plan_updated", { metadata: { replanning: true } })],
      planning: true,
    })).toMatchObject({ phase: "recovery", qualityTargetOffset: 6 });
  });

  it("keeps first test failure in verification and promotes repeated capability failure", () => {
    const failure = event("execution_failure", { failureCategory: "execution_or_verification_failure", failureSignature: "same" });
    const toolResult = event("tool_result", { toolCallId: "call-new", sourceIndex: 11, metadata: { isError: true } });
    expect(phase("test", { events: [toolResult, failure] }).phase).toBe("verification");
    expect(phase("test", { events: [toolResult, failure], failures: { same: { signature: "same", category: "execution_or_verification_failure", count: 2, progressSinceLast: false } },
      trigger: decideTrigger({ mode: "acu-auto", isNewTask: false, events: [failure], segment: { segmentId: "s", phase: "execution", acceptedModelResponsesSinceJudge: 0, planningActive: false,
        failureCounters: { same: { signature: "same", category: "execution_or_verification_failure", count: 1, progressSinceLast: false } } } }) })).toMatchObject({ phase: "recovery", qualityTargetOffset: 6 });
  });

  it("never treats provider 503 as recovery", () => {
    expect(phase("test", { events: [event("provider_error", { failureCategory: "provider_error" }), event("tool_result", { toolCallId: "call-new", sourceIndex: 11, metadata: { isError: true } })] }).phase).toBe("verification");
  });

  it("uses only incremental results and recovery priority", () => {
    const old = envelope("Read");
    old.toolCalls.unshift({ id: "old", name: "Read", input: {}, sourceIndex: 1 });
    old.toolResults.unshift({ toolCallId: "old", content: "old", isError: false, sourceIndex: 2 });
    expect(detectWorkPhase({ envelope: old, events: [], planningActive: false, failureCounters: {}, trigger: decideTrigger({ mode: "acu-auto", isNewTask: false, events: [] }) }).phase).toBe("general");
    expect(phase("Read", { events: [event("plan_started"), event("user_rejected")] }).phase).toBe("recovery");
  });

  it("recognizes explicit shell families and falls back safely", () => {
    expect(phase("exec_command", { command: "git status" }).phase).toBe("inspection");
    expect(phase("exec_command", { command: "npm run test" }).phase).toBe("verification");
    expect(phase("exec_command", { command: "some-custom-command" }).phase).toBe("general");
  });

  it.each([["Read", "inspection"], ["Grep", "inspection"], ["Glob", "inspection"],
    ["Edit", "implementation"], ["Write", "implementation"], ["apply_patch", "implementation"]])
  ("classifies native Messages %s results as %s without Claude headers", (tool, expected) => {
    expect(messagesPhase(tool).phase).toBe(expected);
  });

  it.each(["npm test", "npm run build", "npm run lint", "npm run typecheck"])
  ("classifies native Messages shell result '%s' as verification", (command) => {
    expect(messagesPhase("Bash", command).phase).toBe("verification");
  });

  it("recognizes Messages planning, plan exit and user-requested recovery structurally", () => {
    const reminder = `<system-reminder>Plan mode is active.\n## Plan File Info:\nPlan file.\n## Plan Workflow\nInspect.</system-reminder>`;
    const planEnvelope = normalizeMessagesRequest({ system: "You are a coding agent.",
      messages: [{ role: "user", content: reminder }],
      tools: ["Read", "TaskCreate", "TaskUpdate", "Write", "Edit"].map((name) => ({ name })) });
    const planEvents = extractIncrementalEvents(planEnvelope, { previousHistoryLength: 0, planningActive: false });
    expect(detectWorkPhase({ envelope: planEnvelope, events: planEvents, planningActive: false,
      failureCounters: {}, trigger: decideTrigger({ mode: "acu-auto", isNewTask: false, events: planEvents }) }).phase).toBe("planning");
    const exitEnvelope = normalizeMessagesRequest({ messages: [{ role: "assistant", content: [
      { type: "tool_use", id: "exit", name: "ExitPlanMode", input: {} }] }] });
    expect(extractIncrementalEvents(exitEnvelope, { previousHistoryLength: 0, planningActive: true })
      .some((item) => item.type === "plan_finished")).toBe(true);
    const rejectedEnvelope = normalizeMessagesRequest({ messages: [{ role: "user", content: "还是不对，请重做" }] });
    const rejectedEvents = extractIncrementalEvents(rejectedEnvelope, { previousHistoryLength: 0, planningActive: false });
    expect(detectWorkPhase({ envelope: rejectedEnvelope, events: rejectedEvents, planningActive: false,
      failureCounters: {}, trigger: decideTrigger({ mode: "acu-auto", isNewTask: false, events: rejectedEvents }) }).phase).toBe("recovery");
  });

  it("promotes repeated native Messages failures without progress to recovery", () => {
    const repeatedEnvelope = normalizeMessagesRequest({ messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "test-1", name: "Bash", input: { command: "npm test" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "test-1", content: "Assertion failed", is_error: true }] },
      { role: "assistant", content: [{ type: "tool_use", id: "test-2", name: "Bash", input: { command: "npm test" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "test-2", content: "Assertion failed", is_error: true }] },
    ] });
    const events = extractIncrementalEvents(repeatedEnvelope, { previousHistoryLength: 0, planningActive: false });
    const signature = events.find((item) => item.type === "execution_failure")?.failureSignature;
    expect(signature).toBeTruthy();
    const failureCounters = { [signature!]: { signature: signature!, category: "execution_or_verification_failure" as const,
      count: 2, progressSinceLast: false } };
    expect(detectWorkPhase({ envelope: repeatedEnvelope, events, planningActive: false, failureCounters,
      trigger: decideTrigger({ mode: "acu-auto", isNewTask: false, events }) }).phase).toBe("recovery");
  });
});
