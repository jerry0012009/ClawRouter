import { array, canonicalHash, record, textParts } from "./common.js";
import type { CanonicalEnvelope, NativeRequestHeaders, WebIntent } from "./types.js";
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

function classifyWebIntent(value: string): WebIntent {
  const text = value.toLowerCase();
  const explicitTime = /\b(latest|today|tonight|right now|real[- ]?time|live|as of)\b|实时|最新|今天|今日/.test(text);
  const currentInformation = /\bcurrent(?:ly)?\b.{0,40}\b(date|time|weather|news|price|stock|version|release|status|information)\b/.test(text)
    || /(?:当前|现在).{0,20}(?:日期|时间|天气|新闻|价格|行情|版本|发布|状态|信息)/.test(text);
  if (explicitTime || currentInformation) {
    return "required";
  }
  if (/\b(search|browse|look up|online|on the web|internet|news|weather|price|stock|release notes?)\b|搜索|联网|网上|网页|新闻|天气|价格|行情/.test(text)) {
    return "likely";
  }
  return "not_required";
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
      if (entry.trim()) humanCandidates.push({ text: entry, sourceIndex, confidence: "high" });
      return;
    }
    const item = record(entry);
    if (!item) return;
    if (item.type === "message" && item.role === "user") {
      for (const text of textParts(item.content)) humanCandidates.push({ text, sourceIndex, confidence: "high" });
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
  const webIntent = classifyWebIntent(humanCandidates.map((item) => item.text).join("\n"));

  return {
    protocol: "responses",
    requestedModel: String(raw.model ?? ""),
    stream: raw.stream === true,
    instructions: raw.instructions,
    history: input,
    tools,
    requiredToolTypes: requiredToolTypes(tools),
    clientDeclaredWebTool,
    webIntent,
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
