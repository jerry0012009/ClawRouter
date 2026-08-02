#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Json = Record<string, unknown>;
type Profile = {
  executionProfileId: string; modelId: string; providerModelId?: string; channel: string;
  protocols: Array<"responses" | "messages">; enabled: boolean; administratorAllowed: boolean;
  autoRouteEnabled?: boolean; usageTrusted?: boolean; health: string; supportedReasoningEfforts?: string[];
  reasoningControlMode?: string;
};

const runDate = process.env.ACU_REASONING_PROBE_DATE ?? new Date().toISOString().slice(0, 10).replaceAll("-", "");
const timeoutMs = Number(process.env.ACU_REASONING_PROBE_TIMEOUT_MS ?? 30_000);
const profiles = JSON.parse(await readFile(resolve("deploy/alpha/execution-profiles.json"), "utf8")) as Profile[];
const channels = JSON.parse(await readFile(resolve("deploy/alpha/provider-channels.json"), "utf8")) as { channels: Json[] };
const env = new Map((await readFile(resolve(".env"), "utf8")).split(/\r?\n/).flatMap((line) => {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  return match ? [[match[1], match[2]]] : [];
}));

function object(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function number(value: unknown): number { const result = Number(value ?? 0); return Number.isFinite(result) ? result : 0; }
function outputSummary(text: string): string { return text.replace(/\s+/g, " ").slice(0, 300); }

const representatives = [...new Set(profiles.filter((profile) => profile.enabled && profile.administratorAllowed
  && profile.autoRouteEnabled !== false && profile.usageTrusted !== false && profile.health === "healthy").map((profile) => profile.modelId))]
  .map((modelId) => profiles.filter((profile) => profile.modelId === modelId && profile.enabled && profile.administratorAllowed
    && profile.autoRouteEnabled !== false && profile.usageTrusted === true && profile.health === "healthy")
    .sort((left, right) => Number(right.reasoningControlMode === "standard_effort") - Number(left.reasoningControlMode === "standard_effort"))[0])
  .filter((profile): profile is Profile => Boolean(profile));

async function request(profile: Profile, effort: string): Promise<Json> {
  const channel = channels.channels.find((candidate) => candidate.channelId === profile.channel);
  if (!channel) throw new Error("channel_not_found");
  const base = env.get(String(channel.primaryBaseUrlEnv ?? ""));
  const key = env.get(String(channel.apiKeyEnv ?? ""));
  if (!base || !key) throw new Error("credentials_unavailable");
  const protocol = profile.protocols.includes("responses") ? "responses" : "messages";
  const url = new URL(protocol === "responses" ? "responses" : "v1/messages", base.endsWith("/") ? base : `${base}/`);
  const tool = protocol === "responses"
    ? { type: "function", name: "acu_reasoning_probe", description: "Return ok", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, strict: true }
    : { name: "acu_reasoning_probe", description: "Return ok", input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } };
  const body: Json = protocol === "responses" ? {
    model: profile.providerModelId ?? profile.modelId, input: "Call acu_reasoning_probe once with value ok.", stream: true,
    tools: [tool], tool_choice: "required", reasoning: { effort }, max_output_tokens: 48,
  } : {
    model: profile.providerModelId ?? profile.modelId, messages: [{ role: "user", content: "Call acu_reasoning_probe once with value ok." }], stream: true,
    tools: [tool], tool_choice: { type: "any" }, thinking: { type: "adaptive" }, output_config: { effort }, max_tokens: 48,
  };
  const started = Date.now();
  const response = await fetch(url, { method: "POST", headers: {
    authorization: `Bearer ${key}`, "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json", accept: "text/event-stream",
  }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  const events = text.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith("data:")) return [];
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return [];
    try { return [object(JSON.parse(data) as unknown)]; } catch { return []; }
  });
  const completed = object([...events].reverse().find((event) => event.type === "response.completed")?.response);
  const message = object(events.find((event) => event.type === "message_start")?.message);
  const usage = object(completed.usage ?? message.usage ?? [...events].reverse().find((event) => event.type === "message_delta")?.usage);
  const outputDetails = object(usage.output_tokens_details);
  const toolOk = protocol === "responses"
    ? (Array.isArray(completed.output) && completed.output.some((item) => object(item).type === "function_call"))
    : events.some((event) => event.type === "content_block_start" && object(event.content_block).type === "tool_use");
  const actualModel = String(completed.model ?? message.model ?? "");
  return {
    modelId: profile.modelId, executionProfileId: profile.executionProfileId, protocol, requestedEffort: effort, wireEffort: effort,
    httpStatus: response.status, actualModel, streaming: (response.headers.get("content-type") ?? "").includes("text/event-stream") && events.length > 0,
    toolCall: toolOk, usagePresent: Object.keys(usage).length > 0,
    reasoningTokens: number(outputDetails.reasoning_tokens ?? outputDetails.thinking_tokens ?? usage.reasoning_tokens),
    accepted: response.ok && events.length > 0 && toolOk, status: response.ok && events.length > 0 && toolOk ? "accepted_once" : "rejected",
    effectStatus: "effect_unverified", latencyMs: Date.now() - started,
    errorSummary: response.ok ? undefined : outputSummary(text),
  };
}

const observations: Json[] = [];
for (const profile of representatives) {
  const declared = profile.modelId === "gpt-5.6-luna"
    ? ["low", "medium", "high", "max"]
    : [...new Set(profile.supportedReasoningEfforts ?? [])];
  for (const effort of declared) {
    try { observations.push(await request(profile, effort)); }
    catch (error) {
      observations.push({ modelId: profile.modelId, executionProfileId: profile.executionProfileId,
        protocol: profile.protocols.includes("responses") ? "responses" : "messages", requestedEffort: effort, wireEffort: effort,
        httpStatus: 0, streaming: false, toolCall: false, usagePresent: false, reasoningTokens: 0,
        accepted: false, status: "rejected", effectStatus: "effect_unverified",
        errorSummary: outputSummary(error instanceof Error ? error.message : String(error)) });
    }
  }
  if (profile.modelId === "gpt-5.6-luna") {
    const max = observations.findLast((item) => item.modelId === profile.modelId && item.requestedEffort === "max");
    if (max?.accepted !== true) {
      try { observations.push(await request(profile, "xhigh")); }
      catch (error) { observations.push({ modelId: profile.modelId, executionProfileId: profile.executionProfileId, protocol: "responses",
        requestedEffort: "xhigh", wireEffort: "xhigh", httpStatus: 0, streaming: false, toolCall: false, usagePresent: false,
        reasoningTokens: 0, accepted: false, status: "rejected", effectStatus: "effect_unverified",
        errorSummary: outputSummary(error instanceof Error ? error.message : String(error)) }); }
    }
  }
}

const report = { schemaVersion: "acu-reasoning-capability-probe-v1", executedAt: new Date().toISOString(), representativeProfileOnly: true,
  qualityEffectVerified: false, modelCount: representatives.length, requestCount: observations.length, observations };
const jsonPath = resolve(`reports/reasoning-capability-probe-${runDate}.json`);
const mdPath = resolve(`reports/reasoning-capability-probe-${runDate}.md`);
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
const rows = observations.map((row) => `| ${row.modelId} | ${row.executionProfileId} | ${row.protocol} | ${row.requestedEffort} | ${row.wireEffort} | ${row.httpStatus} | ${row.status} | ${row.streaming} | ${row.toolCall} | ${row.usagePresent} | ${row.reasoningTokens} | ${String(row.errorSummary ?? "").replaceAll("|", "\\|")} |`);
await writeFile(mdPath, `# Reasoning Capability Probe ${runDate}\n\nHTTP acceptance is transport evidence only. Quality effect remains effect_unverified.\n\n| Model | Representative Profile | Protocol | Requested | Wire | HTTP | Status | Stream | Tool | Usage | Reasoning Tokens | Error |\n|---|---|---|---|---:|---:|---|---|---|---|---:|---|\n${rows.join("\n")}\n`);
console.log(JSON.stringify({ modelCount: representatives.length, requestCount: observations.length,
  accepted: observations.filter((item) => item.accepted === true).length, rejected: observations.filter((item) => item.accepted !== true).length,
  jsonPath, mdPath }));
