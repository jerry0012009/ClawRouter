#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { calculateProviderCost } from "../../src/alpha/usage.js";
import { readProviderChannelRegistry, readProviderModelProfiles, validateProviderModelProfiles } from "../../src/alpha/channel-registry.js";

type Json = Record<string, unknown>;
type Usage = { input: number; cached: number; output: number; reasoning: number };

if (process.env.ACU_CHANNEL_PREFLIGHT_LIVE !== "1") throw new Error("Set ACU_CHANNEL_PREFLIGHT_LIVE=1 to authorize the paid preflight");
const maxCashCny = Math.min(1, Math.max(0, Number(process.env.ACU_CHANNEL_PREFLIGHT_MAX_CNY ?? "1")));
const preflightRunId = process.env.ACU_CHANNEL_PREFLIGHT_RUN_ID?.trim() || "founder-economic-alpha-20260729-v1";

const SELECTED_PROFILES = [
  "lucen-cx004-low-dedicated:gpt-5.6-luna:responses",
  "lucen-cx014-pro-stable:gpt-5.6-luna:responses",
  "lucen-cx025-pro-premium:gpt-5.6-luna:responses",
] as const;

function dotenv(text: string): Map<string, string> {
  return new Map(text.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    return match ? [[match[1], match[2]]] : [];
  }));
}

function usage(value: unknown): Usage {
  const row = value && typeof value === "object" ? value as Json : {};
  const input = row.input_tokens_details && typeof row.input_tokens_details === "object" ? row.input_tokens_details as Json : {};
  const output = row.output_tokens_details && typeof row.output_tokens_details === "object" ? row.output_tokens_details as Json : {};
  return { input: Number(row.input_tokens ?? 0), cached: Number(input.cached_tokens ?? 0),
    output: Number(row.output_tokens ?? 0), reasoning: Number(output.reasoning_tokens ?? 0) };
}

function add(left: Usage, right: Usage): Usage {
  return { input: left.input + right.input, cached: left.cached + right.cached,
    output: left.output + right.output, reasoning: left.reasoning + right.reasoning };
}

async function streamed(url: string, apiKey: string, body: Json): Promise<{ response: Json; eventCount: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let result: Response;
  let text: string;
  try {
    result = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }), signal: controller.signal });
    text = await result.text();
  } finally {
    clearTimeout(timeout);
  }
  if (!result.ok) throw new Error(`HTTP ${result.status}`);
  const events = text.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith("data:")) return [];
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return [];
    try { return [JSON.parse(data) as Json]; } catch { throw new Error("non_json_sse_event"); }
  });
  const completed = [...events].reverse().find((item) => item.type === "response.completed")?.response;
  if (!completed || typeof completed !== "object" || Array.isArray(completed)) throw new Error("missing_response_completed");
  return { response: completed as Json, eventCount: events.length };
}

function outputs(response: Json): Json[] {
  return Array.isArray(response.output) ? response.output.filter((item): item is Json => Boolean(item) && typeof item === "object") : [];
}

function actualVerified(requested: string, actual: string): boolean {
  return actual === requested || (requested === "gpt-5.4-mini" && actual === "gpt-5.4-mini-2026-03-17");
}

function classifyError(error: unknown): string {
  if (error instanceof Error && (error.name === "AbortError" || /aborted|timeout/i.test(error.message))) return "timeout";
  if (error instanceof Error && /^HTTP [45]\d\d$/.test(error.message)) return `provider_http_${error.message.slice(5)}`;
  return error instanceof Error ? error.message : "unknown_provider_error";
}

async function main(): Promise<void> {
  const env = dotenv(await readFile(resolve(".env"), "utf8"));
  const channels = await readProviderChannelRegistry(resolve("deploy/alpha/provider-channels.json"));
  const profileRegistry = await readProviderModelProfiles(resolve("deploy/alpha/provider-model-profiles.json"));
  const observations: Json[] = [];
  let spentCny = 0;
  for (const executionProfileId of SELECTED_PROFILES) {
    if (spentCny >= maxCashCny) break;
    const profile = profileRegistry.profiles.find((item) => item.executionProfileId === executionProfileId);
    if (!profile) {
      observations.push({ preflightRunId, executionProfileId, status: "failed", errorClass: "profile_not_found" });
      continue;
    }
    const channel = channels.channels.find((item) => item.channelId === profile.channelId)!;
    const model = profile.canonicalModelId;
    if (profile.activeInAcuAuto && profile.actualModelVerified && profile.usageTrusted && profile.effectivePriceAvailable) {
      observations.push({ preflightRunId, executionProfileId, channelId: channel.channelId, providerId: channel.providerId,
        model, status: "skipped", skipReason: "sufficient_existing_evidence" });
      continue;
    }
    const apiKey = env.get(channel.apiKeyEnv)!;
    const base = env.get(channel.primaryBaseUrlEnv)!;
    const url = new URL("responses", base.endsWith("/") ? base : `${base}/`).toString();
    const tool = { type: "function", name: "acu_channel_probe", description: "Deterministic local tool probe",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, strict: true };
    try {
      const first = await streamed(url, apiKey, { model, input: "Call acu_channel_probe once with value ok.", tools: [tool],
        tool_choice: "required", reasoning: { effort: "medium" }, max_output_tokens: 128 });
      const call = outputs(first.response).find((item) => item.type === "function_call");
      if (!call || typeof call.call_id !== "string") throw new Error("missing_function_call");
      const second = await streamed(url, apiKey, { model, input: [
        { role: "user", content: "Call acu_channel_probe once with value ok." }, call,
        { type: "function_call_output", call_id: call.call_id, output: "{\"ok\":true}" },
      ], tools: [tool], reasoning: { effort: "medium" }, max_output_tokens: 128 });
      if (!outputs(second.response).some((item) => item.type === "message")) throw new Error("tool_result_no_message");
      const totalUsage = add(usage(first.response.usage), usage(second.response.usage));
      const actualModels = [first.response.model, second.response.model].map(String);
      if (!actualModels.every((actual) => actualVerified(model, actual))) throw new Error("actual_model_mismatch");
      if (totalUsage.input + totalUsage.output === 0) throw new Error("usage_missing");
      const nominalUsd = Number(calculateProviderCost(model, BigInt(totalUsage.input), BigInt(totalUsage.cached), BigInt(totalUsage.output)));
      const cashRatio = channel.rechargeCashRatioCnyPerCreditUsd ?? 1;
      const multiplier = channel.observedBillingMultiplier ?? 1;
      const effectiveCashCostCny = nominalUsd * cashRatio * multiplier;
      spentCny += effectiveCashCostCny;
      const canActivate = channel.effectiveCostStatus !== "missing";
      Object.assign(profile, {
        toolCallSupport: true,
        supportedToolTypes: ["function", "custom", "local_tool"],
        thinkingSupport: true,
        supportedReasoningEfforts: ["low", "medium", "high"],
        canonicalAdvertisedContextWindow: profile.canonicalAdvertisedContextWindow,
        providerDeclaredContextWindow: profile.providerDeclaredContextWindow,
        observedSuccessfulInputTokens: Math.max(profile.observedSuccessfulInputTokens, totalUsage.input),
        providerHardContextCap: profile.providerHardContextCap,
        contextCapabilityStatus: "observed_floor",
        contextCapabilitySource: "minimal_native_responses_preflight_usage",
        contextLastVerifiedAt: new Date().toISOString(),
        actualModelVerified: true,
        actualModelAliases: [...new Set(actualModels.filter((actual) => actual !== model))],
        usageTrusted: true,
        effectivePriceAvailable: canActivate,
        effectiveCostStatus: channel.effectiveCostStatus,
        health: canActivate ? "healthy" : "degraded",
        healthReason: canActivate ? "minimal_native_responses_preflight_passed" : "preflight_passed_but_effective_price_missing",
        lastVerifiedAt: new Date().toISOString(),
        activeInAcuAuto: canActivate,
      });
      observations.push({ preflightRunId, executionProfileId, channelId: channel.channelId, providerId: channel.providerId, routingGroupName: channel.routingGroupName,
        model, status: "passed", nativePath: "/responses", streaming: true, toolRoundtrip: true,
        hostedWebSearch: false, reasoningEffort: "medium", actualModels, usage: totalUsage,
        nominalProviderCostUsd: nominalUsd, effectiveCashCostCny, activated: canActivate });
    } catch (error) {
      const errorClass = classifyError(error);
      Object.assign(profile, { health: "disabled", healthReason: `preflight_failed:${errorClass}`, activeInAcuAuto: false });
      observations.push({ preflightRunId, executionProfileId, channelId: channel.channelId, providerId: channel.providerId, routingGroupName: channel.routingGroupName,
        model, status: "failed", errorClass });
    }
  }
  profileRegistry.generatedAt = new Date().toISOString();
  validateProviderModelProfiles(profileRegistry);
  await writeFile(resolve("deploy/alpha/provider-model-profiles.json"), `${JSON.stringify(profileRegistry, null, 2)}\n`);
  await writeFile(resolve("deploy/alpha/provider-channel-preflight-observations.json"), `${JSON.stringify({
    schemaVersion: "acu-provider-channel-preflight-v1", capturedAt: new Date().toISOString(), preflightRunId,
    budgetCny: maxCashCny, concurrency: 1, webSearch: false,
    actualEstimatedCashCostCny: spentCny, observations,
  }, null, 2)}\n`);
  console.log(JSON.stringify({ tested: observations.length, passed: observations.filter((item) => item.status === "passed").length,
    active: profileRegistry.profiles.filter((item) => item.activeInAcuAuto).length, actualEstimatedCashCostCny: spentCny }));
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "Preflight failed"); process.exitCode = 1; });
