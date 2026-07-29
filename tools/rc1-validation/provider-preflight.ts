#!/usr/bin/env node
import { getAcuModel } from "../../src/acu/catalog.js";

type Protocol = "responses" | "messages";

type Candidate = {
  model: string;
  protocol: Protocol;
};

type Usage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
};

type ProbeResult = {
  model: string;
  protocol: Protocol;
  catalogPresent: boolean;
  catalogInputPricePerMillion: number | null;
  catalogOutputPricePerMillion: number | null;
  catalogContextWindow: number | null;
  stream: {
    ok: boolean;
    actualModel?: string;
    eventCount?: number;
    textDeltaCount?: number;
    usage?: Usage;
  };
  toolLoop: {
    ok: boolean;
    actualModel?: string;
    toolIdPreserved?: boolean;
    usage?: Usage;
  };
  context: {
    ok: boolean;
    requestedProbeTokens: number;
    actualModel?: string;
    usage?: Usage;
  };
  estimatedProviderCostUsd: number;
  error?: string;
};

type JsonRecord = Record<string, unknown>;

const apiKey = process.env.CLOSEAI_API_KEY?.trim();
if (!apiKey) throw new Error("CLOSEAI_API_KEY is required");

const openAiBaseUrl = (process.env.CLOSEAI_OPENAI_BASE_URL?.trim()
  || "https://api.openai-proxy.org/v1").replace(/\/$/, "");
const anthropicBaseUrl = (process.env.CLOSEAI_ANTHROPIC_BASE_URL?.trim()
  || "https://api.openai-proxy.org/anthropic").replace(/\/$/, "");
const contextProbeTokens = Math.max(1_024, Number.parseInt(process.env.RC1_CONTEXT_PROBE_TOKENS ?? "32768", 10));

const candidates: Candidate[] = process.env.RC1_PREFLIGHT_CANDIDATES_JSON
  ? JSON.parse(process.env.RC1_PREFLIGHT_CANDIDATES_JSON) as Candidate[]
  : [
      { model: "gpt-5.4-mini", protocol: "responses" },
      { model: "gpt-5.5", protocol: "responses" },
      { model: "claude-sonnet-5", protocol: "messages" },
      { model: "claude-opus-4-8", protocol: "messages" },
    ];

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function usageFromResponses(value: unknown): Usage {
  const usage = value && typeof value === "object" ? value as JsonRecord : {};
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === "object"
    ? usage.input_tokens_details as JsonRecord : {};
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === "object"
    ? usage.output_tokens_details as JsonRecord : {};
  return {
    inputTokens: numberValue(usage.input_tokens),
    outputTokens: numberValue(usage.output_tokens),
    cachedInputTokens: numberValue(inputDetails.cached_tokens),
    reasoningTokens: numberValue(outputDetails.reasoning_tokens),
  };
}

function usageFromMessages(value: unknown): Usage {
  const usage = value && typeof value === "object" ? value as JsonRecord : {};
  return {
    inputTokens: numberValue(usage.input_tokens),
    outputTokens: numberValue(usage.output_tokens),
    cachedInputTokens: numberValue(usage.cache_read_input_tokens),
    reasoningTokens: 0,
  };
}

function mergeUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

async function jsonRequest(url: string, headers: Record<string, string>, body: JsonRecord): Promise<JsonRecord> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).pathname}`);
  return await response.json() as JsonRecord;
}

async function sseRequest(
  url: string,
  headers: Record<string, string>,
  body: JsonRecord,
): Promise<JsonRecord[]> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).pathname}`);
  const text = await response.text();
  const events: JsonRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) events.push(parsed as JsonRecord);
    } catch {
      throw new Error("Provider emitted a non-JSON SSE data event");
    }
  }
  return events;
}

function responseOutput(response: JsonRecord): JsonRecord[] {
  return Array.isArray(response.output)
    ? response.output.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

async function probeResponses(model: string): Promise<Omit<ProbeResult, "model" | "protocol" | "catalogPresent" |
"catalogInputPricePerMillion" | "catalogOutputPricePerMillion" | "catalogContextWindow" | "estimatedProviderCostUsd"> & { totalUsage: Usage }> {
  const url = `${openAiBaseUrl}/responses`;
  const headers = { authorization: `Bearer ${apiKey}` };
  const streamEvents = await sseRequest(url, headers, {
    model,
    input: "Reply with exactly RC1-STREAM-OK.",
    stream: true,
    max_output_tokens: 64,
  });
  const completed = [...streamEvents].reverse().find((event) => event.type === "response.completed")?.response as JsonRecord | undefined;
  const textDeltaCount = streamEvents.filter((event) => event.type === "response.output_text.delta").length;
  if (!completed || textDeltaCount === 0) throw new Error("Responses stream lacked text delta or completion");

  const toolPrompt = "Call rc1_probe exactly once with value alpha. Do not answer in text before the tool call.";
  const toolDefinition = {
    type: "function",
    name: "rc1_probe",
    description: "RC1 deterministic provider capability probe",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    strict: true,
  };
  const toolResponse = await jsonRequest(url, headers, {
    model,
    input: toolPrompt,
    tools: [toolDefinition],
    tool_choice: "required",
    max_output_tokens: 128,
  });
  const functionCall = responseOutput(toolResponse).find((item) => item.type === "function_call");
  const callId = typeof functionCall?.call_id === "string" ? functionCall.call_id : undefined;
  if (!functionCall || !callId) throw new Error("Responses tool probe returned no function_call/call_id");
  const finalResponse = await jsonRequest(url, headers, {
    model,
    input: [
      { role: "user", content: toolPrompt },
      functionCall,
      { type: "function_call_output", call_id: callId, output: "{\"ok\":true}" },
    ],
    tools: [toolDefinition],
    tool_choice: "auto",
    max_output_tokens: 128,
  });
  const finalHasText = responseOutput(finalResponse).some((item) => item.type === "message");
  if (!finalHasText) throw new Error("Responses tool_result continuation returned no message");

  const contextText = `${"probe ".repeat(contextProbeTokens)}\nReply OK.`;
  const contextResponse = await jsonRequest(url, headers, {
    model,
    input: contextText,
    max_output_tokens: 16,
  });

  const streamUsage = usageFromResponses(completed.usage);
  const toolUsage = mergeUsage(usageFromResponses(toolResponse.usage), usageFromResponses(finalResponse.usage));
  const contextUsage = usageFromResponses(contextResponse.usage);
  return {
    stream: {
      ok: true,
      actualModel: String(completed.model ?? "unknown"),
      eventCount: streamEvents.length,
      textDeltaCount,
      usage: streamUsage,
    },
    toolLoop: {
      ok: true,
      actualModel: String(finalResponse.model ?? toolResponse.model ?? "unknown"),
      toolIdPreserved: true,
      usage: toolUsage,
    },
    context: {
      ok: true,
      requestedProbeTokens: contextProbeTokens,
      actualModel: String(contextResponse.model ?? "unknown"),
      usage: contextUsage,
    },
    totalUsage: mergeUsage(mergeUsage(streamUsage, toolUsage), contextUsage),
  };
}

function messageContent(response: JsonRecord): JsonRecord[] {
  return Array.isArray(response.content)
    ? response.content.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

async function probeMessages(model: string): Promise<Omit<ProbeResult, "model" | "protocol" | "catalogPresent" |
"catalogInputPricePerMillion" | "catalogOutputPricePerMillion" | "catalogContextWindow" | "estimatedProviderCostUsd"> & { totalUsage: Usage }> {
  const url = `${anthropicBaseUrl}/v1/messages`;
  const headers = { "x-api-key": apiKey!, "anthropic-version": "2023-06-01" };
  const streamEvents = await sseRequest(url, headers, {
    model,
    messages: [{ role: "user", content: "Reply with exactly RC1-STREAM-OK." }],
    stream: true,
    max_tokens: 64,
  });
  const messageStart = streamEvents.find((event) => event.type === "message_start")?.message as JsonRecord | undefined;
  const messageDelta = [...streamEvents].reverse().find((event) => event.type === "message_delta");
  const textDeltaCount = streamEvents.filter((event) => {
    const delta = event.delta as JsonRecord | undefined;
    return event.type === "content_block_delta" && delta?.type === "text_delta";
  }).length;
  if (!messageStart || textDeltaCount === 0 || !streamEvents.some((event) => event.type === "message_stop")) {
    throw new Error("Messages stream lacked text delta, start, or stop");
  }
  const streamUsage = mergeUsage(usageFromMessages(messageStart.usage), usageFromMessages(messageDelta?.usage));

  const toolPrompt = "Call rc1_probe exactly once with value alpha. Do not answer in text before the tool call.";
  const toolDefinition = {
    name: "rc1_probe",
    description: "RC1 deterministic provider capability probe",
    input_schema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  };
  const toolResponse = await jsonRequest(url, headers, {
    model,
    messages: [{ role: "user", content: toolPrompt }],
    tools: [toolDefinition],
    tool_choice: { type: "any" },
    max_tokens: 128,
  });
  const toolUse = messageContent(toolResponse).find((item) => item.type === "tool_use");
  const toolId = typeof toolUse?.id === "string" ? toolUse.id : undefined;
  if (!toolUse || !toolId) throw new Error("Messages tool probe returned no tool_use/id");
  const finalResponse = await jsonRequest(url, headers, {
    model,
    messages: [
      { role: "user", content: toolPrompt },
      { role: "assistant", content: toolResponse.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "{\"ok\":true}" }] },
    ],
    tools: [toolDefinition],
    max_tokens: 128,
  });
  if (!messageContent(finalResponse).some((item) => item.type === "text")) {
    throw new Error("Messages tool_result continuation returned no text");
  }

  const contextText = `${"probe ".repeat(contextProbeTokens)}\nReply OK.`;
  const contextResponse = await jsonRequest(url, headers, {
    model,
    messages: [{ role: "user", content: contextText }],
    max_tokens: 16,
  });

  const toolUsage = mergeUsage(usageFromMessages(toolResponse.usage), usageFromMessages(finalResponse.usage));
  const contextUsage = usageFromMessages(contextResponse.usage);
  return {
    stream: {
      ok: true,
      actualModel: String(messageStart.model ?? "unknown"),
      eventCount: streamEvents.length,
      textDeltaCount,
      usage: streamUsage,
    },
    toolLoop: {
      ok: true,
      actualModel: String(finalResponse.model ?? toolResponse.model ?? "unknown"),
      toolIdPreserved: true,
      usage: toolUsage,
    },
    context: {
      ok: true,
      requestedProbeTokens: contextProbeTokens,
      actualModel: String(contextResponse.model ?? "unknown"),
      usage: contextUsage,
    },
    totalUsage: mergeUsage(mergeUsage(streamUsage, toolUsage), contextUsage),
  };
}

function estimatedCost(model: string, usage: Usage): number {
  const catalog = getAcuModel(model);
  if (!catalog?.inputPricePerMillion || !catalog.outputPricePerMillion) return 0;
  return ((usage.inputTokens - usage.cachedInputTokens) * catalog.inputPricePerMillion
    + usage.outputTokens * catalog.outputPricePerMillion) / 1_000_000;
}

const results: ProbeResult[] = [];
for (const candidate of candidates) {
  const catalog = getAcuModel(candidate.model);
  const base: Omit<ProbeResult, "stream" | "toolLoop" | "context" | "estimatedProviderCostUsd"> = {
    model: candidate.model,
    protocol: candidate.protocol,
    catalogPresent: Boolean(catalog),
    catalogInputPricePerMillion: catalog?.inputPricePerMillion ?? null,
    catalogOutputPricePerMillion: catalog?.outputPricePerMillion ?? null,
    catalogContextWindow: catalog?.contextWindow ?? null,
  };
  if (!catalog) {
    results.push({
      ...base,
      stream: { ok: false },
      toolLoop: { ok: false },
      context: { ok: false, requestedProbeTokens: contextProbeTokens },
      estimatedProviderCostUsd: 0,
      error: "candidate is absent from the ACU catalog",
    });
    continue;
  }
  try {
    const probe = candidate.protocol === "responses"
      ? await probeResponses(candidate.model)
      : await probeMessages(candidate.model);
    results.push({
      ...base,
      stream: probe.stream,
      toolLoop: probe.toolLoop,
      context: probe.context,
      estimatedProviderCostUsd: estimatedCost(candidate.model, probe.totalUsage),
    });
  } catch (error) {
    results.push({
      ...base,
      stream: { ok: false },
      toolLoop: { ok: false },
      context: { ok: false, requestedProbeTokens: contextProbeTokens },
      estimatedProviderCostUsd: 0,
      error: error instanceof Error ? error.message.slice(0, 240) : "preflight failed",
    });
  }
}

console.log(JSON.stringify({
  schemaVersion: "acu-rc1-provider-preflight-v1",
  capturedAt: new Date().toISOString(),
  contextProbeTokens,
  results,
}, null, 2));
if (results.some((result) => !result.stream.ok || !result.toolLoop.ok || !result.context.ok)) process.exitCode = 1;
