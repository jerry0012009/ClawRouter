import { describe, expect, it } from "vitest";
import { extractIncrementalEvents } from "../src/alpha/events.js";
import { matchSession } from "../src/alpha/identity.js";
import { normalizeMessagesRequest } from "../src/alpha/protocol/messages.js";
import { normalizeResponsesRequest } from "../src/alpha/protocol/responses.js";
import { applyFailureEvidence, decideTrigger, incrementAcceptedResponse, type SegmentState } from "../src/alpha/state-machine.js";

function segment(overrides: Partial<SegmentState> = {}): SegmentState {
  return {
    segmentId: "seg-1",
    phase: "execution",
    acceptedModelResponsesSinceJudge: 0,
    planningActive: false,
    failureCounters: {},
    ...overrides,
  };
}

describe("Alpha session continuity", () => {
  it("matches exact growing history within one trusted user", () => {
    const previous = [{ type: "message", role: "user", content: "fix bug" }];
    const envelope = normalizeResponsesRequest({
      model: "acu-auto",
      input: [...previous, { type: "function_call", call_id: "call-1", name: "shell", arguments: "{}" }],
    });
    expect(matchSession([{
      sessionId: "ses-a",
      newapiUserId: "user-a",
      protocol: "responses",
      history: previous,
      lastToolCallIds: [],
    }], { newapiUserId: "user-a", envelope })).toMatchObject({
      sessionId: "ses-a",
      confidence: "strong",
      previousHistoryLength: 1,
    });
  });

  it("never joins identical prompts across users", () => {
    const history = [{ type: "message", role: "user", content: "same prompt" }];
    const envelope = normalizeResponsesRequest({ model: "acu-auto", input: history });
    expect(matchSession([{
      sessionId: "ses-a",
      newapiUserId: "user-a",
      protocol: "responses",
      history,
      lastToolCallIds: [],
    }], { newapiUserId: "user-b", envelope })).toEqual({
      confidence: "none",
      reasons: [],
      previousHistoryLength: 0,
    });
  });

  it("keeps one Claude Plan session when New API updates the role=system plan-file reminder", () => {
    const planControl = (planFileState: string) => `Plan mode is active.
## Plan File Info:
${planFileState}
## Plan Workflow
Inspect, write the plan file, then exit plan mode.`;
    const first = normalizeMessagesRequest({
      model: "acu-auto",
      messages: [
        { role: "user", content: "Plan listOpen" },
        { role: "system", content: planControl("No plan file exists yet") },
      ],
      tools: ["Read", "TaskCreate", "TaskUpdate", "Write"].map((name) => ({ name })),
    }, {}, "2.1.220");
    const next = normalizeMessagesRequest({
      model: "acu-auto",
      messages: [
        { role: "user", content: "Plan listOpen" },
        { role: "system", content: planControl("Plan file now exists") },
        { role: "assistant", content: [{ type: "tool_use", id: "write-plan", name: "Write", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "write-plan", content: "ok" }] },
      ],
      tools: ["Read", "TaskCreate", "TaskUpdate", "Write"].map((name) => ({ name })),
    }, {}, "2.1.220");

    expect(matchSession([{
      sessionId: "claude-plan-session",
      newapiUserId: "user-a",
      protocol: "messages",
      history: first.history,
      lastToolCallIds: [],
    }], { newapiUserId: "user-a", envelope: next })).toMatchObject({
      sessionId: "claude-plan-session",
      confidence: "strong",
      previousHistoryLength: 2,
    });
  });
});

describe("Alpha incremental events", () => {
  it("does not replay prior history events and keeps Claude tool_result separate", () => {
    const envelope = normalizeMessagesRequest({
      model: "acu-auto",
      messages: [
        { role: "user", content: [{ type: "text", text: "Fix it" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file" }] },
      ],
    });
    const events = extractIncrementalEvents(envelope, { previousHistoryLength: 2, planningActive: false });
    expect(events.map((item) => item.type)).toEqual(["tool_result"]);
    expect(events.some((item) => item.type === "human_message")).toBe(false);
  });

  it("recognizes a real Codex update_plan only once", () => {
    const envelope = normalizeResponsesRequest({
      model: "acu-auto",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Plan first" }] },
        { type: "function_call", call_id: "plan-1", name: "update_plan", arguments: "{\"plan\":[{\"status\":\"in_progress\"}]}" },
      ],
    });
    expect(extractIncrementalEvents(envelope, { previousHistoryLength: 1, planningActive: false })
      .map((item) => item.type)).toEqual(["tool_call", "plan_started"]);
    expect(extractIncrementalEvents(envelope, { previousHistoryLength: 2, planningActive: true })).toEqual([]);
  });

  it("emits Claude PlanFinished only for an actual ExitPlanMode call", () => {
    const declared = normalizeMessagesRequest({
      system: "Plan mode, read-only",
      messages: [{ role: "user", content: "Plan" }],
      tools: [{ name: "ExitPlanMode" }, { name: "Read" }],
    }, {}, "2.1.220");
    expect(extractIncrementalEvents(declared, { previousHistoryLength: 1, planningActive: true })
      .some((item) => item.type === "plan_finished")).toBe(false);

    const called = normalizeMessagesRequest({
      messages: [
        { role: "user", content: "Plan" },
        { role: "assistant", content: [{ type: "tool_use", id: "exit-1", name: "ExitPlanMode", input: {} }] },
      ],
    }, {}, "2.1.220");
    expect(extractIncrementalEvents(called, { previousHistoryLength: 1, planningActive: true })
      .map((item) => item.type)).toEqual(["tool_call", "plan_finished"]);
  });

  it("finishes a Codex plan when a previously completed plan reaches the first execution tool", () => {
    const envelope = normalizeResponsesRequest({
      model: "acu-auto",
      input: [
        { type: "function_call", call_id: "plan-done", name: "update_plan", arguments: "{\"plan\":[{\"status\":\"completed\"}]}" },
        { type: "function_call_output", call_id: "plan-done", output: "updated" },
        { type: "function_call", call_id: "edit-1", name: "apply_patch", arguments: "{}" },
      ],
    });
    expect(extractIncrementalEvents(envelope, {
      previousHistoryLength: 2,
      planningActive: true,
      activePlanHash: "completed-plan",
      activePlanComplete: true,
    }).map((item) => item.type)).toEqual(["tool_call", "plan_finished"]);
  });

  it("recognizes Codex 0.145 exec_command apply_patch as the first execution tool", () => {
    const envelope = normalizeResponsesRequest({
      model: "acu-auto",
      input: [
        { type: "function_call", call_id: "plan-done", name: "update_plan", arguments: "{\"plan\":[{\"status\":\"completed\"}]}" },
        { type: "function_call_output", call_id: "plan-done", output: "updated" },
        {
          type: "function_call",
          call_id: "edit-through-shell",
          name: "exec_command",
          arguments: "{\"cmd\":\"apply_patch <<'PATCH'\\n*** Begin Patch\\n*** End Patch\\nPATCH\"}",
        },
      ],
    });
    expect(extractIncrementalEvents(envelope, {
      previousHistoryLength: 2,
      planningActive: true,
      activePlanHash: "completed-plan",
      activePlanComplete: true,
    }).map((item) => item.type)).toEqual(["tool_call", "plan_finished"]);
  });
});

describe("Alpha Judge triggers", () => {
  it("never Judges explicit models", () => {
    expect(decideTrigger({ mode: "explicit", isNewTask: true, events: [] }))
      .toMatchObject({ runJudge: false, reason: "explicit_model" });
  });

  it("Judges every high-confidence HumanMessage including continue", () => {
    const envelope = normalizeResponsesRequest({
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] }],
    });
    const events = extractIncrementalEvents(envelope, { previousHistoryLength: 0, planningActive: false });
    expect(decideTrigger({ mode: "acu-auto", isNewTask: false, events, segment: segment() }))
      .toMatchObject({ runJudge: true, reason: "human_message" });
  });

  it("coalesces a new Claude Plan-only Task into a Planning Segment with quality anchor 88", () => {
    const envelope = normalizeMessagesRequest({
      model: "acu-auto",
      system: "You are in plan mode and must remain read-only.",
      messages: [{ role: "user", content: "Plan the change first" }],
      tools: [{ name: "Read" }, { name: "ExitPlanMode" }],
    }, {}, "2.1.220");
    const events = extractIncrementalEvents(envelope, { previousHistoryLength: 0, planningActive: false });
    expect(decideTrigger({ mode: "acu-auto", isNewTask: true, events }))
      .toMatchObject({ runJudge: true, reason: "plan_started", phase: "planning", temporaryPhaseOverride: 0 });
  });

  it("does not Judge ambiguous Claude text mixed with tool_result", () => {
    const envelope = normalizeMessagesRequest({
      model: "acu-auto",
      messages: [{
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "done" },
          { type: "text", text: "automatic tool context" },
        ],
      }],
    });
    const events = extractIncrementalEvents(envelope, { previousHistoryLength: 0, planningActive: false });
    expect(decideTrigger({ mode: "acu-auto", isNewTask: false, events, segment: segment() }))
      .toMatchObject({ runJudge: false, reason: "reuse_route" });
  });

  it("refreshes after eight accepted responses but not seven", () => {
    expect(decideTrigger({
      mode: "acu-auto", isNewTask: false, events: [],
      segment: segment({ acceptedModelResponsesSinceJudge: 7 }),
    })).toMatchObject({ runJudge: false, reason: "reuse_route", createSegment: false });
    expect(decideTrigger({
      mode: "acu-auto", isNewTask: false, events: [],
      segment: segment({ acceptedModelResponsesSinceJudge: 8 }),
    })).toMatchObject({ runJudge: true, reason: "accepted_response_limit", createSegment: true, phase: "execution" });
  });

  it("Judges plan completion and gives explicit events priority over the accepted response limit", () => {
    const planFinished = { type: "plan_finished" as const, hash: "plan-finished", evidenceStrength: "high" as const, metadata: {} };
    const human = { type: "human_message" as const, hash: "human", evidenceStrength: "high" as const, metadata: { text: "continue" } };
    expect(decideTrigger({
      mode: "acu-auto", isNewTask: false, events: [planFinished],
      segment: segment({ acceptedModelResponsesSinceJudge: 8 }),
    })).toMatchObject({ runJudge: true, reason: "plan_finished", createSegment: true });
    expect(decideTrigger({
      mode: "acu-auto", isNewTask: false, events: [human],
      segment: segment({ acceptedModelResponsesSinceJudge: 8 }),
    })).toMatchObject({ runJudge: true, reason: "human_message" });
  });

  it("does not Judge ordinary tool loops, first failure, Provider error, or Retry", () => {
    const firstFailure = {
      type: "execution_failure" as const,
      hash: "failure-event-1",
      evidenceStrength: "high" as const,
      failureCategory: "execution_or_verification_failure" as const,
      failureSignature: "same-failure",
      metadata: {},
    };
    const providerError = {
      type: "provider_error" as const,
      hash: "provider-1",
      evidenceStrength: "high" as const,
      failureCategory: "provider_error" as const,
      metadata: {},
    };
    const retry = { type: "retry_attempt" as const, hash: "retry-1", evidenceStrength: "high" as const, metadata: {} };
    expect(decideTrigger({ mode: "acu-auto", isNewTask: false, events: [firstFailure], segment: segment() }).runJudge).toBe(false);
    expect(decideTrigger({ mode: "acu-auto", isNewTask: false, events: [providerError, retry], segment: segment() }).runJudge).toBe(false);
  });

  it("Judges the second identical capability failure without progress and never downgrades", () => {
    const failure = {
      type: "execution_failure" as const,
      hash: "failure-event",
      evidenceStrength: "high" as const,
      failureCategory: "execution_or_verification_failure" as const,
      failureSignature: "same-failure",
      metadata: {},
    };
    const afterFirst = applyFailureEvidence({}, [failure]);
    expect(decideTrigger({
      mode: "acu-auto",
      isNewTask: false,
      events: [{ ...failure, hash: "failure-event-2" }],
      segment: segment({ failureCounters: afterFirst }),
    })).toMatchObject({ runJudge: true, reason: "repeated_failure", routeDirection: "hold_or_upgrade" });
  });

  it("does not count a repeated failure after explicit progress", () => {
    const failure = {
      type: "execution_failure" as const,
      hash: "failure-event",
      evidenceStrength: "high" as const,
      failureCategory: "execution_or_verification_failure" as const,
      failureSignature: "same-failure",
      metadata: {},
    };
    const success = {
      type: "tool_result" as const,
      hash: "success-event",
      evidenceStrength: "high" as const,
      metadata: { isError: false },
    };
    const counters = applyFailureEvidence({}, [failure, success]);
    expect(decideTrigger({ mode: "acu-auto", isNewTask: false, events: [failure], segment: segment({ failureCounters: counters }) }))
      .toMatchObject({ runJudge: false, reason: "reuse_route" });
  });

  it("counts only accepted responses and refreshes after the fixed budget", () => {
    let current = segment();
    for (let index = 0; index < 8; index += 1) current = incrementAcceptedResponse(current, true);
    current = incrementAcceptedResponse(current, false);
    expect(current.acceptedModelResponsesSinceJudge).toBe(8);
    expect(decideTrigger({ mode: "acu-auto", isNewTask: false, events: [], segment: current }))
      .toMatchObject({ runJudge: true, reason: "accepted_response_limit" });
  });

  it("retains the 10-minute Routing Lease rejudge trigger", () => {
    expect(decideTrigger({
      mode: "acu-auto",
      isNewTask: false,
      events: [],
      segment: segment(),
      routingLeaseExpired: true,
    })).toMatchObject({ runJudge: true, createSegment: true, reason: "lease_expired" });
  });

  it("creates and Judges a new Execution Segment for ordinary PlanFinished", () => {
    const finished = { type: "plan_finished" as const, hash: "plan-finished", evidenceStrength: "high" as const, metadata: {} };
    expect(decideTrigger({ mode: "acu-auto", isNewTask: false, events: [finished], segment: segment({ planningActive: true }) }))
      .toMatchObject({ runJudge: true, createSegment: true, reason: "plan_finished", phase: "execution", temporaryPhaseOverride: 0 });
  });

  it("Judges once at PlanStarted and reuses it through 10 Planning steps", () => {
    const started = { type: "plan_started" as const, hash: "plan-started-once", evidenceStrength: "high" as const, metadata: {} };
    expect(decideTrigger({ mode: "acu-auto", isNewTask: false, events: [started], segment: segment() }).runJudge).toBe(true);
    const planning = segment({ phase: "planning", planningActive: true });
    for (let index = 0; index < 10; index += 1) {
      const toolStep = { type: "tool_result" as const, hash: `planning-tool-${index}`, evidenceStrength: "high" as const, metadata: { isError: false } };
      expect(decideTrigger({ mode: "acu-auto", isNewTask: false, events: [toolStep], segment: planning }))
        .toMatchObject({ runJudge: false, reason: "reuse_route", temporaryPhaseOverride: 0 });
    }
  });

  it("rejudges PlanFinished when it carries a high-confidence new human constraint", () => {
    const events = [
      { type: "plan_finished" as const, hash: "plan-finished-constraint", evidenceStrength: "high" as const, metadata: {} },
      { type: "human_message" as const, hash: "new-constraint", evidenceStrength: "high" as const, metadata: {} },
    ];
    expect(decideTrigger({ mode: "acu-auto", isNewTask: false, events, segment: segment({ planningActive: true }) }))
      .toMatchObject({ runJudge: true, createSegment: true, reason: "human_message" });
  });
});
