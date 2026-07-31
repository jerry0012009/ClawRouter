import { getAcuModel } from "../acu/catalog.js";
import { ACU_DEFAULT_SWITCH_COST_USD, ACU_ROUTING_MODEL_VERSION } from "../acu/config.js";
import { recommendModel } from "../acu/decision.js";
import type { AcuEvaluation, AcuJudgeResult, AcuModelEstimate } from "../acu/types.js";
import type { AlphaProtocol } from "./repository.js";
import type { WebIntent } from "./protocol/types.js";
import { cashCnyPerNominalUsd, type ProviderEconomics } from "./provider-economics.js";
import { effectiveContextCeiling, type ContextAdmissionEstimate } from "./context-admission.js";

export type ProfileHealth = "healthy" | "degraded" | "cooldown" | "open" | "half_open" | "disabled" | "unknown";
export type RoutingPreference = "economy" | "balanced" | "quality";
export type ToolCapability =
  | "function"
  | "custom"
  | "local_tool"
  | "hosted_web_search"
  | "file_search"
  | "computer_use"
  | "other_hosted_tool";

export type RoutingPreferenceParameters = {
  qualityTargetOffset: number;
  costSensitivity: number;
  fallbackRiskScale: number;
};

export const ROUTING_PREFERENCE_PARAMETERS: Record<RoutingPreference, RoutingPreferenceParameters> = {
  economy: { qualityTargetOffset: -12, costSensitivity: 3, fallbackRiskScale: 0 },
  balanced: { qualityTargetOffset: -3, costSensitivity: 1.4, fallbackRiskScale: 0.25 },
  quality: { qualityTargetOffset: 8, costSensitivity: 0.45, fallbackRiskScale: 1.25 },
};

export type AlphaExecutionProfile = {
  executionProfileId: string;
  modelId: string;
  providerModelId?: string;
  actualModelAliases?: string[];
  provider: string;
  channel: string;
  channelId?: string;
  routingGroupName?: string;
  effectiveCostStatus?: "verified" | "estimated" | "missing";
  protocols: AlphaProtocol[];
  toolCallSupport: boolean;
  supportedToolTypes?: ToolCapability[];
  thinkingSupport: boolean;
  supportedReasoningEfforts?: string[];
  contextWindow?: number;
  canonicalAdvertisedContextWindow?: number;
  providerDeclaredContextWindow?: number | null;
  observedSuccessfulInputTokens?: number;
  providerHardContextCap?: number | null;
  contextCapabilityStatus?: "verified" | "observed_floor" | "unverified_long_context" | "provider_capped";
  contextCapabilitySource?: string;
  contextLastVerifiedAt?: string;
  health: ProfileHealth;
  enabled: boolean;
  administratorAllowed: boolean;
  economics?: ProviderEconomics;
  usageTrusted?: boolean;
  recentSuccessRate?: number;
  observedLatencyMs?: number;
  webToolDeclarationAccepted?: boolean;
  webSearchExecutionVerified?: boolean;
  webSearchStreamingVerified?: boolean;
  webSearchResultVerified?: boolean;
  webSearchRecentSuccessRate?: number;
  webSearchObservedLatencyMs?: number;
  webSearchLastVerifiedAt?: string;
  webSearchFailureReason?: string;
  modelVendor?: string;
  modelCategory?: "text_agent" | "image" | "audio" | "realtime" | "unsupported";
  capabilityTier?: "LUNA" | "TERRA" | "SOL" | "FRONTIER";
  verificationStatus?: "discovered" | "verified_provisional" | "verified" | "rejected";
  autoRouteEnabled?: boolean;
  requiresFreshProbe?: boolean;
};

export type AlphaRouteRequirements = {
  protocol: AlphaProtocol;
  requireTools: boolean;
  requiredToolTypes?: ToolCapability[];
  requireThinking: boolean;
  reasoningEffort?: string;
  context?: ContextAdmissionEstimate;
  contextTokens?: number;
  allowedModelIds?: string[];
  allowedProfileIds?: string[];
  expectedOutputTokens?: number;
  clientDeclaredWebTool?: boolean;
  webIntent?: WebIntent;
};

export type AlphaRouteInput = {
  judge: AcuJudgeResult;
  judgeCost: number;
  inputTokens: number;
  expectedOutputTokens: number;
  effectiveQualityTarget: number;
  routingPreference?: RoutingPreference;
  profiles: AlphaExecutionProfile[];
  requirements: AlphaRouteRequirements;
  routeDirection?: "any" | "hold_or_upgrade";
  currentProfile?: AlphaExecutionProfile;
};

export type ExcludedProfile = { executionProfileId: string; reasons: string[] };

export type ExclusionCategory = "context_window" | "tool_capability" | "protocol" | "web" | "thinking"
  | "health" | "allowlist" | "cost" | "adapter";

export function exclusionCategory(reason: string): ExclusionCategory {
  if (reason === "context_window") return "context_window";
  if (reason === "native_protocol") return "protocol";
  if (reason === "tool_call_support" || reason.startsWith("tool_type:")) return "tool_capability";
  if (reason === "web_search_execution_unverified") return "web";
  if (reason === "thinking_support" || reason.startsWith("reasoning_effort:")) return "thinking";
  if (reason.startsWith("health_") || reason === "provider_cooldown" || reason === "disabled") return "health";
  if (reason === "administrator_policy" || reason === "model_policy" || reason === "profile_policy") return "allowlist";
  if (reason === "provider_economics" || reason === "usage_untrusted") return "cost";
  return "adapter";
}

function exclusionCounts(excludedProfiles: ExcludedProfile[]): Record<ExclusionCategory, number> {
  const counts = Object.fromEntries([
    "context_window", "tool_capability", "protocol", "web", "thinking",
    "health", "allowlist", "cost", "adapter",
  ].map((category) => [category, 0])) as Record<ExclusionCategory, number>;
  for (const reason of excludedProfiles.flatMap((profile) => profile.reasons)) {
    counts[exclusionCategory(reason)] += 1;
  }
  return counts;
}

export class AlphaAdmissionError extends Error {
  constructor(
    readonly errorType: string,
    message: string,
    readonly statusCode: number,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AlphaAdmissionError";
  }
}

export type AlphaRouteDecision = {
  formulaVersion: typeof ACU_ROUTING_MODEL_VERSION;
  effectiveQualityTarget: number;
  preference: RoutingPreference;
  preferenceParameters: RoutingPreferenceParameters;
  selectedProfile: AlphaExecutionProfile;
  providerSelectionReason: string;
  effectiveSwitchCost: number;
  providerCandidateEstimates: Array<{
    executionProfileId: string;
    provider: string;
    channelId: string;
    routingGroupName?: string;
    providerModelId: string;
    effectiveCashCost: number;
    providerSelectionScore: number;
    health: ProfileHealth;
    recentSuccessRate: number;
    usageTrusted: boolean;
    effectiveCostStatus: "verified" | "estimated" | "missing";
    observedLatencyMs?: number;
    selected: boolean;
  }>;
  recommendation: ReturnType<typeof recommendModel>;
  candidateEstimates: Array<AcuModelEstimate & {
    executionProfileIds: string[];
    bestExecutionProfileId: string;
    costUnit: "CNY" | "USD";
  }>;
  paretoFrontier: string[];
  excludedProfiles: ExcludedProfile[];
};

function nominalPrice(modelId: string): { inputPricePerMillion: number; outputPricePerMillion: number } {
  const model = getAcuModel(modelId);
  if (!model || model.inputPricePerMillion === null || model.outputPricePerMillion === null) {
    return { inputPricePerMillion: Number.POSITIVE_INFINITY, outputPricePerMillion: Number.POSITIVE_INFINITY };
  }
  return { inputPricePerMillion: model.inputPricePerMillion, outputPricePerMillion: model.outputPricePerMillion };
}

function profileEffectivePrices(profile: AlphaExecutionProfile): {
  inputPricePerMillion: number;
  outputPricePerMillion: number;
} {
  const nominal = nominalPrice(profile.modelId);
  const multiplier = profile.economics ? cashCnyPerNominalUsd(profile.economics) : 1;
  return {
    inputPricePerMillion: nominal.inputPricePerMillion * multiplier,
    outputPricePerMillion: nominal.outputPricePerMillion * multiplier,
  };
}

function profileEstimatedCashCost(profile: AlphaExecutionProfile, inputTokens: number, outputTokens: number): number {
  const price = profileEffectivePrices(profile);
  return (Math.max(0, inputTokens) * price.inputPricePerMillion
    + Math.max(0, outputTokens) * price.outputPricePerMillion) / 1_000_000;
}

function providerSelectionScore(profile: AlphaExecutionProfile, inputTokens: number, outputTokens: number): number {
  const base = profileEstimatedCashCost(profile, inputTokens, outputTokens);
  const providerHealth = profile.economics?.health;
  const healthFactor = profile.health === "degraded" || providerHealth === "degraded"
    ? 1.2
    : profile.health === "unknown" ? 1.1 : 1;
  const successRate = Math.max(0.5, Math.min(1, profile.recentSuccessRate ?? 1));
  const latencyFactor = 1 + Math.min(0.05, Math.max(0, profile.observedLatencyMs ?? 0) / 1_200_000);
  const observedFloor = profile.observedSuccessfulInputTokens ?? 0;
  const longContextFactor = ["observed_floor", "unverified_long_context"].includes(profile.contextCapabilityStatus ?? "")
    && inputTokens > observedFloor
    ? 1.03
    : 1;
  return base * healthFactor * latencyFactor * longContextFactor / successRate;
}

function webReliabilityFactor(profile: AlphaExecutionProfile, requirements: AlphaRouteRequirements): number {
  if (requirements.webIntent === "likely" && profile.webSearchExecutionVerified) return 0.98;
  if (requirements.webIntent === "not_required" && requirements.clientDeclaredWebTool
    && profile.webToolDeclarationAccepted) return 0.99;
  return 1;
}

function effectiveProviderSelectionScore(
  profile: AlphaExecutionProfile,
  requirements: AlphaRouteRequirements,
  inputTokens: number,
  outputTokens: number,
): number {
  return providerSelectionScore(profile, inputTokens, outputTokens) * webReliabilityFactor(profile, requirements);
}

function exclusionReasons(
  profile: AlphaExecutionProfile,
  requirements: AlphaRouteRequirements,
  input: AlphaRouteInput,
): string[] {
  const reasons: string[] = [];
  if (!profile.enabled) reasons.push("disabled");
  if (profile.autoRouteEnabled === false) reasons.push("auto_route_disabled");
  if (profile.modelCategory && profile.modelCategory !== "text_agent") reasons.push("model_category");
  if (profile.verificationStatus && !["verified", "verified_provisional"].includes(profile.verificationStatus)) {
    reasons.push("model_unverified");
  }
  if (!profile.administratorAllowed) reasons.push("administrator_policy");
  if (!profile.protocols.includes(requirements.protocol)) reasons.push("native_protocol");
  if (requirements.requireTools && !profile.toolCallSupport) reasons.push("tool_call_support");
  for (const toolType of requirements.requiredToolTypes ?? []) {
    if (!profile.supportedToolTypes?.includes(toolType)) reasons.push(`tool_type:${toolType}`);
  }
  if (requirements.webIntent === "required" && !profile.webSearchExecutionVerified) {
    reasons.push("web_search_execution_unverified");
  }
  if (requirements.requireThinking && !profile.thinkingSupport) reasons.push("thinking_support");
  if (requirements.reasoningEffort && profile.supportedReasoningEfforts
    && !profile.supportedReasoningEfforts.includes(requirements.reasoningEffort)) {
    reasons.push(`reasoning_effort:${requirements.reasoningEffort}`);
  }
  const requiredContextTokens = requirements.context?.requiredTotalContextTokens ?? requirements.contextTokens ?? 0;
  if (effectiveContextCeiling(profile) < requiredContextTokens) reasons.push("context_window");
  if (["cooldown", "open", "disabled"].includes(profile.health)) reasons.push(`health_${profile.health}`);
  if (profile.health === "half_open") reasons.push("health_half_open_probe_required");
  if (profile.economics && (!profile.economics.enabled || profile.economics.health === "blocked")) reasons.push("provider_economics");
  if (profile.economics?.health === "cooldown") reasons.push("provider_cooldown");
  if (profile.usageTrusted === false) reasons.push("usage_untrusted");
  if (requirements.allowedModelIds && !requirements.allowedModelIds.includes(profile.modelId)) reasons.push("model_policy");
  if (requirements.allowedProfileIds && !requirements.allowedProfileIds.includes(profile.executionProfileId)) {
    reasons.push("profile_policy");
  }
  if (input.routeDirection === "hold_or_upgrade" && input.currentProfile) {
    const currentAbility = getAcuModel(input.currentProfile.modelId)?.abilityAnchor;
    const candidateAbility = getAcuModel(profile.modelId)?.abilityAnchor;
    if (currentAbility !== undefined && candidateAbility !== undefined && candidateAbility < currentAbility) {
      reasons.push("recovery_no_downgrade");
    }
  }
  return reasons;
}

export function routeWithCurrentAcuFormula(input: AlphaRouteInput): AlphaRouteDecision {
  const excludedProfiles: ExcludedProfile[] = [];
  const eligibleProfiles = input.profiles.filter((profile) => {
    const reasons = exclusionReasons(profile, input.requirements, input);
    if (reasons.length) excludedProfiles.push({ executionProfileId: profile.executionProfileId, reasons });
    return reasons.length === 0;
  });
  const eligibleModelIds = [...new Set(eligibleProfiles.map((profile) => profile.modelId))];
  if (eligibleModelIds.length === 0) {
    const normalizedExclusionCounts = exclusionCounts(excludedProfiles);
    if (input.requirements.allowedProfileIds) {
      const allowed = new Set(input.requirements.allowedProfileIds);
      const allowedEvaluations = input.profiles.filter((profile) => allowed.has(profile.executionProfileId)).map((profile) => ({
        profile,
        reasons: exclusionReasons(profile, { ...input.requirements, allowedProfileIds: undefined }, input),
      }));
      const temporaryReasons = new Set(["provider_cooldown", "usage_untrusted"]);
      const hasTemporarilyUnavailableCompatibleProfile = allowedEvaluations.some(({ reasons }) => (
        reasons.length > 0 && reasons.every((reason) => reason.startsWith("health_") || temporaryReasons.has(reason))
      ));
      if (hasTemporarilyUnavailableCompatibleProfile) {
        throw new AlphaAdmissionError(
          "allowed_profiles_temporarily_unavailable",
          "All compatible execution Profiles allowed by this API Token are temporarily unavailable.",
          503,
          { exclusion_counts: normalizedExclusionCounts },
        );
      }
      throw new AlphaAdmissionError(
        "no_profile_satisfies_token_supply_policy",
        "No execution Profile allowed by this API Token satisfies the request protocol and capabilities.",
        400,
        { exclusion_counts: normalizedExclusionCounts },
      );
    }
    const contextBlockedProfiles = excludedProfiles.filter((profile) => (
      profile.reasons.length > 0 && profile.reasons.every((reason) => reason === "context_window")
    ));
    if (contextBlockedProfiles.length > 0) {
      const contextBlockedIds = new Set(contextBlockedProfiles.map((profile) => profile.executionProfileId));
      const candidateContextLimits = Object.fromEntries(input.profiles
        .filter((profile) => contextBlockedIds.has(profile.executionProfileId))
        .map((profile) => [
        profile.executionProfileId,
        effectiveContextCeiling(profile),
      ]));
      throw new AlphaAdmissionError(
        "context_length_exceeded",
        "The request exceeds the maximum context available from eligible execution profiles.",
        400,
        {
          estimated_input_tokens: input.requirements.context?.estimatedInputTokens ?? input.requirements.contextTokens ?? 0,
          required_total_context_tokens: input.requirements.context?.requiredTotalContextTokens ?? input.requirements.contextTokens ?? 0,
          maximum_available_context_tokens: Math.max(...Object.values(candidateContextLimits)),
          candidate_context_limits: candidateContextLimits,
          exclusion_counts: normalizedExclusionCounts,
        },
      );
    }
    if (input.requirements.webIntent === "required") {
      throw new AlphaAdmissionError("web_capability_unavailable", "No healthy Alpha execution profile has verified Web Search execution capability", 400, {
        exclusion_counts: normalizedExclusionCounts,
      });
    }
    const required = input.requirements.requiredToolTypes ?? [];
    if (required.length > 0) {
      throw new AlphaAdmissionError("tool_capability_unavailable", `No compatible Alpha execution profile supports required tool capabilities: ${required.join(", ")}`, 400, {
        required_tool_types: required,
        exclusion_counts: normalizedExclusionCounts,
      });
    }
    throw new Error("No compatible Alpha execution profile is available");
  }
  const preference = input.routingPreference ?? "balanced";
  const preferenceParameters = ROUTING_PREFERENCE_PARAMETERS[preference];
  const preferenceQualityTarget = Math.max(
    0,
    Math.min(100, input.effectiveQualityTarget + preferenceParameters.qualityTargetOffset),
  );
  const bestProfileByModel = new Map<string, AlphaExecutionProfile>();
  for (const profile of eligibleProfiles) {
    const current = bestProfileByModel.get(profile.modelId);
    if (!current || effectiveProviderSelectionScore(profile, input.requirements, input.inputTokens, input.expectedOutputTokens)
      < effectiveProviderSelectionScore(current, input.requirements, input.inputTokens, input.expectedOutputTokens)) {
      bestProfileByModel.set(profile.modelId, profile);
    }
  }
  const effectivePrices = Object.fromEntries([...bestProfileByModel].map(([modelId, profile]) => (
    [modelId, profileEffectivePrices(profile)]
  )));
  const referenceEconomics = input.profiles.find((profile) => profile.provider === "closeai" && profile.economics?.enabled)?.economics
    ?? eligibleProfiles.find((profile) => profile.economics)?.economics;
  const effectiveSwitchCost = ACU_DEFAULT_SWITCH_COST_USD
    * (referenceEconomics ? cashCnyPerNominalUsd(referenceEconomics) : 1);
  const recommendation = recommendModel({
    probabilities: input.judge,
    difficultyScore: input.judge.difficultyIndex,
    inputTokens: input.inputTokens,
    expectedOutputTokens: input.expectedOutputTokens,
    judgeCost: input.judgeCost,
    qualityTarget: preferenceQualityTarget / 100,
    costSensitivity: preferenceParameters.costSensitivity,
    fallbackRiskScale: preferenceParameters.fallbackRiskScale,
    eligibleModelIds,
    requireToolCallSupport: input.requirements.requireTools,
    effectivePrices,
    switchCost: effectiveSwitchCost,
  });
  const selectedProfile = bestProfileByModel.get(recommendation.recommended.modelId);
  if (!selectedProfile) throw new Error("Selected model has no compatible execution profile");
  const providerCandidateEstimates = eligibleProfiles
    .filter((profile) => profile.modelId === selectedProfile.modelId)
    .map((profile) => ({
      executionProfileId: profile.executionProfileId,
      provider: profile.provider,
      channelId: profile.channelId ?? profile.channel,
      routingGroupName: profile.routingGroupName,
      providerModelId: profile.providerModelId ?? profile.modelId,
      effectiveCashCost: profileEstimatedCashCost(profile, input.inputTokens, input.expectedOutputTokens),
      providerSelectionScore: effectiveProviderSelectionScore(
        profile,
        input.requirements,
        input.inputTokens,
        input.expectedOutputTokens,
      ),
      health: profile.health,
      recentSuccessRate: profile.recentSuccessRate ?? 1,
      usageTrusted: profile.usageTrusted !== false,
      effectiveCostStatus: profile.effectiveCostStatus ?? "verified",
      observedLatencyMs: profile.observedLatencyMs,
      selected: profile.executionProfileId === selectedProfile.executionProfileId,
    })).sort((left, right) => left.providerSelectionScore - right.providerSelectionScore);
  const selectedProviderEstimate = providerCandidateEstimates[0];
  const nextProviderEstimate = providerCandidateEstimates[1];
  const providerSelectionReason = [
    `Selected ${selectedProfile.provider}/${selectedProfile.channelId ?? selectedProfile.channel}/${selectedProfile.providerModelId ?? selectedProfile.modelId}`,
    `for canonical model ${selectedProfile.modelId}`,
    `using effective cash cost, health=${selectedProfile.health}`,
    `success_rate=${(selectedProfile.recentSuccessRate ?? 1).toFixed(3)}`,
    `usage_trusted=${selectedProfile.usageTrusted !== false}`,
    `effective_cost_status=${selectedProfile.effectiveCostStatus ?? "verified"}`,
    `latency_ms=${selectedProfile.observedLatencyMs ?? "unknown"}`,
    `effective_cash_estimate=${selectedProviderEstimate.effectiveCashCost.toFixed(8)}`,
    nextProviderEstimate ? `next_channel=${nextProviderEstimate.channelId}:${nextProviderEstimate.effectiveCashCost.toFixed(8)}` : "next_channel=none",
  ].join("; ");
  return {
    formulaVersion: ACU_ROUTING_MODEL_VERSION,
    effectiveQualityTarget: preferenceQualityTarget,
    preference,
    preferenceParameters,
    selectedProfile,
    providerSelectionReason,
    effectiveSwitchCost,
    providerCandidateEstimates,
    recommendation,
    candidateEstimates: recommendation.estimates.map((estimate) => ({
      ...estimate,
      bestExecutionProfileId: bestProfileByModel.get(estimate.modelId)!.executionProfileId,
      costUnit: referenceEconomics ? "CNY" : "USD",
      executionProfileIds: eligibleProfiles
        .filter((profile) => profile.modelId === estimate.modelId)
        .map((profile) => profile.executionProfileId),
    })),
    paretoFrontier: recommendation.estimates
      .filter((estimate) => estimate.paretoEfficient)
      .map((estimate) => estimate.modelId),
    excludedProfiles,
  };
}

export function evaluationJudgeResult(evaluation: AcuEvaluation): AcuJudgeResult {
  return evaluation.judge;
}

export function resolveExplicitProfile(
  requestedModel: string,
  profiles: AlphaExecutionProfile[],
  requirements: AlphaRouteRequirements,
): AlphaExecutionProfile {
  const matching = profiles.filter((candidate) => candidate.modelId === requestedModel);
  const evaluated = matching.map((candidate) => ({
    candidate,
    reasons: exclusionReasons(candidate, requirements, {
      judge: {} as AcuJudgeResult,
      judgeCost: 0,
      inputTokens: 0,
      expectedOutputTokens: 0,
      effectiveQualityTarget: 0,
      profiles,
      requirements,
    }),
  }));
  const normalizedExclusionCounts = exclusionCounts(evaluated.map(({ candidate, reasons }) => ({
    executionProfileId: candidate.executionProfileId,
    reasons,
  })));
  const profile = evaluated
    .filter((item) => item.reasons.length === 0)
    .sort((left, right) => effectiveProviderSelectionScore(
      left.candidate,
      requirements,
      requirements.context?.estimatedInputTokens ?? requirements.contextTokens ?? 0,
      requirements.expectedOutputTokens ?? 0,
    ) - effectiveProviderSelectionScore(
      right.candidate,
      requirements,
      requirements.context?.estimatedInputTokens ?? requirements.contextTokens ?? 0,
      requirements.expectedOutputTokens ?? 0,
    ))[0]?.candidate;
  if (profile) return profile;
  const contextOnly = evaluated.length > 0 && evaluated.every((item) => (
    item.reasons.length > 0 && item.reasons.every((reason) => reason === "context_window")
  ));
  if (contextOnly) {
    const candidateContextLimits = Object.fromEntries(evaluated.map(({ candidate }) => (
      [candidate.executionProfileId, effectiveContextCeiling(candidate)]
    )));
    throw new AlphaAdmissionError(
      "context_length_exceeded",
      "The request exceeds the maximum context available from eligible execution profiles.",
      400,
      {
        estimated_input_tokens: requirements.context?.estimatedInputTokens ?? requirements.contextTokens ?? 0,
        required_total_context_tokens: requirements.context?.requiredTotalContextTokens ?? requirements.contextTokens ?? 0,
        maximum_available_context_tokens: Math.max(...Object.values(candidateContextLimits)),
        candidate_context_limits: candidateContextLimits,
        exclusion_counts: normalizedExclusionCounts,
      },
    );
  }
  if (normalizedExclusionCounts.tool_capability > 0) {
    throw new AlphaAdmissionError(
      "tool_capability_unavailable",
      "No compatible Alpha execution profile supports required tool capabilities.",
      400,
      {
        required_tool_types: requirements.requiredToolTypes ?? [],
        exclusion_counts: normalizedExclusionCounts,
      },
    );
  }
  if (requirements.allowedProfileIds) {
    const allowed = new Set(requirements.allowedProfileIds);
    const allowedEvaluations = evaluated.filter(({ candidate }) => allowed.has(candidate.executionProfileId));
    const temporaryReasons = new Set(["provider_cooldown", "usage_untrusted"]);
    if (allowedEvaluations.some(({ reasons }) => reasons.length > 0
      && reasons.every((reason) => reason.startsWith("health_") || temporaryReasons.has(reason)))) {
      throw new AlphaAdmissionError(
        "allowed_profiles_temporarily_unavailable",
        "All compatible execution Profiles allowed by this API Token are temporarily unavailable.",
        503,
        { exclusion_counts: normalizedExclusionCounts },
      );
    }
    throw new AlphaAdmissionError(
      "no_profile_satisfies_token_supply_policy",
      "No execution Profile allowed by this API Token satisfies the explicit model request.",
      400,
      { exclusion_counts: normalizedExclusionCounts },
    );
  }
  throw new Error(`Explicit model ${requestedModel} has no compatible execution profile`);
}
