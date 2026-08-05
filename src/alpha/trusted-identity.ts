import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { RoutingPreference } from "./routing.js";
import {
  DEFAULT_ROUTING_UTILITY_POLICY,
  type FormulaMode,
  type LatencyPolicy,
  type ReliabilityPolicy,
  type RoutingUtilityPolicy,
  type SupplyStrategy,
  type SupplyWeights,
} from "./routing-utility-v2.js";

const INTERNAL_HEADER_NAMES = [
  "x-acu-newapi-user-id",
  "x-acu-newapi-token-id",
  "x-acu-newapi-log-id",
  "x-acu-request-id",
  "x-acu-client-version",
  "x-acu-routing-policy",
  "x-acu-allowed-model-ids",
  "x-acu-allowed-profile-ids",
  "x-acu-routing-policy-version",
  "x-acu-routing-preference",
  "x-acu-quality-bias",
  "x-acu-supply-strategy",
  "x-acu-supply-weights",
  "x-acu-high-bias-offset",
  "x-acu-model-cost-log-scale",
  "x-acu-profile-cost-log-scale",
  "x-acu-profile-speed-log-scale",
  "x-acu-latency-policy",
  "x-acu-reliability-policy",
  "x-acu-work-phase-bias-offsets",
  "x-acu-allowed-candidate-ids",
  "x-acu-candidate-preference-scores",
  "x-acu-routing-utility-version",
  "x-acu-formula-mode",
  "x-acu-identity-version",
  "x-acu-timestamp",
  "x-acu-body-sha256",
  "x-acu-signature",
] as const;

export type TrustedNewApiIdentity = {
  newapiUserId: string;
  newapiTokenId: string;
  newapiLogId: string;
  requestId: string;
  clientVersion?: string;
  routingPolicy: "all_routing_eligible" | "custom_allowlist" | "explicit_only";
  allowedModelIds: string[];
  allowedProfileIds: string[];
  routingPolicyVersion: string;
  routingPreference: RoutingPreference;
  qualityBias?: number;
  supplyStrategy?: SupplyStrategy;
  supplyWeights?: SupplyWeights;
  acuHighBiasOffset?: number;
  modelCostLogScale?: number;
  profileCostLogScale?: number;
  profileSpeedLogScale?: number;
  latencyPolicy?: LatencyPolicy;
  reliabilityPolicy?: ReliabilityPolicy;
  workPhaseBiasOffsets?: RoutingUtilityPolicy["workPhaseBiasOffsets"];
  allowedCandidateIds?: string[];
  candidatePreferenceScores?: Record<string, number>;
  routingUtilityVersion?: string;
  formulaMode?: FormulaMode;
  identityVersion?: "v2" | "v3" | "v4";
  timestamp: string;
  bodySha256: string;
};

export type IdentityVerificationOptions = {
  sharedSecret: string;
  now?: Date;
  maxClockSkewSeconds?: number;
};

function singleHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  if (Array.isArray(value) || typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing or repeated trusted identity header: ${name}`);
  }
  return value;
}

export function bodySha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function stableCandidatePreferenceScoresJson(scores: Record<string, number>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(scores).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  ));
}

export function trustedIdentitySigningPayload(identity: TrustedNewApiIdentity): string {
  const legacyFields = [
    identity.newapiUserId,
    identity.newapiTokenId,
    identity.newapiLogId,
    identity.requestId,
    identity.clientVersion ?? "unknown",
    identity.routingPolicy,
    JSON.stringify(identity.allowedModelIds),
    JSON.stringify(identity.allowedProfileIds),
    identity.routingPolicyVersion,
    identity.routingPreference,
  ];
  if (identity.identityVersion !== "v3" && identity.identityVersion !== "v4") {
    return [...legacyFields, identity.timestamp, identity.bodySha256].join(
      "\n",
    );
  }
  const utilityFields = [
    ...legacyFields,
    String(identity.qualityBias),
    identity.supplyStrategy,
    JSON.stringify(identity.supplyWeights),
    String(identity.acuHighBiasOffset),
    String(identity.modelCostLogScale),
    String(identity.profileCostLogScale),
    String(identity.profileSpeedLogScale),
    JSON.stringify(identity.latencyPolicy),
    JSON.stringify(identity.reliabilityPolicy),
    JSON.stringify(identity.workPhaseBiasOffsets),
  ];
  return [
    ...utilityFields,
    ...(identity.identityVersion === "v4"
      ? [
          JSON.stringify(identity.allowedCandidateIds ?? []),
          stableCandidatePreferenceScoresJson(identity.candidatePreferenceScores ?? {}),
        ]
      : []),
    identity.routingUtilityVersion,
    identity.formulaMode,
    identity.identityVersion,
    identity.timestamp,
    identity.bodySha256,
  ].join("\n");
}

export function signTrustedIdentity(identity: TrustedNewApiIdentity, sharedSecret: string): string {
  return createHmac("sha256", sharedSecret).update(trustedIdentitySigningPayload(identity)).digest("hex");
}

export function trustedIdentityHeaders(
  identity: TrustedNewApiIdentity,
  sharedSecret: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-acu-newapi-user-id": identity.newapiUserId,
    "x-acu-newapi-token-id": identity.newapiTokenId,
    "x-acu-newapi-log-id": identity.newapiLogId,
    "x-acu-request-id": identity.requestId,
    "x-acu-client-version": identity.clientVersion ?? "unknown",
    "x-acu-routing-policy": identity.routingPolicy,
    "x-acu-allowed-model-ids": JSON.stringify(identity.allowedModelIds),
    "x-acu-allowed-profile-ids": JSON.stringify(identity.allowedProfileIds),
    "x-acu-routing-policy-version": identity.routingPolicyVersion,
    "x-acu-routing-preference": identity.routingPreference,
    "x-acu-timestamp": identity.timestamp,
    "x-acu-body-sha256": identity.bodySha256,
    "x-acu-signature": signTrustedIdentity(identity, sharedSecret),
  };
  if (identity.identityVersion === "v3" || identity.identityVersion === "v4") {
    headers["x-acu-quality-bias"] = String(identity.qualityBias);
    headers["x-acu-supply-strategy"] = String(identity.supplyStrategy);
    headers["x-acu-supply-weights"] = JSON.stringify(identity.supplyWeights);
    headers["x-acu-high-bias-offset"] = String(identity.acuHighBiasOffset);
    headers["x-acu-model-cost-log-scale"] = String(identity.modelCostLogScale);
    headers["x-acu-profile-cost-log-scale"] = String(
      identity.profileCostLogScale,
    );
    headers["x-acu-profile-speed-log-scale"] = String(
      identity.profileSpeedLogScale,
    );
    headers["x-acu-latency-policy"] = JSON.stringify(identity.latencyPolicy);
    headers["x-acu-reliability-policy"] = JSON.stringify(
      identity.reliabilityPolicy,
    );
    headers["x-acu-work-phase-bias-offsets"] = JSON.stringify(
      identity.workPhaseBiasOffsets,
    );
    if (identity.identityVersion === "v4") {
      headers["x-acu-allowed-candidate-ids"] = JSON.stringify(identity.allowedCandidateIds ?? []);
      headers["x-acu-candidate-preference-scores"] = stableCandidatePreferenceScoresJson(
        identity.candidatePreferenceScores ?? {},
      );
    }
    headers["x-acu-routing-utility-version"] = String(
      identity.routingUtilityVersion,
    );
    headers["x-acu-formula-mode"] = String(identity.formulaMode);
    headers["x-acu-identity-version"] = identity.identityVersion;
  }
  return headers;
}

function parseJsonHeader<T>(headers: IncomingHttpHeaders, name: string): T {
  return JSON.parse(singleHeader(headers, name)) as T;
}

function finiteHeader(headers: IncomingHttpHeaders, name: string): number {
  const value = Number(singleHeader(headers, name));
  if (!Number.isFinite(value))
    throw new Error(`Trusted identity numeric header is invalid: ${name}`);
  return value;
}

export function resolvedRoutingUtilityPolicy(
  identity: TrustedNewApiIdentity,
): RoutingUtilityPolicy {
  if (identity.identityVersion !== "v3" && identity.identityVersion !== "v4")
    return {
      ...DEFAULT_ROUTING_UTILITY_POLICY,
      qualityBias:
        identity.routingPreference === "economy"
          ? -60
          : identity.routingPreference === "quality"
            ? 60
            : 0,
      formulaMode: "legacy",
      allowedCandidateIds: [],
      candidatePreferenceScores: {},
    };
  return {
    formulaMode: identity.formulaMode!,
    qualityBias: identity.qualityBias!,
    supplyStrategy: identity.supplyStrategy!,
    supplyWeights: identity.supplyWeights!,
    acuHighBiasOffset: identity.acuHighBiasOffset!,
    modelCostLogScale: identity.modelCostLogScale!,
    profileCostLogScale: identity.profileCostLogScale!,
    profileSpeedLogScale: identity.profileSpeedLogScale!,
    latency: identity.latencyPolicy!,
    reliability: identity.reliabilityPolicy!,
    workPhaseBiasOffsets: identity.workPhaseBiasOffsets!,
    routingUtilityVersion: identity.routingUtilityVersion!,
    allowedCandidateIds: identity.allowedCandidateIds ?? [],
    candidatePreferenceScores: identity.candidatePreferenceScores ?? {},
  };
}

export function verifyTrustedIdentity(
  headers: IncomingHttpHeaders,
  body: Uint8Array,
  options: IdentityVerificationOptions,
): TrustedNewApiIdentity {
  if (!options.sharedSecret) throw new Error("Trusted identity shared secret is not configured");
  const identityVersion =
    headers["x-acu-identity-version"] === undefined
      ? "v2"
      : singleHeader(headers, "x-acu-identity-version");
  if (identityVersion !== "v2" && identityVersion !== "v3" && identityVersion !== "v4")
    throw new Error("Trusted identity version is invalid");
  const identity: TrustedNewApiIdentity = {
    newapiUserId: singleHeader(headers, INTERNAL_HEADER_NAMES[0]),
    newapiTokenId: singleHeader(headers, INTERNAL_HEADER_NAMES[1]),
    newapiLogId: singleHeader(headers, INTERNAL_HEADER_NAMES[2]),
    requestId: singleHeader(headers, INTERNAL_HEADER_NAMES[3]),
    clientVersion: singleHeader(headers, INTERNAL_HEADER_NAMES[4]),
    routingPolicy: singleHeader(headers, INTERNAL_HEADER_NAMES[5]) as TrustedNewApiIdentity["routingPolicy"],
    allowedModelIds: JSON.parse(singleHeader(headers, INTERNAL_HEADER_NAMES[6])) as string[],
    allowedProfileIds: JSON.parse(singleHeader(headers, INTERNAL_HEADER_NAMES[7])) as string[],
    routingPolicyVersion: singleHeader(headers, INTERNAL_HEADER_NAMES[8]),
    routingPreference: singleHeader(headers, INTERNAL_HEADER_NAMES[9]) as RoutingPreference,
    identityVersion,
    timestamp: singleHeader(headers, "x-acu-timestamp"),
    bodySha256: singleHeader(headers, "x-acu-body-sha256"),
  };
  identity.allowedCandidateIds = [];
  identity.candidatePreferenceScores = {};
  if (identityVersion === "v3" || identityVersion === "v4") {
    identity.qualityBias = finiteHeader(headers, "x-acu-quality-bias");
    identity.supplyStrategy = singleHeader(
      headers,
      "x-acu-supply-strategy",
    ) as SupplyStrategy;
    identity.supplyWeights = parseJsonHeader<SupplyWeights>(
      headers,
      "x-acu-supply-weights",
    );
    identity.acuHighBiasOffset = finiteHeader(
      headers,
      "x-acu-high-bias-offset",
    );
    identity.modelCostLogScale = finiteHeader(
      headers,
      "x-acu-model-cost-log-scale",
    );
    identity.profileCostLogScale = finiteHeader(
      headers,
      "x-acu-profile-cost-log-scale",
    );
    identity.profileSpeedLogScale = finiteHeader(
      headers,
      "x-acu-profile-speed-log-scale",
    );
    identity.latencyPolicy = parseJsonHeader<LatencyPolicy>(
      headers,
      "x-acu-latency-policy",
    );
    identity.reliabilityPolicy = parseJsonHeader<ReliabilityPolicy>(
      headers,
      "x-acu-reliability-policy",
    );
    identity.workPhaseBiasOffsets = parseJsonHeader<
      RoutingUtilityPolicy["workPhaseBiasOffsets"]
    >(headers, "x-acu-work-phase-bias-offsets");
    identity.routingUtilityVersion = singleHeader(
      headers,
      "x-acu-routing-utility-version",
    );
    identity.formulaMode = singleHeader(
      headers,
      "x-acu-formula-mode",
    ) as FormulaMode;
    if (identityVersion === "v4") {
      const rawCandidateIDs = singleHeader(headers, "x-acu-allowed-candidate-ids");
      const candidateIDs = JSON.parse(rawCandidateIDs) as unknown;
      if (!Array.isArray(candidateIDs)) throw new Error("Trusted routing candidate allowlist is invalid");
      identity.allowedCandidateIds = candidateIDs as string[];
      if (rawCandidateIDs !== JSON.stringify(identity.allowedCandidateIds)) {
        throw new Error("Trusted routing candidate allowlist JSON is not canonical");
      }
      const rawScores = singleHeader(headers, "x-acu-candidate-preference-scores");
      const scores = JSON.parse(rawScores) as unknown;
      if (!scores || Array.isArray(scores) || typeof scores !== "object") {
        throw new Error("Trusted candidate preference scores are invalid");
      }
      identity.candidatePreferenceScores = scores as Record<string, number>;
      if (rawScores !== stableCandidatePreferenceScoresJson(identity.candidatePreferenceScores)) {
        throw new Error("Trusted candidate preference scores JSON is not canonical");
      }
    }
  }
  const signature = singleHeader(headers, "x-acu-signature");
  if (!["all_routing_eligible", "custom_allowlist", "explicit_only"].includes(identity.routingPolicy)) {
    throw new Error("Trusted routing policy is invalid");
  }
  if (!Array.isArray(identity.allowedModelIds)
    || identity.allowedModelIds.length > 64
    || identity.allowedModelIds.some((modelId) => typeof modelId !== "string" || modelId.length < 1 || modelId.length > 128)
    || new Set(identity.allowedModelIds).size !== identity.allowedModelIds.length) {
    throw new Error("Trusted routing model allowlist is invalid");
  }
  if (identity.routingPolicy === "custom_allowlist" && identity.allowedModelIds.length === 0) {
    throw new Error("Trusted custom routing allowlist is empty");
  }
  if (!Array.isArray(identity.allowedProfileIds)
    || identity.allowedProfileIds.length > 512
    || identity.allowedProfileIds.some((profileId) => typeof profileId !== "string" || profileId.length < 1 || profileId.length > 256)
    || new Set(identity.allowedProfileIds).size !== identity.allowedProfileIds.length) {
    throw new Error("Trusted execution Profile allowlist is invalid");
  }
  if (!["economy", "balanced", "quality"].includes(identity.routingPreference)) {
    throw new Error("Trusted routing preference is invalid");
  }
  if (identityVersion === "v3" || identityVersion === "v4") {
    if (!Number.isInteger(identity.qualityBias) || identity.qualityBias! < -100 || identity.qualityBias! > 100) {
      throw new Error("Trusted quality bias is invalid");
    }
    if (!["lowest_cost", "balanced", "low_latency", "high_reliability"].includes(identity.supplyStrategy!)) {
      throw new Error("Trusted supply strategy is invalid");
    }
    const weights = identity.supplyWeights;
    if (!weights
      || ![weights.cost, weights.speed, weights.reliability]
        .every((value) => Number.isInteger(value) && value >= 0 && value <= 100)
      || weights.cost + weights.speed + weights.reliability !== 100) {
      throw new Error("Trusted supply weights are invalid");
    }
    if (!Number.isFinite(identity.acuHighBiasOffset)
      || identity.acuHighBiasOffset! < 0
      || identity.acuHighBiasOffset! > 100
      || ![identity.modelCostLogScale, identity.profileCostLogScale, identity.profileSpeedLogScale]
        .every((value) => Number.isFinite(value) && value! >= 0.1 && value! <= 20)) {
      throw new Error("Trusted routing utility scales are invalid");
    }
    const latency = identity.latencyPolicy!;
    const reliability = identity.reliabilityPolicy!;
    const workPhaseOffsets = identity.workPhaseBiasOffsets!;
    if (!Number.isFinite(latency.windowHours)
      || latency.windowHours < 1
      || latency.windowHours > 168
      || !Number.isInteger(latency.minimumSamples)
      || latency.minimumSamples < 3
      || latency.minimumSamples > 1000
      || latency.longContextThresholdTokens < 1
      || latency.unknownLatencyMultiplier < 1
      || latency.unknownLatencyMultiplier > 5
      || reliability.windowHours < 1
      || reliability.windowHours > 168
      || !Number.isInteger(reliability.minimumSamples)
      || reliability.minimumSamples < 3
      || reliability.minimumSamples > 1000
      || reliability.unknownDefault < 0.5
      || reliability.unknownDefault > 0.95
      || reliability.degradedMultiplier < 0.5
      || reliability.degradedMultiplier > 1
      || ["inspection", "general", "implementation", "verification", "planning", "recovery"]
        .some((phase) => !Number.isInteger(workPhaseOffsets[phase as keyof typeof workPhaseOffsets])
          || workPhaseOffsets[phase as keyof typeof workPhaseOffsets] < -100
          || workPhaseOffsets[phase as keyof typeof workPhaseOffsets] > 100)
      || !/^acu-routing-utility-v1-[a-f0-9]{16}$/.test(identity.routingUtilityVersion!)
      || !["legacy", "shadow", "active"].includes(identity.formulaMode!)) {
      throw new Error("Trusted routing utility policy is invalid");
    }
    const candidatePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}(?:@[A-Za-z0-9][A-Za-z0-9._:/-]{0,127})?$/;
    const allowedCandidateIDs = identity.allowedCandidateIds ?? [];
    if (allowedCandidateIDs.length > 64
      || allowedCandidateIDs.some((candidateID) =>
        typeof candidateID !== "string"
        || candidateID.length > 160
        || !candidatePattern.test(candidateID))
      || new Set(allowedCandidateIDs).size !== allowedCandidateIDs.length
      || JSON.stringify([...allowedCandidateIDs].sort()) !== JSON.stringify(allowedCandidateIDs)) {
      throw new Error("Trusted routing candidate allowlist is invalid");
    }
    const candidatePreferenceEntries = Object.entries(identity.candidatePreferenceScores ?? {});
    if (candidatePreferenceEntries.length > 64
      || candidatePreferenceEntries.some(([candidateID, score]) =>
        candidateID.length > 160 || !candidatePattern.test(candidateID)
        || typeof score !== "number" || !Number.isFinite(score)
        || score < 0 || score > 200
        || (allowedCandidateIDs.length > 0 && !allowedCandidateIDs.includes(candidateID)))) {
      throw new Error("Trusted candidate preference scores are invalid");
    }
  }
  if (!/^acu-user-policy-v2-[a-f0-9]{16}$/.test(identity.routingPolicyVersion)) {
    throw new Error("Trusted routing policy version is invalid");
  }
  const timestampMs = Date.parse(identity.timestamp);
  if (!Number.isFinite(timestampMs)) throw new Error("Trusted identity timestamp is invalid");
  const skewMs = Math.abs((options.now ?? new Date()).getTime() - timestampMs);
  if (skewMs > (options.maxClockSkewSeconds ?? 300) * 1_000) {
    throw new Error("Trusted identity timestamp is outside the accepted window");
  }
  const actualBodyHash = bodySha256(body);
  if (identity.bodySha256 !== actualBodyHash) throw new Error("Trusted identity body hash mismatch");
  const expected = Buffer.from(signTrustedIdentity(identity, options.sharedSecret), "hex");
  const received = /^[a-f0-9]{64}$/i.test(signature) ? Buffer.from(signature, "hex") : Buffer.alloc(0);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("Trusted identity signature mismatch");
  }
  return identity;
}

export function isInternalIdentityHeader(name: string): boolean {
  return INTERNAL_HEADER_NAMES.includes(name.toLowerCase() as (typeof INTERNAL_HEADER_NAMES)[number]);
}
