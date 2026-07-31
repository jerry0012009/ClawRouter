#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAcuModel } from "../../src/acu/catalog.js";
import { calculateProviderCost } from "../../src/alpha/usage.js";
import { readProviderChannelRegistry, readProviderModelProfiles } from "../../src/alpha/channel-registry.js";

type Json = Record<string, unknown>;
type Usage = { input: number; cached: number; output: number; reasoning: number };

if (process.env.ACU_FULL_POOL_PREFLIGHT_LIVE !== "1") {
  throw new Error("Set ACU_FULL_POOL_PREFLIGHT_LIVE=1 to authorize paid full-pool preflight");
}

const maxCashCny = Math.min(1, Math.max(0, Number(process.env.ACU_FULL_POOL_PREFLIGHT_MAX_CNY ?? "0.2")));
const runId = process.env.ACU_FULL_POOL_PREFLIGHT_RUN_ID?.trim() || "full-pool-preflight-20260731-v1";
const timeoutMs = Math.max(5_000, Number(process.env.ACU_FULL_POOL_PREFLIGHT_TIMEOUT_MS ?? "25000"));
const protocolFilter = process.env.ACU_FULL_POOL_PREFLIGHT_PROTOCOL?.trim();
const outputPath = resolve(process.env.ACU_FULL_POOL_PREFLIGHT_OUTPUT ?? "deploy/alpha/full-pool-preflight-observations.json");

function dotenv(text: string): Map<string, string> {
  return new Map(text.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    return match ? [[match[1], match[2]]] : [];
  }));
}

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function add(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    cached: left.cached + right.cached,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
  };
}

function responsesUsage(value: unknown): Usage {
  const row = object(value);
  const input = object(row.input_tokens_details);
  const output = object(row.output_tokens_details);
  return {
    input: number(row.input_tokens),
    cached: number(input.cached_tokens),
    output: number(row.output_tokens),
    reasoning: number(output.reasoning_tokens),
  };
}

function messagesUsage(value: unknown): Usage {
  const row = object(value);
  return {
    input: number(row.input_tokens),
    cached: number(row.cache_read_input_tokens),
    output: number(row.output_tokens),
    reasoning: number(object(row.output_tokens_details).thinking_tokens),
  };
}

function urlFor(base: string, resource: "responses" | "messages"): string {
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return new URL(resource === "messages" ? "v1/messages" : resource, normalized).toString();
}

async function sse(url: string, headers: Record<string, string>, payload: Json): Promise<{ status: number; events: Json[] }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ ...payload, stream: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`provider_http_${response.status}`);
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
    throw new Error("invalid_sse_content_type");
  }
  const events = body.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith("data:")) return [];
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return [];
    try {
      return [object(JSON.parse(data) as unknown)];
    } catch {
      throw new Error("non_json_sse_event");
    }
  });
  if (!events.length) throw new Error("empty_sse");
  return { status: response.status, events };
}

function actualModelAccepted(requested: string, actual: string): boolean {
  if (actual === requested) return true;
  return requested === "gpt-5.4-mini" && actual.startsWith("gpt-5.4-mini-");
}

async function responsesProbe(url: string, apiKey: string, model: string): Promise<{ usage: Usage; actualModels: string[] }> {
  const tool = {
    type: "function",
    name: "acu_channel_probe",
    description: "Return the supplied value",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    strict: true,
  };
  const prompt = "Call acu_channel_probe once with value ok.";
  const first = await sse(url, { authorization: `Bearer ${apiKey}` }, {
    model,
    input: prompt,
    tools: [tool],
    tool_choice: "required",
    reasoning: { effort: "low" },
    max_output_tokens: 64,
  });
  const firstCompleted = object([...first.events].reverse().find((event) => event.type === "response.completed")?.response);
  const output = Array.isArray(firstCompleted.output) ? firstCompleted.output.map(object) : [];
  const call = output.find((item) => item.type === "function_call");
  if (!call || typeof call.call_id !== "string") throw new Error("missing_function_call");
  const second = await sse(url, { authorization: `Bearer ${apiKey}` }, {
    model,
    input: [
      { role: "user", content: prompt },
      call,
      { type: "function_call_output", call_id: call.call_id, output: "{\"ok\":true}" },
    ],
    tools: [tool],
    reasoning: { effort: "low" },
    max_output_tokens: 64,
  });
  const secondCompleted = object([...second.events].reverse().find((event) => event.type === "response.completed")?.response);
  const finalOutput = Array.isArray(secondCompleted.output) ? secondCompleted.output.map(object) : [];
  if (!finalOutput.some((item) => item.type === "message")) throw new Error("tool_result_no_message");
  return {
    usage: add(responsesUsage(firstCompleted.usage), responsesUsage(secondCompleted.usage)),
    actualModels: [String(firstCompleted.model ?? ""), String(secondCompleted.model ?? "")],
  };
}

function messageEnvelope(events: Json[]): Json {
  return object(events.find((event) => event.type === "message_start")?.message);
}

function messageUsage(events: Json[]): Usage {
  const start = messageEnvelope(events);
  const delta = object([...events].reverse().find((event) => event.type === "message_delta")?.usage);
  return add(messagesUsage(start.usage), messagesUsage(delta));
}

function toolUseFromEvents(events: Json[]): Json | undefined {
  const start = events.find((event) => {
    const block = object(event.content_block);
    return event.type === "content_block_start" && block.type === "tool_use";
  });
  if (!start) return undefined;
  const block = object(start.content_block);
  const index = number(start.index);
  const partial = events.filter((event) => event.type === "content_block_delta" && number(event.index) === index)
    .map((event) => object(event.delta).partial_json)
    .filter((value): value is string => typeof value === "string")
    .join("");
  let input: unknown = block.input ?? {};
  if (partial) {
    try { input = JSON.parse(partial) as unknown; } catch { throw new Error("invalid_tool_input_json"); }
  }
  return { type: "tool_use", id: block.id, name: block.name, input };
}

async function messagesProbe(url: string, apiKey: string, model: string): Promise<{ usage: Usage; actualModels: string[] }> {
  const headers = { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  const tool = {
    name: "acu_channel_probe",
    description: "Return the supplied value",
    input_schema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  };
  const prompt = "Call acu_channel_probe once with value ok.";
  const first = await sse(url, headers, {
    model,
    messages: [{ role: "user", content: prompt }],
    tools: [tool],
    tool_choice: { type: "any" },
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    max_tokens: 64,
  });
  const call = toolUseFromEvents(first.events);
  if (!call || typeof call.id !== "string") throw new Error("missing_tool_use");
  const second = await sse(url, headers, {
    model,
    messages: [
      { role: "user", content: prompt },
      { role: "assistant", content: [call] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "{\"ok\":true}" }] },
    ],
    tools: [tool],
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    max_tokens: 64,
  });
  const hasText = second.events.some((event) => event.type === "content_block_delta"
    && object(event.delta).type === "text_delta" && typeof object(event.delta).text === "string");
  if (!hasText || !second.events.some((event) => event.type === "message_stop")) throw new Error("tool_result_no_message");
  return {
    usage: add(messageUsage(first.events), messageUsage(second.events)),
    actualModels: [String(messageEnvelope(first.events).model ?? ""), String(messageEnvelope(second.events).model ?? "")],
  };
}

function errorClass(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && /timeout/i.test(error.message)) return "timeout";
  return error instanceof Error ? error.message : "unknown_provider_error";
}

async function main(): Promise<void> {
  const env = dotenv(await readFile(resolve(".env"), "utf8"));
  const channelRegistry = await readProviderChannelRegistry(resolve("deploy/alpha/provider-channels.json"));
  const profileRegistry = await readProviderModelProfiles(resolve("deploy/alpha/provider-model-profiles.json"));
  const candidates = profileRegistry.profiles.filter((profile) => {
    const catalog = getAcuModel(profile.canonicalModelId);
    return catalog?.inputPricePerMillion !== null && catalog?.outputPricePerMillion !== null
      && (!protocolFilter || profile.protocol === protocolFilter);
  });
  const observations: Json[] = [];
  let spentCny = 0;
  for (const [index, profile] of candidates.entries()) {
    if (spentCny >= maxCashCny) {
      observations.push({ executionProfileId: profile.executionProfileId, status: "skipped", errorClass: "cash_budget_exhausted" });
      continue;
    }
    const channel = channelRegistry.channels.find((item) => item.channelId === profile.channelId);
    if (!channel) throw new Error(`Missing channel ${profile.channelId}`);
    const base = env.get(channel.primaryBaseUrlEnv);
    const apiKey = env.get(channel.apiKeyEnv);
    if (!base || !apiKey) {
      observations.push({ executionProfileId: profile.executionProfileId, status: "failed", errorClass: "credentials_unavailable" });
      continue;
    }
    const startedAt = new Date();
    try {
      const resource = profile.protocol === "responses" ? "responses" : "messages";
      const result = profile.protocol === "responses"
        ? await responsesProbe(urlFor(base, resource), apiKey, profile.providerModelId)
        : await messagesProbe(urlFor(base, resource), apiKey, profile.providerModelId);
      if (result.usage.input + result.usage.output === 0) throw new Error("usage_missing");
      if (result.actualModels.some((actual) => !actualModelAccepted(profile.providerModelId, actual))) {
        throw new Error(`actual_model_mismatch:${result.actualModels.join(",")}`);
      }
      const nominalCostUsd = Number(calculateProviderCost(
        profile.canonicalModelId,
        BigInt(result.usage.input),
        BigInt(result.usage.cached),
        BigInt(result.usage.output),
      ));
      const effectiveCashCostCny = nominalCostUsd
        * (channel.rechargeCashRatioCnyPerCreditUsd ?? 1)
        * (channel.observedBillingMultiplier ?? 1);
      spentCny += effectiveCashCostCny;
      observations.push({
        runId,
        executionProfileId: profile.executionProfileId,
        channelId: channel.channelId,
        providerId: channel.providerId,
        model: profile.canonicalModelId,
        protocol: profile.protocol,
        status: "passed",
        sse: true,
        toolRoundtrip: true,
        reasoningAccepted: true,
        actualModels: result.actualModels,
        usage: result.usage,
        nominalCostUsd,
        effectiveCashCostCny,
        latencyMs: Date.now() - startedAt.getTime(),
      });
    } catch (error) {
      observations.push({
        runId,
        executionProfileId: profile.executionProfileId,
        channelId: channel.channelId,
        providerId: channel.providerId,
        model: profile.canonicalModelId,
        protocol: profile.protocol,
        status: "failed",
        errorClass: errorClass(error),
        latencyMs: Date.now() - startedAt.getTime(),
      });
    }
    console.log(JSON.stringify({ progress: `${index + 1}/${candidates.length}`, executionProfileId: profile.executionProfileId,
      status: observations.at(-1)?.status, spentCny }));
  }
  const output = {
    schemaVersion: "acu-full-pool-preflight-v1",
    runId,
    capturedAt: new Date().toISOString(),
    concurrency: 1,
    budgetCny: maxCashCny,
    candidateCount: candidates.length,
    passedCount: observations.filter((item) => item.status === "passed").length,
    failedCount: observations.filter((item) => item.status === "failed").length,
    skippedCount: observations.filter((item) => item.status === "skipped").length,
    actualEstimatedCashCostCny: spentCny,
    observations,
  };
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ candidateCount: candidates.length, passedCount: output.passedCount,
    failedCount: output.failedCount, skippedCount: output.skippedCount, actualEstimatedCashCostCny: spentCny }));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Full-pool preflight failed");
  process.exitCode = 1;
});
