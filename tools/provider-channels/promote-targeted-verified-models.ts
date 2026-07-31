#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAcuModel } from "../../src/acu/catalog.js";
import {
  readProviderChannelRegistry,
  readProviderModelProfiles,
  validateProviderChannelRegistry,
  validateProviderModelProfiles,
} from "../../src/alpha/channel-registry.js";

type Json = Record<string, unknown>;

const targets = [
  {
    executionProfileId: "lucen-kiro-cache70-claude-006:claude-fable-5:messages",
    modelId: "claude-fable-5",
    providerModelId: "claude-fable-5",
    channelId: "lucen-kiro-cache70-claude-006",
    protocol: "messages" as const,
    observedInputTokens: 66,
    supportedToolTypes: ["function"],
    effectiveCostStatus: "estimated",
    observedBillingMultiplier: 0.06,
    verificationStatus: "verified",
    requiresFreshProbe: false,
  },
  {
    executionProfileId: "lucen-kimi-k3-openai-040:kimi-k3:responses",
    modelId: "kimi-k3",
    providerModelId: "kimi-k3",
    channelId: "lucen-kimi-k3-openai-040",
    protocol: "responses" as const,
    observedInputTokens: 59_482,
    supportedToolTypes: ["function", "custom", "local_tool"],
    effectiveCostStatus: "verified",
    // Lucen charged CNY 0.039432 for 4,594 input and 67 output tokens.
    // Against official K3 pricing ($3/$15), this is an effective 8/3 cash multiplier.
    observedBillingMultiplier: 8 / 3,
    verificationStatus: "verified_provisional",
    requiresFreshProbe: true,
  },
];

const channelsPath = resolve("deploy/alpha/provider-channels.json");
const modelProfilesPath = resolve("deploy/alpha/provider-model-profiles.json");
const executionProfilesPath = resolve("deploy/alpha/execution-profiles.json");
const channels = await readProviderChannelRegistry(channelsPath);
const modelProfiles = await readProviderModelProfiles(modelProfilesPath);
const executionProfiles = JSON.parse(await readFile(executionProfilesPath, "utf8")) as Json[];

for (const target of targets) {
  const channel = channels.channels.find((item) => item.channelId === target.channelId);
  const model = getAcuModel(target.modelId);
  if (!channel || !model) throw new Error(`Missing channel or model for ${target.executionProfileId}`);

  const modelProfile = {
    executionProfileId: target.executionProfileId,
    channelId: target.channelId,
    providerId: channel.providerId,
    canonicalModelId: target.modelId,
    providerModelId: target.providerModelId,
    actualModelAliases: [],
    protocol: target.protocol,
    toolCallSupport: true,
    supportedToolTypes: target.supportedToolTypes,
    thinkingSupport: true,
    supportedReasoningEfforts: ["low", "medium", "high"],
    actualModelVerified: true,
    usageTrusted: true,
    effectivePriceAvailable: true,
    effectiveCostStatus: target.effectiveCostStatus,
    health: "healthy",
    healthReason: "targeted_native_tool_sse_usage_preflight_passed",
    lastVerifiedAt: "2026-07-31T10:50:00.000Z",
    activeInAcuAuto: true,
    canonicalAdvertisedContextWindow: model.contextWindow,
    providerDeclaredContextWindow: target.modelId === "kimi-k3" ? 1_048_576 : null,
    observedSuccessfulInputTokens: target.observedInputTokens,
    providerHardContextCap: null,
    contextCapabilityStatus: "observed_floor",
    contextCapabilitySource: target.modelId === "kimi-k3"
      ? "official_kimi_k3_spec_and_live_59482_token_preflight"
      : "targeted_native_tool_sse_usage_preflight",
    contextLastVerifiedAt: "2026-07-31T10:50:00.000Z",
  };
  const modelIndex = modelProfiles.profiles.findIndex((item) => item.executionProfileId === target.executionProfileId);
  if (modelIndex >= 0) modelProfiles.profiles[modelIndex] = modelProfile;
  else modelProfiles.profiles.push(modelProfile);

  const executionProfile: Json = {
    executionProfileId: target.executionProfileId,
    modelId: target.modelId,
    providerModelId: target.providerModelId,
    actualModelAliases: [],
    provider: channel.providerId,
    channel: target.channelId,
    channelId: target.channelId,
    routingGroupName: channel.routingGroupName,
    protocols: [target.protocol],
    toolCallSupport: true,
    supportedToolTypes: target.supportedToolTypes,
    thinkingSupport: true,
    supportedReasoningEfforts: ["low", "medium", "high"],
    canonicalAdvertisedContextWindow: model.contextWindow,
    providerDeclaredContextWindow: target.modelId === "kimi-k3" ? 1_048_576 : null,
    observedSuccessfulInputTokens: target.observedInputTokens,
    providerHardContextCap: null,
    contextCapabilityStatus: "observed_floor",
    contextCapabilitySource: modelProfile.contextCapabilitySource,
    contextLastVerifiedAt: modelProfile.contextLastVerifiedAt,
    health: "healthy",
    enabled: true,
    administratorAllowed: true,
    usageTrusted: true,
    recentSuccessRate: 1,
    baseUrlEnv: channel.primaryBaseUrlEnv,
    networkFallbackBaseUrlEnvs: channel.networkFallbackBaseUrlEnvs,
    apiKeyEnv: channel.apiKeyEnv,
    authMode: target.protocol === "messages" ? "x-api-key" : "bearer",
    ...(target.protocol === "messages" ? { anthropicVersion: "2023-06-01" } : { stripV1Path: true }),
    economicsProviderId: channel.providerId,
    observedBillingMultiplier: target.observedBillingMultiplier,
    effectiveCostStatus: target.effectiveCostStatus,
    requiresFreshProbe: target.requiresFreshProbe,
    modelCategory: "text_agent",
    verificationStatus: target.verificationStatus,
    autoRouteEnabled: true,
  };
  const executionIndex = executionProfiles.findIndex((item) => item.executionProfileId === target.executionProfileId);
  if (executionIndex >= 0) executionProfiles[executionIndex] = executionProfile;
  else executionProfiles.push(executionProfile);
  channel.activationStatus = "active";
}

modelProfiles.generatedAt = "2026-07-31T10:50:00.000Z";
validateProviderModelProfiles(modelProfiles);
validateProviderChannelRegistry(channels);
executionProfiles.sort((left, right) => String(left.modelId).localeCompare(String(right.modelId))
  || String(left.provider).localeCompare(String(right.provider))
  || String(left.channel).localeCompare(String(right.channel)));
await writeFile(modelProfilesPath, `${JSON.stringify(modelProfiles, null, 2)}\n`);
await writeFile(executionProfilesPath, `${JSON.stringify(executionProfiles, null, 2)}\n`);
await writeFile(channelsPath, `${JSON.stringify(channels, null, 2)}\n`);
console.log(JSON.stringify({ promoted: targets.map((item) => item.executionProfileId) }));
