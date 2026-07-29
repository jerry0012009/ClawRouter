import { readFile } from "node:fs/promises";

export type ChannelActivationStatus = "active" | "inactive" | "needs_mapping" | "disabled";
export type ChannelDiscoveryStatus = "pending" | "success" | "auth_failed" | "unavailable" | "failed";

export type ProviderChannel = {
  channelId: string;
  providerId: string;
  providerAccountId: string;
  displayName: string;
  routingGroupName: string;
  routingGroupSlug: string;
  protocolCandidates: string[];
  apiKeyEnv: string;
  primaryBaseUrlEnv: string;
  networkFallbackBaseUrlEnvs: string[];
  rechargeCashRatioCnyPerCreditUsd: number | null;
  effectiveCostStatus: "verified" | "estimated" | "missing";
  effectiveCostSource: string;
  observedBillingMultiplier: number | null;
  multiplierStatus: "observed" | "estimated" | "unknown";
  enabled: boolean;
  discoveryStatus: ChannelDiscoveryStatus;
  activationStatus: ChannelActivationStatus;
  notes: string[];
};

export type ProviderChannelRegistry = {
  schemaVersion: "acu-provider-channel-registry-v1";
  generatedAt: string;
  channels: ProviderChannel[];
};

export type ProviderModelProfile = {
  executionProfileId: string;
  channelId: string;
  providerId: string;
  canonicalModelId: string;
  providerModelId: string;
  actualModelAliases?: string[];
  protocol: "responses" | "messages" | "chat_completions";
  toolCallSupport: boolean;
  supportedToolTypes: string[];
  thinkingSupport: boolean;
  supportedReasoningEfforts: string[];
  canonicalAdvertisedContextWindow: number | null;
  providerDeclaredContextWindow: number | null;
  observedSuccessfulInputTokens: number;
  providerHardContextCap: number | null;
  contextCapabilityStatus: "verified" | "observed_floor" | "unverified_long_context" | "provider_capped";
  contextCapabilitySource: string;
  contextLastVerifiedAt: string | null;
  actualModelVerified: boolean;
  usageTrusted: boolean;
  effectivePriceAvailable: boolean;
  effectiveCostStatus: "verified" | "estimated" | "missing";
  health: "healthy" | "degraded" | "open" | "half_open" | "disabled";
  healthReason: string;
  lastVerifiedAt: string | null;
  webToolDeclarationAccepted?: boolean;
  webSearchExecutionVerified?: boolean;
  webSearchStreamingVerified?: boolean;
  webSearchResultVerified?: boolean;
  webSearchRecentSuccessRate?: number;
  webSearchObservedLatencyMs?: number | null;
  webSearchLastVerifiedAt?: string | null;
  webSearchFailureReason?: string | null;
  activeInAcuAuto: boolean;
};

export type ProviderModelProfileRegistry = {
  schemaVersion: "acu-provider-model-profile-registry-v1";
  generatedAt: string;
  profiles: ProviderModelProfile[];
};

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${field}`);
}

export function validateProviderChannelRegistry(value: unknown): ProviderChannelRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Channel Registry must be an object");
  const registry = value as Partial<ProviderChannelRegistry>;
  if (registry.schemaVersion !== "acu-provider-channel-registry-v1" || !Array.isArray(registry.channels)) {
    throw new Error("Unsupported Channel Registry schema");
  }
  const ids = new Set<string>();
  const secretEnvs = new Set<string>();
  for (const channel of registry.channels) {
    nonEmpty(channel.channelId, "channelId");
    nonEmpty(channel.providerId, "providerId");
    nonEmpty(channel.apiKeyEnv, "apiKeyEnv");
    nonEmpty(channel.primaryBaseUrlEnv, "primaryBaseUrlEnv");
    if (ids.has(channel.channelId)) throw new Error(`Duplicate channelId ${channel.channelId}`);
    if (secretEnvs.has(channel.apiKeyEnv)) throw new Error(`One API Key environment variable may identify only one Channel: ${channel.apiKeyEnv}`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(channel.apiKeyEnv)) throw new Error(`Invalid apiKeyEnv ${channel.apiKeyEnv}`);
    ids.add(channel.channelId);
    secretEnvs.add(channel.apiKeyEnv);
  }
  return registry as ProviderChannelRegistry;
}

export function validateProviderModelProfiles(value: unknown): ProviderModelProfileRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Profile Registry must be an object");
  const registry = value as Partial<ProviderModelProfileRegistry>;
  if (registry.schemaVersion !== "acu-provider-model-profile-registry-v1" || !Array.isArray(registry.profiles)) {
    throw new Error("Unsupported Profile Registry schema");
  }
  const ids = new Set<string>();
  for (const profile of registry.profiles) {
    nonEmpty(profile.executionProfileId, "executionProfileId");
    nonEmpty(profile.channelId, "channelId");
    nonEmpty(profile.canonicalModelId, "canonicalModelId");
    nonEmpty(profile.providerModelId, "providerModelId");
    if (ids.has(profile.executionProfileId)) throw new Error(`Duplicate executionProfileId ${profile.executionProfileId}`);
    ids.add(profile.executionProfileId);
    if (profile.activeInAcuAuto && (!profile.actualModelVerified || !profile.usageTrusted || !profile.effectivePriceAvailable)) {
      throw new Error(`${profile.executionProfileId}: active Profile lacks verified model, Usage, or price`);
    }
  }
  return registry as ProviderModelProfileRegistry;
}

export async function readProviderChannelRegistry(path: string): Promise<ProviderChannelRegistry> {
  return validateProviderChannelRegistry(JSON.parse(await readFile(path, "utf8")) as unknown);
}

export async function readProviderModelProfiles(path: string): Promise<ProviderModelProfileRegistry> {
  return validateProviderModelProfiles(JSON.parse(await readFile(path, "utf8")) as unknown);
}
