#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertSupplyProfileConservation, readProviderChannelRegistry, readProviderModelProfiles,
  type ProviderModelProfile, type SupplyProfileStatus } from "../../src/alpha/channel-registry.js";

type PreflightObservation = { executionProfileId?: string; status?: string; errorClass?: string };

function supplyStatus(profile: ProviderModelProfile, observation?: PreflightObservation): SupplyProfileStatus {
  if (profile.activeInAcuAuto) return "active";
  if (["actual_model_mismatch", "model_not_found", "protocol_incompatible", "administrator_disabled"]
    .some((reason) => `${profile.healthReason}:${observation?.errorClass ?? ""}`.includes(reason))) return "rejected";
  if (observation?.status === "failed" || /timeout|network|provider_5xx/.test(profile.healthReason)) {
    return "temporarily_unavailable";
  }
  return "probe_pending";
}

async function main(): Promise<void> {
  const path = resolve("deploy/alpha/execution-profiles.json");
  const existing = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
  const channels = await readProviderChannelRegistry(resolve("deploy/alpha/provider-channels.json"));
  const profiles = await readProviderModelProfiles(resolve("deploy/alpha/provider-model-profiles.json"));
  const discovery = JSON.parse(await readFile(resolve("deploy/alpha/provider-channel-model-discovery.json"), "utf8")) as {
    channels: Array<{ channelId: string; responsesCandidates?: string[]; messagesCandidates?: string[] }> };
  const preflight = JSON.parse(await readFile(resolve("deploy/alpha/full-pool-preflight-observations.json"), "utf8")) as {
    observations?: PreflightObservation[] };
  const observations = new Map((preflight.observations ?? []).flatMap((item) => item.executionProfileId ? [[item.executionProfileId, item]] : []));
  const supplyProfiles = profiles.profiles.map((profile) => {
    const observation = observations.get(profile.executionProfileId);
    const status = supplyStatus(profile, observation);
    return { ...profile, status, activeInRouting: status === "active",
      lastProbeStatus: observation?.status, consecutiveProbeFailures: observation?.status === "failed" ? 1 : 0,
      statusReason: observation?.errorClass ?? profile.healthReason };
  });
  const discoveredIds = discovery.channels.flatMap((channel) => [
    ...(channel.responsesCandidates ?? []).map((model) => `${channel.channelId}:${model}:responses`),
    ...(channel.messagesCandidates ?? []).map((model) => `${channel.channelId}:${model}:messages`),
  ]);
  const targetedVerifiedIds = supplyProfiles.filter((profile) => profile.activeInAcuAuto
    && !discoveredIds.includes(profile.executionProfileId)).map((profile) => profile.executionProfileId);
  assertSupplyProfileConservation([...discoveredIds, ...targetedVerifiedIds], supplyProfiles);
  await writeFile(resolve("deploy/alpha/provider-model-profiles.json"), `${JSON.stringify({ ...profiles, profiles: supplyProfiles }, null, 2)}\n`);
  const retained = existing.filter((item) => item.provider === "closeai").map((item) => ({
    ...item,
    supportedToolTypes: Array.isArray(item.supportedToolTypes)
      ? item.supportedToolTypes.filter((value) => value !== "hosted_web_search")
      : item.supportedToolTypes,
    effectiveCostStatus: item.effectiveCostStatus ?? "verified",
    reasoningControlMode: Array.isArray(item.protocols) && item.protocols.includes("responses")
      && Array.isArray(item.supportedReasoningEfforts) && item.supportedReasoningEfforts.includes("high")
      ? "standard_effort" : "none",
  }));
  // Keep every discovered canonical profile in the runtime registry.  Routing
  // eligibility is derived from autoRouteEnabled/runtime health; discovery or
  // a transient preflight failure must not erase the recovery target.
  const promoted = supplyProfiles.map((profile) => {
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
      reasoningControlMode: profile.protocol === "responses"
        && profile.supportedReasoningEfforts.includes("high")
        ? "standard_effort"
        : profile.protocol === "messages" && profile.thinkingSupport
          ? "client_thinking_passthrough"
          : "none",
      canonicalAdvertisedContextWindow: profile.canonicalAdvertisedContextWindow,
      providerDeclaredContextWindow: profile.providerDeclaredContextWindow,
      observedSuccessfulInputTokens: profile.observedSuccessfulInputTokens,
      providerHardContextCap: profile.providerHardContextCap,
      contextCapabilityStatus: profile.contextCapabilityStatus,
      contextCapabilitySource: profile.contextCapabilitySource,
      contextLastVerifiedAt: profile.contextLastVerifiedAt,
      health: profile.activeInAcuAuto ? "healthy" : "degraded",
      enabled: true,
      administratorAllowed: true,
      usageTrusted: profile.activeInAcuAuto ? profile.usageTrusted : true,
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
      webTransportStatus: profile.webTransportStatus,
      autoRouteEnabled: profile.activeInAcuAuto,
      requiresFreshProbe: !profile.activeInAcuAuto,
    };
  });
  await writeFile(path, `${JSON.stringify([...promoted, ...retained], null, 2)}\n`);
  console.log(JSON.stringify({ promoted: promoted.length, retained: retained.length, total: promoted.length + retained.length }));
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "Profile sync failed"); process.exitCode = 1; });
