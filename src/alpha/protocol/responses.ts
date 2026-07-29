import { array, canonicalHash, record, textParts } from "./common.js";
import type { CanonicalEnvelope, NativeRequestHeaders } from "./types.js";

function parseJsonBody(body: unknown): Record<string, unknown> {
  if (typeof body === "string") return record(JSON.parse(body)) ?? {};
  return record(body) ?? {};
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

  return {
    protocol: "responses",
    requestedModel: String(raw.model ?? ""),
    stream: raw.stream === true,
    instructions: raw.instructions,
    history: input,
    tools,
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
