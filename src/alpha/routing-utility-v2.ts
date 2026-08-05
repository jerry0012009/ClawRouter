import { logarithmicRelativeUtility } from "../acu/decision.js";
import { normalizeBenefitUtilities } from "../acu/math.js";
import type { AlphaExecutionProfile, WorkPhaseBiasInput } from "./routing.js";

export const ACU_PROFILE_UTILITY_V2_VERSION = "acu-profile-utility-v2.1";
export const ACU_ROUTING_UTILITY_CONFIG_VERSION = "acu-routing-utility-config-v1";
export const PROFILE_COST_MINIMUM_MEANINGFUL_RANGE = 0.2;
export const PROFILE_SPEED_MINIMUM_MEANINGFUL_RANGE = 0.2;
export const PROFILE_RELIABILITY_MINIMUM_MEANINGFUL_RANGE = 0.1;
export const ACU_UTILITY_NORMALIZATION_VERSION = "acu-benefit-range-v1";

export type FormulaMode = "legacy" | "shadow" | "active";
export type SupplyStrategy = "lowest_cost" | "balanced" | "low_latency" | "high_reliability";
export type SupplyWeights = { cost: number; speed: number; reliability: number };
export type LatencyPolicy = {
  windowHours: number;
  longContextThresholdTokens: number;
  minimumSamples: number;
  unknownLatencyMultiplier: number;
};
export type ReliabilityPolicy = {
  windowHours: number;
  minimumSamples: number;
  unknownDefault: number;
  degradedMultiplier: number;
};
export type ProfileRuntimeMetric = {
  firstEventP50Ms?: number;
  firstEventSamples: number;
  totalLatencyP50Ms?: number;
  totalLatencySamples: number;
  consideredAttempts: number;
  successfulAttempts: number;
};
export type RoutingUtilityPolicy = {
  formulaMode: FormulaMode;
  qualityBias: number;
  supplyStrategy: SupplyStrategy;
  supplyWeights: SupplyWeights;
  acuHighBiasOffset: number;
  modelCostLogScale: number;
  profileCostLogScale: number;
  profileSpeedLogScale: number;
  latency: LatencyPolicy;
  reliability: ReliabilityPolicy;
  allowedCandidateIds: string[];
  candidatePreferenceScores: Record<string, number>;
  routingUtilityVersion: string;
  workPhaseBiasOffsets: Record<
    "inspection" | "general" | "implementation" | "verification" | "planning" | "recovery",
    number
  >;
};

export const DEFAULT_ROUTING_UTILITY_POLICY: RoutingUtilityPolicy = {
  formulaMode: "legacy",
  qualityBias: 0,
  supplyStrategy: "balanced",
  supplyWeights: { cost: 40, speed: 25, reliability: 35 },
  acuHighBiasOffset: 40,
  modelCostLogScale: 0.75,
  profileCostLogScale: 2.5,
  profileSpeedLogScale: 2.5,
  latency: {
    windowHours: 24,
    longContextThresholdTokens: 100_000,
    minimumSamples: 5,
    unknownLatencyMultiplier: 1.2,
  },
  reliability: {
    windowHours: 24,
    minimumSamples: 5,
    unknownDefault: 0.75,
    degradedMultiplier: 0.85,
  },
  allowedCandidateIds: [],
  candidatePreferenceScores: {},
  routingUtilityVersion: ACU_ROUTING_UTILITY_CONFIG_VERSION,
  workPhaseBiasOffsets: {
    inspection: -10,
    general: 0,
    implementation: 0,
    verification: 0,
    planning: 10,
    recovery: 20,
  },
};

export type ProfileUtilityV2 = {
  executionProfileId: string;
  profileCost: number;
  profileLatencyMs?: number;
  reliabilityUtility: number;
  costUtility: number;
  speedUtility: number;
  rawReliabilityUtility: number;
  rawCostUtility: number;
  rawSpeedUtility: number;
  normalizedReliabilityUtility: number;
  normalizedCostUtility: number;
  normalizedSpeedUtility: number;
  costContribution: number;
  speedContribution: number;
  reliabilityContribution: number;
  normalizationVersion: typeof ACU_UTILITY_NORMALIZATION_VERSION;
  profileUtility: number;
  selected: boolean;
  rank: number;
  formulaVersion: typeof ACU_PROFILE_UTILITY_V2_VERSION;
  metricSource:
    | "first_event_p50"
    | "total_latency_p50"
    | "health_first_token"
    | "health_total_latency"
    | "unknown"
    | "all_unknown";
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function profileCashCost(
  profile: AlphaExecutionProfile,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = profile.utilityEffectivePrices;
  if (
    !price ||
    !Number.isFinite(price.inputPricePerMillion) ||
    !Number.isFinite(price.outputPricePerMillion)
  ) {
    return Number.POSITIVE_INFINITY;
  }
  return (
    (Math.max(0, inputTokens) * price.inputPricePerMillion +
      Math.max(0, outputTokens) * price.outputPricePerMillion) /
    1_000_000
  );
}

export function resolveEffectiveQualityBias(input: WorkPhaseBiasInput): number {
  const phaseOffset = input.workPhaseBiasOffsets[input.workPhase] ?? 0;
  const highOffset = input.routeMode === "acu-high" ? input.acuHighBiasOffset : 0;
  const floorOffset = input.systemQualityBiasFloor ?? -100;
  return Math.max(
    floorOffset,
    Math.min(100, Math.max(-100, input.qualityBias + highOffset + phaseOffset)),
  );
}

export function scoreExecutionProfilesV2(
  profiles: AlphaExecutionProfile[],
  inputTokens: number,
  outputTokens: number,
  policy: RoutingUtilityPolicy,
): { selected: AlphaExecutionProfile; utilities: ProfileUtilityV2[] } {
  if (profiles.length === 0)
    throw new Error("Profile V2 scoring requires at least one eligible Profile");
  const weights = policy.supplyWeights;
  if (weights.cost + weights.speed + weights.reliability !== 100)
    throw new Error("Profile utility weights must sum to 100");
  const costs = profiles.map((profile) => profileCashCost(profile, inputTokens, outputTokens));
  const finiteCosts = costs.filter((cost) => Number.isFinite(cost) && cost >= 0);
  if (finiteCosts.length === 0)
    throw new Error("No eligible Profile has a finite non-negative cash cost");
  const minimumCost = Math.min(...finiteCosts);
  const knownLatencies = profiles.flatMap((profile) => {
    const metric = profile.utilityRuntimeMetric;
    if (
      metric &&
      metric.firstEventSamples >= policy.latency.minimumSamples &&
      metric.firstEventP50Ms &&
      metric.firstEventP50Ms > 0
    ) {
      return [metric.firstEventP50Ms];
    }
    if (
      metric &&
      metric.totalLatencySamples >= policy.latency.minimumSamples &&
      metric.totalLatencyP50Ms &&
      metric.totalLatencyP50Ms > 0
    ) {
      return [metric.totalLatencyP50Ms];
    }
    if (
      profile.utilityHealthSnapshot?.firstTokenLatencyMs &&
      profile.utilityHealthSnapshot.firstTokenLatencyMs > 0
    ) {
      return [profile.utilityHealthSnapshot.firstTokenLatencyMs];
    }
    if (
      profile.utilityHealthSnapshot?.totalLatencyMs &&
      profile.utilityHealthSnapshot.totalLatencyMs > 0
    ) {
      return [profile.utilityHealthSnapshot.totalLatencyMs];
    }
    if (profile.observedLatencyMs && profile.observedLatencyMs > 0)
      return [profile.observedLatencyMs];
    return [];
  });
  const unknownLatency =
    knownLatencies.length > 0
      ? Math.max(...knownLatencies) * policy.latency.unknownLatencyMultiplier
      : undefined;
  const latencyRows = profiles.map((profile) => {
    const metric = profile.utilityRuntimeMetric;
    if (
      metric &&
      metric.firstEventSamples >= policy.latency.minimumSamples &&
      metric.firstEventP50Ms &&
      metric.firstEventP50Ms > 0
    ) {
      return { value: metric.firstEventP50Ms, source: "first_event_p50" as const };
    }
    if (
      metric &&
      metric.totalLatencySamples >= policy.latency.minimumSamples &&
      metric.totalLatencyP50Ms &&
      metric.totalLatencyP50Ms > 0
    ) {
      return { value: metric.totalLatencyP50Ms, source: "total_latency_p50" as const };
    }
    if (
      profile.utilityHealthSnapshot?.firstTokenLatencyMs &&
      profile.utilityHealthSnapshot.firstTokenLatencyMs > 0
    ) {
      return {
        value: profile.utilityHealthSnapshot.firstTokenLatencyMs,
        source: "health_first_token" as const,
      };
    }
    const total = profile.utilityHealthSnapshot?.totalLatencyMs ?? profile.observedLatencyMs;
    if (total && total > 0) return { value: total, source: "health_total_latency" as const };
    return unknownLatency === undefined
      ? { value: undefined, source: "all_unknown" as const }
      : { value: unknownLatency, source: "unknown" as const };
  });
  const positiveLatencies = latencyRows.flatMap((row) =>
    row.value && row.value > 0 ? [row.value] : [],
  );
  const minimumLatency = positiveLatencies.length > 0 ? Math.min(...positiveLatencies) : undefined;
  const rawRows = profiles.map((profile, index) => {
    const metric = profile.utilityRuntimeMetric;
    let reliability = policy.reliability.unknownDefault;
    if (metric && metric.consideredAttempts >= policy.reliability.minimumSamples) {
      reliability = metric.successfulAttempts / metric.consideredAttempts;
    } else if (profile.recentSuccessRate !== undefined) {
      reliability = Math.min(policy.reliability.unknownDefault, profile.recentSuccessRate);
    }
    if (
      profile.health === "degraded" ||
      profile.economics?.health === "degraded" ||
      profile.runtimeHealth?.probeState === "stale"
    ) {
      reliability *= policy.reliability.degradedMultiplier;
    }
    const rawCostUtility = logarithmicRelativeUtility(
      costs[index],
      minimumCost,
      policy.profileCostLogScale,
    );
    const rawSpeedUtility =
      minimumLatency === undefined || latencyRows[index].value === undefined
        ? 1
        : logarithmicRelativeUtility(
            latencyRows[index].value!,
            minimumLatency,
            policy.profileSpeedLogScale,
          );
    const rawReliabilityUtility = clamp01(reliability);
    return {
      profile,
      profileCost: costs[index],
      profileLatencyMs: latencyRows[index].value,
      rawReliabilityUtility,
      rawCostUtility,
      rawSpeedUtility,
      metricSource: latencyRows[index].source,
    };
  });
  const normalizedCosts = normalizeBenefitUtilities(
    rawRows.map((row) => row.rawCostUtility),
    PROFILE_COST_MINIMUM_MEANINGFUL_RANGE,
  );
  const normalizedSpeeds = normalizeBenefitUtilities(
    rawRows.map((row) => row.rawSpeedUtility),
    PROFILE_SPEED_MINIMUM_MEANINGFUL_RANGE,
  );
  const normalizedReliabilities = normalizeBenefitUtilities(
    rawRows.map((row) => row.rawReliabilityUtility),
    PROFILE_RELIABILITY_MINIMUM_MEANINGFUL_RANGE,
  );
  const utilities = rawRows.map((row, index): ProfileUtilityV2 => {
    const costUtility = normalizedCosts[index];
    const speedUtility = normalizedSpeeds[index];
    const reliabilityUtility = normalizedReliabilities[index];
    const costContribution = (weights.cost / 100) * costUtility;
    const speedContribution = (weights.speed / 100) * speedUtility;
    const reliabilityContribution = (weights.reliability / 100) * reliabilityUtility;
    return {
      executionProfileId: row.profile.executionProfileId,
      profileCost: row.profileCost,
      profileLatencyMs: row.profileLatencyMs,
      rawReliabilityUtility: row.rawReliabilityUtility,
      rawCostUtility: row.rawCostUtility,
      rawSpeedUtility: row.rawSpeedUtility,
      normalizedReliabilityUtility: reliabilityUtility,
      normalizedCostUtility: costUtility,
      normalizedSpeedUtility: speedUtility,
      reliabilityUtility,
      costUtility,
      speedUtility,
      costContribution,
      speedContribution,
      reliabilityContribution,
      normalizationVersion: ACU_UTILITY_NORMALIZATION_VERSION,
      profileUtility: costContribution + speedContribution + reliabilityContribution,
      selected: false,
      rank: 0,
      formulaVersion: ACU_PROFILE_UTILITY_V2_VERSION,
      metricSource: row.metricSource,
    };
  });
  const profileById = new Map(profiles.map((profile) => [profile.executionProfileId, profile]));
  utilities.sort((left, right) => {
    if (weights.cost === 100)
      return (
        left.profileCost - right.profileCost ||
        right.rawReliabilityUtility - left.rawReliabilityUtility ||
        left.executionProfileId.localeCompare(right.executionProfileId)
      );
    if (weights.speed === 100)
      return (
        (left.profileLatencyMs ?? Number.POSITIVE_INFINITY) -
          (right.profileLatencyMs ?? Number.POSITIVE_INFINITY) ||
        right.rawReliabilityUtility - left.rawReliabilityUtility ||
        left.executionProfileId.localeCompare(right.executionProfileId)
      );
    if (weights.reliability === 100)
      return (
        right.rawReliabilityUtility - left.rawReliabilityUtility ||
        right.rawSpeedUtility - left.rawSpeedUtility ||
        right.rawCostUtility - left.rawCostUtility ||
        left.executionProfileId.localeCompare(right.executionProfileId)
      );
    return (
      right.profileUtility - left.profileUtility ||
      right.reliabilityUtility - left.reliabilityUtility ||
      right.speedUtility - left.speedUtility ||
      right.costUtility - left.costUtility ||
      left.executionProfileId.localeCompare(right.executionProfileId)
    );
  });
  utilities.forEach((utility, index) => {
    utility.rank = index + 1;
    utility.selected = index === 0;
  });
  return { selected: profileById.get(utilities[0].executionProfileId)!, utilities };
}
