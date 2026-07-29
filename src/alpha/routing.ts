import { getAcuModel } from "../acu/catalog.js";
import { ACU_DEFAULT_SWITCH_COST_USD, ACU_ROUTING_MODEL_VERSION } from "../acu/config.js";
import { recommendModel } from "../acu/decision.js";
import type { AcuEvaluation, AcuJudgeResult, AcuModelEstimate } from "../acu/types.js";
import type { AlphaProtocol } from "./repository.js";
import { cashCnyPerNominalUsd, type ProviderEconomics } from "./provider-economics.js";

export type ProfileHealth = "healthy" | "degraded" | "cooldown" | "unknown";
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
  economy: { qualityTargetOffset: -8, costSensitivity: 2.4, fallbackRiskScale: 0.15 },
  balanced: { qualityTargetOffset: 0, costSensitivity: 1, fallbackRiskScale: 1 },
  quality: { qualityTargetOffset: 8, costSensitivity: 0.45, fallbackRiskScale: 1.25 },
};

export type AlphaExecutionProfile = {
  executionProfileId: string;
  modelId: string;
  providerModelId?: string;
  actualModelAliases?: string[];
  provider: string;
  channel: string;
  protocols: AlphaProtocol[];
  toolCallSupport: boolean;
  supportedToolTypes?: ToolCapability[];
  thinkingSupport: boolean;
  supportedReasoningEfforts?: string[];
  contextWindow: number;
  health: ProfileHealth;
  enabled: boolean;
  administratorAllowed: boolean;
  economics?: ProviderEconomics;
  usageTrusted?: boolean;
  recentSuccessRate?: number;
  observedLatencyMs?: number;
};

export type AlphaRouteRequirements = {
  protocol: AlphaProtocol;
  requireTools: boolean;
  requiredToolTypes?: ToolCapability[];
  requireThinking: boolean;
  reasoningEffort?: string;
  contextTokens: number;
  allowedModelIds?: string[];
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
    providerModelId: string;
    effectiveCashCost: number;
    providerSelectionScore: number;
    health: ProfileHealth;
    recentSuccessRate: number;
    usageTrusted: boolean;
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
  const healthFactor = profile.health === "degraded" ? 1.2 : profile.health === "unknown" ? 1.1 : 1;
  const successRate = Math.max(0.5, Math.min(1, profile.recentSuccessRate ?? 1));
  const latencyFactor = 1 + Math.min(0.05, Math.max(0, profile.observedLatencyMs ?? 0) / 1_200_000);
  return base * healthFactor * latencyFactor / successRate;
}

function exclusionReasons(
  profile: AlphaExecutionProfile,
  requirements: AlphaRouteRequirements,
  input: AlphaRouteInput,
): string[] {
  const reasons: string[] = [];
  if (!profile.enabled) reasons.push("disabled");
  if (!profile.administratorAllowed) reasons.push("administrator_policy");
  if (!profile.protocols.includes(requirements.protocol)) reasons.push("native_protocol");
  if (requirements.requireTools && !profile.toolCallSupport) reasons.push("tool_call_support");
  for (const toolType of requirements.requiredToolTypes ?? []) {
    if (!profile.supportedToolTypes?.includes(toolType)) reasons.push(`tool_type:${toolType}`);
  }
  if (requirements.requireThinking && !profile.thinkingSupport) reasons.push("thinking_support");
  if (requirements.reasoningEffort && profile.supportedReasoningEfforts
    && !profile.supportedReasoningEfforts.includes(requirements.reasoningEffort)) {
    reasons.push(`reasoning_effort:${requirements.reasoningEffort}`);
  }
  if (profile.contextWindow < requirements.contextTokens) reasons.push("context_window");
  if (profile.health === "cooldown") reasons.push("health_cooldown");
  if (profile.economics && (!profile.economics.enabled || profile.economics.health === "blocked")) reasons.push("provider_economics");
  if (profile.usageTrusted === false) reasons.push("usage_untrusted");
  if (requirements.allowedModelIds && !requirements.allowedModelIds.includes(profile.modelId)) reasons.push("model_policy");
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
    const required = input.requirements.requiredToolTypes ?? [];
    if (required.length > 0) {
      throw new Error(`No compatible Alpha execution profile supports required tool capabilities: ${required.join(", ")}`);
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
    if (!current || providerSelectionScore(profile, input.inputTokens, input.expectedOutputTokens)
      < providerSelectionScore(current, input.inputTokens, input.expectedOutputTokens)) {
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
      providerModelId: profile.providerModelId ?? profile.modelId,
      effectiveCashCost: profileEstimatedCashCost(profile, input.inputTokens, input.expectedOutputTokens),
      providerSelectionScore: providerSelectionScore(profile, input.inputTokens, input.expectedOutputTokens),
      health: profile.health,
      recentSuccessRate: profile.recentSuccessRate ?? 1,
      usageTrusted: profile.usageTrusted !== false,
      observedLatencyMs: profile.observedLatencyMs,
      selected: profile.executionProfileId === selectedProfile.executionProfileId,
    })).sort((left, right) => left.providerSelectionScore - right.providerSelectionScore);
  const selectedProviderEstimate = providerCandidateEstimates[0];
  const nextProviderEstimate = providerCandidateEstimates[1];
  const providerSelectionReason = [
    `Selected ${selectedProfile.provider}/${selectedProfile.providerModelId ?? selectedProfile.modelId}`,
    `for canonical model ${selectedProfile.modelId}`,
    `using effective cash cost, health=${selectedProfile.health}`,
    `success_rate=${(selectedProfile.recentSuccessRate ?? 1).toFixed(3)}`,
    `usage_trusted=${selectedProfile.usageTrusted !== false}`,
    `latency_ms=${selectedProfile.observedLatencyMs ?? "unknown"}`,
    `effective_cash_estimate=${selectedProviderEstimate.effectiveCashCost.toFixed(8)}`,
    nextProviderEstimate ? `next_provider=${nextProviderEstimate.provider}:${nextProviderEstimate.effectiveCashCost.toFixed(8)}` : "next_provider=none",
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
  const profile = profiles.find((candidate) => (
    candidate.modelId === requestedModel
    && exclusionReasons(candidate, requirements, {
      judge: {} as AcuJudgeResult,
      judgeCost: 0,
      inputTokens: 0,
      expectedOutputTokens: 0,
      effectiveQualityTarget: 0,
      profiles,
      requirements,
    }).length === 0
  ));
  if (!profile) throw new Error(`Explicit model ${requestedModel} has no compatible execution profile`);
  return profile;
}
