#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { calculateProviderCost } from "../../src/alpha/usage.js";
import { readProviderChannelRegistry, readProviderModelProfiles } from "../../src/alpha/channel-registry.js";

type Json = Record<string, unknown>;
type Usage = { input: number; cached: number; output: number };

if (process.env.ACU_WEB_PREFLIGHT_LIVE !== "1") throw new Error("Set ACU_WEB_PREFLIGHT_LIVE=1 to authorize paid Web preflight");
const maxCashCny = Math.min(0.8, Math.max(0, Number(process.env.ACU_WEB_PREFLIGHT_MAX_CNY ?? "0.8")));
const runId = process.env.ACU_WEB_PREFLIGHT_RUN_ID?.trim() || "founder-continuous-web-alpha-20260729-v1";

const SELECTED = [
  "lucen-cx006-value-dynamic:gpt-5.6-luna:responses",
  "blackai-codex-mix-low:gpt-5.6-luna:responses",
  "lucen-cx006-value-dynamic:gpt-5.4-mini:responses",
  "closeai-gpt-5.4-mini-responses-economy",
  "lucen-cx006-value-dynamic:gpt-5.6-terra:responses",
  "blackai-codex-mix-low:gpt-5.6-terra:responses",
  "blackai-codex-mix-low:gpt-5.6-sol:responses",
  "closeai-gpt-5.6-terra-responses-strong",
] as const;

function dotenv(text: string): Map<string, string> {
  return new Map(text.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    return match ? [[match[1], match[2]]] : [];
  }));
}

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function usage(response: Json): Usage {
  const value = object(response.usage);
  return {
    input: Number(value.input_tokens ?? 0),
    cached: Number(object(value.input_tokens_details).cached_tokens ?? 0),
    output: Number(value.output_tokens ?? 0),
  };
}

async function streamed(url: string, apiKey: string, body: Json): Promise<{ response: Json; events: Json[] }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const result = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: true, max_output_tokens: 64 }),
      signal: controller.signal,
    });
    const text = await result.text();
    if (!result.ok) throw new Error(`provider_http_${result.status}`);
    const events = text.split(/\r?\n/).flatMap((line) => {
      if (!line.startsWith("data:")) return [];
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return [];
      try { return [JSON.parse(data) as Json]; } catch { throw new Error("non_json_sse_event"); }
    });
    const completed = [...events].reverse().find((item) => item.type === "response.completed");
    const response = object(completed?.response);
    if (!Object.keys(response).length) throw new Error("missing_response_completed");
    return { response, events };
  } finally {
    clearTimeout(timeout);
  }
}

function actualAccepted(requested: string, actual: unknown, aliases: string[]): boolean {
  return typeof actual === "string" && [requested, ...aliases].includes(actual);
}

function classify(error: unknown): string {
  if (error instanceof Error && (error.name === "AbortError" || /aborted|timeout/i.test(error.message))) return "timeout";
  return error instanceof Error ? error.message : "unknown_web_preflight_error";
}

async function main(): Promise<void> {
  const env = dotenv(await readFile(resolve(".env"), "utf8"));
  const channels = await readProviderChannelRegistry(resolve("deploy/alpha/provider-channels.json"));
  const registry = await readProviderModelProfiles(resolve("deploy/alpha/provider-model-profiles.json"));
  const executionPath = resolve("deploy/alpha/execution-profiles.json");
  const execution = JSON.parse(await readFile(executionPath, "utf8")) as Json[];
  const observations: Json[] = [];
  let cashCny = 0;

  for (const executionProfileId of SELECTED) {
    if (cashCny >= maxCashCny) break;
    const configured = execution.find((item) => item.executionProfileId === executionProfileId);
    if (!configured) throw new Error(`Missing execution Profile ${executionProfileId}`);
    const registryProfile = registry.profiles.find((item) => item.executionProfileId === executionProfileId);
    const channel = registryProfile
      ? channels.channels.find((item) => item.channelId === registryProfile.channelId)
      : undefined;
    const model = String(configured.modelId);
    const aliases = Array.isArray(configured.actualModelAliases) ? configured.actualModelAliases.map(String) : [];
    if (configured.webSearchExecutionVerified === true && configured.webSearchStreamingVerified === true
      && configured.webSearchResultVerified === true) {
      observations.push({ runId, executionProfileId, model, status: "skipped", skipReason: "sufficient_existing_web_evidence" });
      continue;
    }
    const apiKeyEnv = String(configured.apiKeyEnv);
    const apiKey = env.get(apiKeyEnv);
    const baseUrlEnv = String(configured.baseUrlEnv ?? "");
    const baseUrl = env.get(baseUrlEnv)
      ?? (configured.provider === "closeai" ? "https://api.openai-proxy.org/v1" : undefined);
    if (!apiKey || !baseUrl) throw new Error(`Missing local runtime secret for ${executionProfileId}`);
    const url = new URL("responses", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
    const webTool = { type: "web_search" };
    const startedAt = Date.now();
    const ratio = channel?.rechargeCashRatioCnyPerCreditUsd ?? 1;
    const multiplier = channel?.observedBillingMultiplier ?? Number(configured.observedBillingMultiplier ?? 1);
    let profileCashCny = 0;
    const charge = (value: Usage): number => {
      const nominalUsd = Number(calculateProviderCost(model, BigInt(value.input), BigInt(value.cached), BigInt(value.output)));
      const effective = nominalUsd * ratio * multiplier;
      profileCashCny += effective;
      cashCny += effective;
      return nominalUsd;
    };
    try {
      const declaration = await streamed(url, apiKey, {
        model,
        input: "Return only 4. Do not search the web.",
        tools: [webTool],
        reasoning: { effort: "medium" },
      });
      const declarationUsage = usage(declaration.response);
      charge(declarationUsage);
      if (!actualAccepted(model, declaration.response.model, aliases)) throw new Error("declaration_actual_model_mismatch");
      if (declarationUsage.input + declarationUsage.output === 0) throw new Error("declaration_usage_missing");
      Object.assign(configured, { webToolDeclarationAccepted: true });
      if (registryProfile) registryProfile.webToolDeclarationAccepted = true;

      const search = await streamed(url, apiKey, {
        model,
        input: "Use web search. What is the current UTC date? Answer YYYY-MM-DD only.",
        tools: [webTool],
        tool_choice: "required",
        reasoning: { effort: "medium" },
      });
      const searchUsage = usage(search.response);
      charge(searchUsage);
      const eventTypes = search.events.map((item) => String(item.type ?? ""));
      const requiredEvents = [
        "response.web_search_call.in_progress",
        "response.web_search_call.searching",
        "response.web_search_call.completed",
      ];
      if (!requiredEvents.every((type) => eventTypes.includes(type))) throw new Error("web_search_event_sequence_incomplete");
      const output = Array.isArray(search.response.output) ? search.response.output.map(object) : [];
      if (!output.some((item) => item.type === "web_search_call")) throw new Error("web_search_output_item_missing");
      if (!output.some((item) => item.type === "message")) throw new Error("web_search_final_answer_missing");
      if (!actualAccepted(model, search.response.model, aliases)) throw new Error("web_search_actual_model_mismatch");
      if (searchUsage.input + searchUsage.output === 0) throw new Error("web_search_usage_missing");

      const total = {
        input: declarationUsage.input + searchUsage.input,
        cached: declarationUsage.cached + searchUsage.cached,
        output: declarationUsage.output + searchUsage.output,
      };
      const nominalUsd = Number(calculateProviderCost(model, BigInt(total.input), BigInt(total.cached), BigInt(total.output)));
      const verifiedAt = new Date().toISOString();
      const fields = {
        webToolDeclarationAccepted: true,
        webSearchExecutionVerified: true,
        webSearchStreamingVerified: true,
        webSearchResultVerified: true,
        webSearchRecentSuccessRate: 1,
        webSearchObservedLatencyMs: Date.now() - startedAt,
        webSearchLastVerifiedAt: verifiedAt,
        webSearchFailureReason: null,
      };
      Object.assign(configured, fields, {
        supportedToolTypes: Array.isArray(configured.supportedToolTypes)
          ? configured.supportedToolTypes.filter((item) => item !== "hosted_web_search")
          : [],
      });
      if (registryProfile) Object.assign(registryProfile, fields, {
        supportedToolTypes: registryProfile.supportedToolTypes.filter((item) => item !== "hosted_web_search"),
      });
      observations.push({ runId, executionProfileId, provider: configured.provider, channel: configured.channel,
        model, status: "passed", testA: "declaration_accepted", testB: "web_search_verified",
        eventTypes: requiredEvents, usage: total, nominalProviderCostUsd: nominalUsd, effectiveCashCostCny: profileCashCny });
    } catch (error) {
      const reason = classify(error);
      Object.assign(configured, {
        webSearchExecutionVerified: false,
        webSearchStreamingVerified: false,
        webSearchResultVerified: false,
        webSearchFailureReason: reason,
      });
      if (registryProfile) Object.assign(registryProfile, {
        webSearchExecutionVerified: false,
        webSearchStreamingVerified: false,
        webSearchResultVerified: false,
        webSearchFailureReason: reason,
      });
      observations.push({ runId, executionProfileId, provider: configured.provider, channel: configured.channel,
        model, status: "failed", primaryReason: reason, testBExecuted: configured.webToolDeclarationAccepted === true,
        effectiveCashCostCny: profileCashCny });
    }
  }

  for (const profile of registry.profiles) {
    profile.supportedToolTypes = profile.supportedToolTypes.filter((item) => item !== "hosted_web_search");
  }
  registry.generatedAt = new Date().toISOString();
  await writeFile(resolve("deploy/alpha/provider-model-profiles.json"), `${JSON.stringify(registry, null, 2)}\n`);
  await writeFile(executionPath, `${JSON.stringify(execution, null, 2)}\n`);
  await writeFile(resolve("deploy/alpha/web-profile-preflight-observations.json"), `${JSON.stringify({
    schemaVersion: "acu-web-profile-preflight-v1",
    capturedAt: new Date().toISOString(),
    runId,
    concurrency: 1,
    selectedProfileCount: SELECTED.length,
    budgetCny: maxCashCny,
    actualEstimatedCashCostCny: cashCny,
    observations,
  }, null, 2)}\n`);
  console.log(JSON.stringify({ selected: SELECTED.length, passed: observations.filter((item) => item.status === "passed").length,
    skipped: observations.filter((item) => item.status === "skipped").length, failed: observations.filter((item) => item.status === "failed").length,
    actualEstimatedCashCostCny: cashCny }));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Web preflight failed");
  process.exitCode = 1;
});
