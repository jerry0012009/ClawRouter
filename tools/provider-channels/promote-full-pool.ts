#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAcuModel } from "../../src/acu/catalog.js";
import { readProviderChannelRegistry, readProviderModelProfiles, validateProviderModelProfiles } from "../../src/alpha/channel-registry.js";

type Json = Record<string, unknown>;
type Observation = Json & {
  executionProfileId: string;
  channelId: string;
  providerId: string;
  model: string;
  protocol: "responses" | "messages";
  status: string;
  actualModels?: string[];
  usage?: { input?: number; output?: number };
};

function observations(value: Json, protocol?: "responses" | "messages"): Observation[] {
  const rows = Array.isArray(value.observations) ? value.observations as Observation[] : [];
  return rows.filter((row) => row.status === "passed" && (!protocol || row.protocol === protocol));
}

async function main(): Promise<void> {
  const executionPath = resolve("deploy/alpha/execution-profiles.json");
  const modelProfilesPath = resolve("deploy/alpha/provider-model-profiles.json");
  const channelsPath = resolve("deploy/alpha/provider-channels.json");
  const existing = JSON.parse(await readFile(executionPath, "utf8")) as Json[];
  const channelRegistry = await readProviderChannelRegistry(channelsPath);
  const modelRegistry = await readProviderModelProfiles(modelProfilesPath);
  const responseRun = JSON.parse(await readFile(resolve("deploy/alpha/full-pool-preflight-observations.json"), "utf8")) as Json;
  const messageRun = JSON.parse(await readFile(resolve("deploy/alpha/full-pool-preflight-messages-observations.json"), "utf8")) as Json;
  const passed = [...observations(responseRun, "responses"), ...observations(messageRun, "messages")];
  const passedById = new Map(passed.map((row) => [row.executionProfileId, row]));
  const existingById = new Map(existing.map((row) => [String(row.executionProfileId), row]));

  for (const profile of modelRegistry.profiles) {
    const proof = passedById.get(profile.executionProfileId);
    if (!proof) continue;
    const aliases = [...new Set((proof.actualModels ?? []).filter((model) => model && model !== profile.providerModelId))];
    profile.toolCallSupport = true;
    profile.supportedToolTypes = profile.protocol === "responses" ? ["function", "custom", "local_tool"] : ["function"];
    profile.thinkingSupport = true;
    profile.supportedReasoningEfforts = ["low", "medium", "high"];
    profile.actualModelVerified = true;
    profile.actualModelAliases = aliases;
    profile.usageTrusted = true;
    profile.effectivePriceAvailable = true;
    profile.health = "healthy";
    profile.healthReason = "full_pool_native_tool_sse_usage_preflight_passed";
    profile.lastVerifiedAt = new Date().toISOString();
    profile.activeInAcuAuto = true;
    profile.observedSuccessfulInputTokens = Math.max(profile.observedSuccessfulInputTokens, Number(proof.usage?.input ?? 0));
    profile.contextCapabilityStatus = "observed_floor";
    profile.contextCapabilitySource = "full_pool_native_tool_sse_usage_preflight";
    profile.contextLastVerifiedAt = new Date().toISOString();
  }

  for (const proof of passed) {
    if (existingById.has(proof.executionProfileId)) continue;
    const channel = channelRegistry.channels.find((item) => item.channelId === proof.channelId);
    const modelProfile = modelRegistry.profiles.find((item) => item.executionProfileId === proof.executionProfileId);
    const catalog = getAcuModel(proof.model);
    if (!channel || !modelProfile || !catalog) throw new Error(`Cannot promote ${proof.executionProfileId}`);
    const profile: Json = {
      executionProfileId: proof.executionProfileId,
      modelId: proof.model,
      providerModelId: modelProfile.providerModelId,
      actualModelAliases: modelProfile.actualModelAliases,
      provider: proof.providerId,
      channel: proof.channelId,
      channelId: proof.channelId,
      routingGroupName: channel.routingGroupName,
      protocols: [proof.protocol],
      toolCallSupport: true,
      supportedToolTypes: proof.protocol === "responses" ? ["function", "custom", "local_tool"] : ["function"],
      thinkingSupport: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
      canonicalAdvertisedContextWindow: catalog.contextWindow,
      providerDeclaredContextWindow: null,
      observedSuccessfulInputTokens: Number(proof.usage?.input ?? 0),
      providerHardContextCap: null,
      contextCapabilityStatus: "observed_floor",
      contextCapabilitySource: "full_pool_native_tool_sse_usage_preflight",
      contextLastVerifiedAt: new Date().toISOString(),
      health: "healthy",
      enabled: true,
      administratorAllowed: true,
      usageTrusted: true,
      recentSuccessRate: 1,
      baseUrlEnv: channel.primaryBaseUrlEnv,
      networkFallbackBaseUrlEnvs: channel.networkFallbackBaseUrlEnvs,
      apiKeyEnv: channel.apiKeyEnv,
      authMode: proof.protocol === "responses" ? "bearer" : "x-api-key",
      ...(proof.protocol === "responses" ? { stripV1Path: true } : { anthropicVersion: "2023-06-01" }),
      economicsProviderId: proof.providerId,
      observedBillingMultiplier: channel.observedBillingMultiplier,
      effectiveCostStatus: channel.effectiveCostStatus,
      requiresFreshProbe: false,
      ...(proof.protocol === "responses" ? {
        webToolDeclarationAccepted: false,
        webSearchExecutionVerified: false,
        webSearchStreamingVerified: false,
        webSearchResultVerified: false,
        webSearchFailureReason: "not_verified_for_full_pool_profile",
      } : {}),
    };
    existing.push(profile);
    existingById.set(proof.executionProfileId, profile);
  }

  const activeChannels = new Set(existing.filter((profile) => profile.enabled === true && profile.administratorAllowed === true)
    .map((profile) => String(profile.channelId ?? profile.channel)));
  for (const channel of channelRegistry.channels) {
    if (activeChannels.has(channel.channelId)) channel.activationStatus = "active";
  }
  modelRegistry.generatedAt = new Date().toISOString();
  validateProviderModelProfiles(modelRegistry);
  const sorted = existing.sort((left, right) => String(left.modelId).localeCompare(String(right.modelId))
    || String(left.provider).localeCompare(String(right.provider))
    || String(left.channel).localeCompare(String(right.channel))
    || String(left.protocols).localeCompare(String(right.protocols)));
  await writeFile(executionPath, `${JSON.stringify(sorted, null, 2)}\n`);
  await writeFile(modelProfilesPath, `${JSON.stringify(modelRegistry, null, 2)}\n`);
  await writeFile(channelsPath, `${JSON.stringify(channelRegistry, null, 2)}\n`);
  await writeFile(resolve("deploy/alpha/full-pool-qualified-profiles.json"), `${JSON.stringify({
    schemaVersion: "acu-full-pool-qualified-profiles-v1",
    generatedAt: new Date().toISOString(),
    profileCount: passed.length,
    channelCount: new Set(passed.map((row) => row.channelId).values()).size,
    modelCount: new Set(passed.map((row) => row.model).values()).size,
    executionProfileIds: passed.map((row) => row.executionProfileId).sort(),
  }, null, 2)}\n`);
  console.log(JSON.stringify({ totalExecutionProfiles: sorted.length, newlyQualifiedProfiles: passed.length,
    activeChannels: activeChannels.size, models: new Set(sorted.map((profile) => String(profile.modelId))).size }));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Full-pool promotion failed");
  process.exitCode = 1;
});
