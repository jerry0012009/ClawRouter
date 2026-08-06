import { describe, expect, it } from "vitest";
import { normalizeMessagesRequest } from "../src/alpha/protocol/messages.js";
import { normalizeResponsesRequest } from "../src/alpha/protocol/responses.js";

describe("Responses canonical envelope", () => {
  it("preserves call IDs and identifies actual update_plan calls", () => {
    const envelope = normalizeResponsesRequest({
      model: "acu-auto",
      stream: true,
      reasoning: { effort: "medium", summary: "auto" },
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the bug" }] },
        { type: "reasoning", id: "reasoning-1", summary: [] },
        { type: "function_call", call_id: "call-plan", name: "update_plan", arguments: "{\"plan\":[]}" },
        { type: "function_call_output", call_id: "call-plan", output: "Plan updated" },
        { type: "function_call", call_id: "call-shell", name: "exec_command", arguments: "{\"cmd\":\"npm test\"}" },
        { type: "function_call_output", call_id: "call-shell", output: "failed", is_error: true },
      ],
      tools: [{ type: "function", name: "update_plan" }],
    });
    expect(envelope.humanCandidates).toEqual([{ text: "Fix the bug", sourceIndex: 0, confidence: "high" }]);
    expect(envelope.toolCalls.map((call) => call.id)).toEqual(["call-plan", "call-shell"]);
    expect(envelope.toolResults).toEqual([
      { toolCallId: "call-plan", content: "Plan updated", isError: false, sourceIndex: 3 },
      { toolCallId: "call-shell", content: "failed", isError: true, sourceIndex: 5 },
    ]);
    expect(envelope.planning).toMatchObject({ started: true, signalFamily: "codex_update_plan_call" });
    expect(envelope.reasoningEffort).toBe("medium");
    expect(envelope.raw.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(envelope.containsThinking).toBe(true);
    expect(envelope.requiredToolTypes).toEqual(["function"]);
  });

  it("distinguishes provider-hosted web search from generic client tools", () => {
    const envelope = normalizeResponsesRequest({
      model: "acu-auto",
      input: "Search the web",
      tools: [
        { type: "function", name: "exec_command" },
        { type: "namespace", name: "multi_agent_v1" },
        { type: "web_search" },
        { type: "file_search" },
        { type: "computer_use_preview" },
      ],
    });
    expect(envelope.requiredToolTypes).toEqual([
      "function",
      "local_tool",
      "file_search",
      "computer_use",
    ]);
    expect(envelope.clientDeclaredWebTool).toBe(true);
    expect(envelope.hostedWebRequired).toBe(false);
    expect(envelope.webIntentReason).toBe("Pending Routing Segment Judge evaluation.");
    expect(envelope.webIntentSource).toBeUndefined();
    expect(envelope.webActuallyInvoked).toBe(false);
  });

  it("requires hosted Web only when tool_choice explicitly selects it", () => {
    const envelope = normalizeResponsesRequest({
      model: "acu-auto",
      input: "Search the web",
      tools: [{ type: "web_search" }, { type: "function", name: "exec_command" }],
      tool_choice: { type: "web_search" },
    });
    expect(envelope.hostedWebRequired).toBe(true);
  });

  it("does not classify current-information requests before the Routing Segment Judge", () => {
    const envelope = normalizeResponsesRequest({
      model: "acu-auto",
      input: "What is the latest stable release today?",
      tools: [{ type: "web_search" }],
    });
    expect(envelope.clientDeclaredWebTool).toBe(true);
    expect(envelope.webIntent).toBe("likely");
    expect(envelope.webIntentConfidence).toBe(0);
    expect(envelope.webIntentSource).toBeUndefined();
    expect(envelope.requiredToolTypes).toEqual([]);
  });

  it("does not run the legacy Regex for current workspace wording", () => {
    const envelope = normalizeResponsesRequest({
      model: "acu-auto",
      input: "Modify the current file and run check.sh",
      tools: [{ type: "web_search" }],
    });
    expect(envelope.clientDeclaredWebTool).toBe(true);
    expect(envelope.webIntent).toBe("likely");
    expect(envelope.webIntentSource).toBeUndefined();
  });

  it("does not treat an update_plan schema declaration as PlanStarted", () => {
    const envelope = normalizeResponsesRequest({
      model: "acu-auto",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Inspect" }] }],
      tools: [{ type: "function", name: "update_plan" }],
    });
    expect(envelope.planning.started).toBe(false);
  });

  it("keeps Codex environment context in raw history but excludes it from human goals", () => {
    const environment = `<environment_context>\n<cwd>/tmp/work</cwd>\n<shell>bash</shell>\n<current_date>2026-07-30</current_date>\n<timezone>UTC</timezone>\n<filesystem>workspace-write</filesystem>\n</environment_context>`;
    const envelope = normalizeResponsesRequest({
      model: "acu-auto",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: environment }] },
        { type: "function_call_output", call_id: "tool-1", output: "complete tool result" },
      ],
    });
    expect((envelope.history[0] as { content: Array<{ text: string }> }).content[0].text).toBe(environment);
    expect(envelope.humanCandidates).toEqual([]);
    expect(envelope.toolResults[0]?.content).toBe("complete tool result");
  });
});

describe("Messages canonical envelope", () => {
  it("distinguishes Anthropic and Kimi hosted Web tools from client functions", () => {
    const anthropic = normalizeMessagesRequest({
      model: "acu-auto",
      messages: [{ role: "user", content: "Search current news" }],
      tools: [{ type: "web_search_20260318", name: "web_search" }],
    });
    expect(anthropic.clientDeclaredWebTool).toBe(true);
    expect(anthropic.hostedWebRequired).toBe(false);
    expect(anthropic.requiredToolTypes).toEqual([]);

    const kimi = normalizeMessagesRequest({
      model: "acu-auto",
      messages: [{ role: "user", content: "Search current news" }],
      tools: [{ type: "builtin_function", function: { name: "$web_search" } }, { name: "Read" }],
    });
    expect(kimi.clientDeclaredWebTool).toBe(true);
    expect(kimi.requiredToolTypes).toEqual(["function"]);
  });

  it("recognizes an explicitly selected Messages hosted Web tool", () => {
    const envelope = normalizeMessagesRequest({
      model: "acu-auto",
      messages: [{ role: "user", content: "Search current news" }],
      tools: [{ type: "web_search_20260318", name: "web_search" }, { name: "Read" }],
      tool_choice: { type: "tool", name: "web_search" },
    });
    expect(envelope.hostedWebRequired).toBe(true);
  });

  it("separates tool_result from text in the same role=user content", () => {
    const envelope = normalizeMessagesRequest({
      model: "acu-auto",
      messages: [{
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "permission denied", is_error: true },
          { type: "text", text: "Continue with a read-only approach" },
        ],
      }],
    });
    expect(envelope.toolResults).toEqual([{
      toolCallId: "tool-1",
      content: "permission denied",
      isError: true,
      sourceIndex: 0,
    }]);
    expect(envelope.humanCandidates).toEqual([{
      text: "Continue with a read-only approach",
      sourceIndex: 0,
      confidence: "candidate",
    }]);
  });

  it("preserves tool IDs, thinking signatures and ExitPlanMode", () => {
    const envelope = normalizeMessagesRequest({
      model: "claude-sonnet-4-6",
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private", signature: "signed-thinking" },
          { type: "tool_use", id: "tool-exit", name: "ExitPlanMode", input: {} },
        ],
      }],
    }, {}, "2.1.220");
    expect(envelope.toolCalls).toEqual([{ id: "tool-exit", name: "ExitPlanMode", input: {}, sourceIndex: 0 }]);
    expect(envelope.thinkingSignatures).toEqual(["signed-thinking"]);
    expect(envelope.planning).toMatchObject({ finished: true, signalFamily: "claude_exit_plan_mode" });
  });

  it("uses the structural Plan fingerprint without gating on client version", () => {
    const plan = normalizeMessagesRequest({
      system: "You are in plan mode and must remain read-only.",
      messages: [{ role: "user", content: "Plan this change" }],
      tools: [{ name: "Read" }, { name: "ExitPlanMode" }],
    }, {}, "2.1.220");
    expect(plan.planning).toMatchObject({ started: true, fingerprintVersion: "claude-code-2.1-plan-v2" });

    const futureVersion = normalizeMessagesRequest(plan.raw, {}, "2.2.0");
    const unknownClient = normalizeMessagesRequest(plan.raw);
    const hasWriteTool = normalizeMessagesRequest({ ...plan.raw, tools: [{ name: "ExitPlanMode" }, { name: "Edit" }] }, {}, "2.1.220");
    expect(futureVersion.planning).toMatchObject({ started: true });
    expect(futureVersion.planning.evidence).toContain("client_version:2.2.0");
    expect(unknownClient.planning.started).toBe(true);
    expect(hasWriteTool.planning.started).toBe(false);
  });

  it("recognizes the Claude 2.1 native Plan reminder fingerprint without a declared ExitPlanMode tool", () => {
    const planReminder = `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet.

## Plan File Info:
Write the plan to the configured plan file.

## Plan Workflow
Inspect before proposing changes.
</system-reminder>`;
    const envelope = normalizeMessagesRequest({
      system: "You are Claude Code.",
      messages: [{ role: "user", content: [{ type: "text", text: planReminder }] }],
      tools: ["Read", "TaskCreate", "TaskUpdate", "Write", "Edit"].map((name) => ({ name })),
    }, {}, "2.1.220");
    expect(envelope.planning).toMatchObject({
      started: true,
      fingerprintVersion: "claude-code-2.1-plan-v2",
    });

    const afterExit = normalizeMessagesRequest({
      system: "You are Claude Code.",
      messages: [{
        role: "user",
        content: [{ type: "text", text: `${planReminder}\n## Exited Plan Mode` }],
      }],
      tools: ["Read", "TaskCreate", "TaskUpdate", "Write", "Edit"].map((name) => ({ name })),
    }, {}, "2.1.220");
    expect(afterExit.planning.started).toBe(false);

    const throughNewAPI = normalizeMessagesRequest({
      system: "You are Claude Code.",
      messages: [
        { role: "user", content: "Plan a change" },
        { role: "system", content: planReminder },
      ],
      tools: ["Read", "TaskCreate", "TaskUpdate", "Write", "Edit"].map((name) => ({ name })),
    }, {}, "2.1.220");
    expect(throughNewAPI.planning.started).toBe(true);
  });
});
