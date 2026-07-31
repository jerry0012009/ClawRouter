import type { ConfiguredExecutionProfile } from "./server.js";
import { deriveRuntimeEligibility } from "./channel-health.js";

export type MonitorRange = "1h" | "6h" | "24h" | "7d";

export type MonitorHealthRow = Record<string, unknown>;

export function monitorRangeSpec(range: MonitorRange): { interval: string; bucket: string } {
  if (range === "7d") return { interval: "7 days", bucket: "1 hour" };
  if (range === "24h") return { interval: "24 hours", bucket: "15 minutes" };
  if (range === "6h") return { interval: "6 hours", bucket: "5 minutes" };
  return { interval: "1 hour", bucket: "1 minute" };
}

function stateOf(row: MonitorHealthRow): string {
  return String(row.circuit_state ?? "healthy");
}

function runtimeRecovered(profile: ConfiguredExecutionProfile, runtime: MonitorHealthRow): boolean {
  return profile.autoRouteEnabled === false && runtime.usage_trusted === true
    && Boolean(runtime.last_success_at)
    && !["open", "half_open", "disabled"].includes(stateOf(runtime));
}

export function monitorRoutingStatus(
  profile: ConfiguredExecutionProfile,
  channel: MonitorHealthRow,
  runtime: MonitorHealthRow,
):
  | "eligible"
  | "cooldown"
  | "half_open_probe_only"
  | "profile_disabled"
  | "usage_untrusted"
  | "administrator_blocked" {
  if (!profile.enabled || profile.health === "disabled" || stateOf(runtime) === "disabled")
    return "profile_disabled";
  if (profile.autoRouteEnabled === false && !runtimeRecovered(profile, runtime)) return "profile_disabled";
  if (!profile.administratorAllowed) return "administrator_blocked";
  if (
    runtime.usage_trusted === false ||
    (runtime.usage_trusted == null && profile.usageTrusted === false)
  )
    return "usage_untrusted";
  if (stateOf(channel) === "open" || stateOf(runtime) === "open") return "cooldown";
  if (stateOf(channel) === "half_open" || stateOf(runtime) === "half_open")
    return "half_open_probe_only";
  return "eligible";
}

export function combinedMonitorState(
  profile: ConfiguredExecutionProfile,
  channel: MonitorHealthRow,
  runtime: MonitorHealthRow,
): string {
  const derived = deriveRuntimeEligibility({
    profileState: stateOf(runtime) === "healthy" ? profile.health : stateOf(runtime),
    channelState: stateOf(channel),
    providerState: "healthy",
    probeState: profile.requiresFreshProbe && !runtime.last_success_at ? "stale" : "fresh",
    enabled: profile.enabled,
    administratorAllowed: profile.administratorAllowed,
  });
  if (derived.effectiveState === "temporarily_unavailable") {
    return [stateOf(channel), stateOf(runtime)].includes("half_open") ? "half_open" : "open";
  }
  return derived.effectiveState;
}

type DiscoveryChannel = {
  channelId?: string;
  providerId?: string;
  status?: string;
  httpStatus?: number;
  endpointHost?: string;
  exactCanonicalMatches?: string[];
  responsesCandidates?: string[];
  messagesCandidates?: string[];
  [key: string]: unknown;
};

type PreflightObservation = {
  executionProfileId?: string;
  channelId?: string;
  providerId?: string;
  model?: string;
  status?: string;
  errorClass?: string;
  activated?: boolean;
};

function inventoryKey(channelId: string, model: string, protocol: string): string {
  return `${channelId}\n${model}\n${protocol}`;
}

export function mergeSupplyInventory(
  discoveryChannels: DiscoveryChannel[],
  profiles: ConfiguredExecutionProfile[],
  preflightObservations: PreflightObservation[],
): Array<Record<string, unknown>> {
  const allProfiles = profiles.filter((profile) => profile.enabled && profile.administratorAllowed);
  const activeProfiles = allProfiles.filter((profile) => profile.autoRouteEnabled !== false);
  const profileByKey = new Map<string, ConfiguredExecutionProfile[]>();
  for (const profile of allProfiles) {
    for (const protocol of profile.protocols) {
      const key = inventoryKey(profile.channelId ?? profile.channel, profile.modelId, protocol);
      profileByKey.set(key, [...(profileByKey.get(key) ?? []), profile]);
    }
  }
  const preflightByKey = new Map<string, PreflightObservation>();
  for (const observation of preflightObservations) {
    if (!observation.channelId || !observation.model) continue;
    const protocol = observation.executionProfileId?.split(":").at(-1) ?? "responses";
    preflightByKey.set(
      inventoryKey(observation.channelId, observation.model, protocol),
      observation,
    );
  }

  const rows = new Map<string, Record<string, unknown>>();
  const addRow = (channel: DiscoveryChannel, model: string, protocol: string) => {
    const channelId = String(channel.channelId ?? "");
    const key = inventoryKey(channelId, model, protocol);
    const matchingProfiles = profileByKey.get(key) ?? [];
    const activeMatches = matchingProfiles.filter((profile) => profile.autoRouteEnabled !== false);
    const preflight = preflightByKey.get(key);
    const modelListVerified = channel.status === "success" && Number(channel.httpStatus) === 200;
    const rejected = preflight?.status === "failed";
    const routingActive = activeMatches.length > 0 && !rejected;
    const rejectionReason = rejected
      ? preflight?.errorClass === "provider_http_503"
        ? "rejected_http_503"
        : String(preflight?.errorClass ?? "rejected_preflight")
      : routingActive
        ? null
        : "inventory_only";
    rows.set(key, {
      channelId,
      providerId:
        channel.providerId ?? matchingProfiles[0]?.provider ?? preflight?.providerId ?? "",
      endpointHost: channel.endpointHost ?? "",
      canonicalModel: model,
      protocol,
      discoveryStatus: channel.status ?? "not_discovered",
      modelListVerified,
      protocolVerified: routingActive || preflight?.status === "passed",
      routingActive,
      activeExecutionProfileIds: activeMatches.map((profile) => profile.executionProfileId),
      supplyExecutionProfileIds: matchingProfiles.map((profile) => profile.executionProfileId),
      rejectionReason,
      verificationState: routingActive ? "routing_active" : rejectionReason,
    });
  };

  for (const channel of discoveryChannels) {
    const responses = new Set(channel.responsesCandidates ?? []);
    const messages = new Set(channel.messagesCandidates ?? []);
    const models = new Set([...(channel.exactCanonicalMatches ?? []), ...responses, ...messages]);
    if (models.size === 0) addRow(channel, "", "undetermined");
    for (const model of models) {
      if (responses.has(model)) addRow(channel, model, "responses");
      if (messages.has(model)) addRow(channel, model, "messages");
      if (!responses.has(model) && !messages.has(model)) addRow(channel, model, "undetermined");
    }
  }
  for (const profile of activeProfiles) {
    for (const protocol of profile.protocols) {
      const key = inventoryKey(profile.channelId ?? profile.channel, profile.modelId, protocol);
      if (!rows.has(key))
        addRow(
          {
            channelId: profile.channelId ?? profile.channel,
            providerId: profile.provider,
            status: "not_discovered",
          },
          profile.modelId,
          protocol,
        );
    }
  }
  return [...rows.values()].sort((left, right) =>
    inventoryKey(
      String(left.channelId),
      String(left.canonicalModel),
      String(left.protocol),
    ).localeCompare(
      inventoryKey(String(right.channelId), String(right.canonicalModel), String(right.protocol)),
    ),
  );
}
