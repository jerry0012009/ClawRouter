import { array, canonicalHash, record, textParts } from "./common.js";
import type { CanonicalEnvelope, NativeRequestHeaders } from "./types.js";
import type { ToolCapability } from "../routing.js";

function parseJsonBody(body: unknown): Record<string, unknown> {
  if (typeof body === "string") return record(JSON.parse(body)) ?? {};
  return record(body) ?? {};
}

function requiredToolTypes(tools: unknown[]): ToolCapability[] {
  const capabilities = new Set<ToolCapability>();
  for (const rawTool of tools) {
    const tool = record(rawTool);
    const type = typeof tool?.type === "string" ? tool.type.toLowerCase() : "";
    if (type === "function") capabilities.add("function");
    else if (type === "custom") capabilities.add("custom");
    else if (["namespace", "local_shell", "shell", "computer_shell"].includes(type)) capabilities.add("local_tool");
    else if (type === "web_search" || type.startsWith("web_search_")) continue;
    else if (type === "file_search") capabilities.add("file_search");
    else if (type === "computer" || type.startsWith("computer_use")) capabilities.add("computer_use");
    else if (type) capabilities.add("other_hosted_tool");
  }
  return [...capabilities];
}

function isHostedWebTool(value: unknown): boolean {
  const type = String(record(value)?.type ?? "").toLowerCase();
  return type === "web_search" || type.startsWith("web_search_");
}

function hostedWebRequired(toolChoice: unknown, tools: unknown[]): boolean {
  if (toolChoice === "required") return tools.length > 0 && tools.every(isHostedWebTool);
  const choice = record(toolChoice);
  if (!choice) return false;
  return isHostedWebTool(choice)
    || isHostedWebTool(choice.function)
    || String(choice.name ?? "").toLowerCase().startsWith("web_search");
}

export function isCodexEnvironmentContextWrapper(text: string): boolean {
  const trimmed = text.trim();
  if (!/^<environment_context>[\s\S]*<\/environment_context>$/.test(trimmed)) return false;
  return ["<cwd>", "<shell>", "<current_date>", "<timezone>", "<filesystem>"].filter((tag) => (
    trimmed.includes(tag)
  )).length >= 3;
}

export function normalizeResponsesRequest(body: unknown, headers: NativeRequestHeaders = {}): CanonicalEnvelope {
  void headers;
  const raw = parseJsonBody(body);
  const input = typeof raw.input === "string" ? [raw.input] : array(raw.input);
  const tools = array(raw.tools);
  const humanCandidates: CanonicalEnvelope["humanCandidates"] = [];
  const toolCalls: CanonicalEnvelope["toolCalls"] = [];
  const toolResults: CanonicalEnvelope["toolResults"] = [];
  const planCalls: string[] = [];
  const reasoning = record(raw.reasoning);
  const reasoningEffort = typeof reasoning?.effort === "string" && reasoning.effort.trim()
    ? reasoning.effort.trim()
    : undefined;

  input.forEach((entry, sourceIndex) => {
    if (typeof entry === "string") {
      if (entry.trim() && !isCodexEnvironmentContextWrapper(entry)) {
        humanCandidates.push({ text: entry, sourceIndex, confidence: "high" });
      }
      return;
    }
    const item = record(entry);
    if (!item) return;
    if (item.type === "message" && item.role === "user") {
      for (const text of textParts(item.content)) {
        if (!isCodexEnvironmentContextWrapper(text)) humanCandidates.push({ text, sourceIndex, confidence: "high" });
      }
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const id = String(item.call_id ?? item.id ?? "");
      const name = String(item.name ?? "");
      let argumentsValue: unknown = item.arguments ?? item.input;
      if (typeof argumentsValue === "string") {
        try { argumentsValue = JSON.parse(argumentsValue); } catch { /* preserve provider arguments */ }
      }
      toolCalls.push({ id, name, input: argumentsValue, sourceIndex });
      if (name === "update_plan") planCalls.push(id);
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      toolResults.push({
        toolCallId: String(item.call_id ?? item.id ?? ""),
        content: item.output ?? item.content,
        isError: item.is_error === true,
        sourceIndex,
      });
    }
  });
  const clientDeclaredWebTool = tools.some(isHostedWebTool);

  return {
    protocol: "responses",
    requestedModel: String(raw.model ?? ""),
    stream: raw.stream === true,
    instructions: raw.instructions,
    history: input,
    tools,
    requiredToolTypes: requiredToolTypes(tools),
    clientDeclaredWebTool,
    hostedWebRequired: clientDeclaredWebTool && hostedWebRequired(raw.tool_choice, tools),
    webIntent: "likely",
    webIntentConfidence: 0,
    webIntentReason: "Pending Routing Segment Judge evaluation.",
    webIntentEvidence: [],
    webActuallyInvoked: false,
    humanCandidates,
    toolCalls,
    toolResults,
    planning: {
      started: planCalls.length > 0,
      finished: false,
      updated: planCalls.length > 1,
      signalFamily: planCalls.length ? "codex_update_plan_call" : undefined,
      fingerprintVersion: planCalls.length ? "codex-plan-v1" : undefined,
      evidence: planCalls.map((id) => `function_call:update_plan:${id}`),
    },
    reasoningEffort,
    containsThinking: reasoningEffort !== undefined || input.some((entry) => record(entry)?.type === "reasoning"),
    thinkingSignatures: [],
    historyHash: canonicalHash(input),
    raw,
  };
}
