#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readProviderChannelRegistry, readProviderModelProfiles } from "../../src/alpha/channel-registry.js";

async function main(): Promise<void> {
  const path = resolve("deploy/alpha/execution-profiles.json");
  const existing = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
  const channels = await readProviderChannelRegistry(resolve("deploy/alpha/provider-channels.json"));
  const profiles = await readProviderModelProfiles(resolve("deploy/alpha/provider-model-profiles.json"));
  const retained = existing.filter((item) => item.provider === "closeai").map((item) => ({
    ...item,
    supportedToolTypes: Array.isArray(item.supportedToolTypes)
      ? item.supportedToolTypes.filter((value) => value !== "hosted_web_search")
      : item.supportedToolTypes,
    effectiveCostStatus: item.effectiveCostStatus ?? "verified",
  }));
  const promoted = profiles.profiles.filter((item) => item.activeInAcuAuto).map((profile) => {
    const channel = channels.channels.find((item) => item.channelId === profile.channelId)!;
    return {
      executionProfileId: profile.executionProfileId,
      modelId: profile.canonicalModelId,
      providerModelId: profile.providerModelId,
      actualModelAliases: profile.actualModelAliases,
      provider: profile.providerId,
      channel: profile.channelId,
      channelId: profile.channelId,
      routingGroupName: channel.routingGroupName,
      protocols: [profile.protocol],
      toolCallSupport: profile.toolCallSupport,
      supportedToolTypes: profile.supportedToolTypes.filter((value) => value !== "hosted_web_search"),
      thinkingSupport: profile.thinkingSupport,
      supportedReasoningEfforts: profile.supportedReasoningEfforts,
      contextWindow: profile.contextWindow,
      health: "healthy",
      enabled: true,
      administratorAllowed: true,
      usageTrusted: profile.usageTrusted,
      recentSuccessRate: 1,
      baseUrlEnv: channel.primaryBaseUrlEnv,
      networkFallbackBaseUrlEnvs: channel.networkFallbackBaseUrlEnvs,
      apiKeyEnv: channel.apiKeyEnv,
      authMode: "bearer",
      stripV1Path: true,
      economicsProviderId: channel.providerId,
      observedBillingMultiplier: channel.observedBillingMultiplier,
      effectiveCostStatus: channel.effectiveCostStatus,
      webToolDeclarationAccepted: profile.webToolDeclarationAccepted,
      webSearchExecutionVerified: profile.webSearchExecutionVerified,
      webSearchStreamingVerified: profile.webSearchStreamingVerified,
      webSearchResultVerified: profile.webSearchResultVerified,
      webSearchRecentSuccessRate: profile.webSearchRecentSuccessRate,
      webSearchObservedLatencyMs: profile.webSearchObservedLatencyMs,
      webSearchLastVerifiedAt: profile.webSearchLastVerifiedAt,
      webSearchFailureReason: profile.webSearchFailureReason,
    };
  });
  await writeFile(path, `${JSON.stringify([...promoted, ...retained], null, 2)}\n`);
  console.log(JSON.stringify({ promoted: promoted.length, retained: retained.length, total: promoted.length + retained.length }));
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "Profile sync failed"); process.exitCode = 1; });
