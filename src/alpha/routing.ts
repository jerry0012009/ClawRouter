import { getAcuModel } from "../acu/catalog.js";
import { ACU_DEFAULT_SWITCH_COST_USD, ACU_ROUTING_MODEL_VERSION } from "../acu/config.js";
import {
  ACU_MODEL_UTILITY_V2_VERSION,
  recommendModel,
  recommendModelV2,
} from "../acu/decision.js";
import { enabledExecutionPresets, type AcuExecutionPreset } from "../acu/execution-presets.js";
import type { AcuEvaluation, AcuJudgeResult, AcuModelEstimate } from "../acu/types.js";
import type { AlphaProtocol } from "./repository.js";
import type { WebIntent } from "./protocol/types.js";
import { cashCnyPerNominalUsd, type ProviderEconomics } from "./provider-economics.js";
import { effectiveContextCeiling, type ContextAdmissionEstimate } from "./context-admission.js";
import {
  compareWebPreference,
  resolveWebEligibility,
  type WebTransportStatus,
} from "./web-capability.js";
import type { RuntimeHealth } from "./channel-health.js";
import type { HealthSnapshot } from "./channel-health.js";
import type { WorkPhaseDecision } from "./work-phase.js";
import {
  ACU_PROFILE_UTILITY_V2_VERSION,
  resolveEffectiveQualityBias,
  scoreExecutionProfilesV2,
  type ProfileRuntimeMetric,
  type ProfileUtilityV2,
  type RoutingUtilityPolicy,
} from "./routing-utility-v2.js";
import {
  decideReasoning,
  type ProfileReasoningOverride,
  type ReasoningControlMode,
} from "./reasoning-capability.js";

export type ProfileHealth = "healthy" | "degraded" | "cooldown" | "open" | "half_open" | "disabled" | "unknown";
export type RoutingPreference = "economy" | "balanced" | "quality";
export type WorkPhaseBiasInput = {
  qualityBias: number;
  acuHighBiasOffset: number;
  routeMode: "acu-auto" | "acu-high";
  workPhase: WorkPhaseDecision["phase"];
  workPhaseBiasOffsets: Record<WorkPhaseDecision["phase"], number>;
  systemQualityBiasFloor?: number;
};

export const DEFAULT_WORK_PHASE_BIAS_OFFSETS: Record<
  WorkPhaseDecision["phase"],
  number
> = {
  inspection: -10,
  general: 0,
  implementation: 0,
  verification: 0,
  planning: 10,
  recovery: 20,
};
export type ToolCapability =
  | "function"
  | "custom"
  | "local_tool"
  | "hosted_web_search"
  | "file_search"
  | "computer_use"
  | "other_hosted_tool";

export type { ReasoningControlMode } from "./reasoning-capability.js";

export type RoutingPreferenceParameters = {
  qualityTargetOffset: number;
  costSensitivity: number;
  fallbackRiskScale: number;
};

export type ProfileBillingPrice = {
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cachedInputPricePerMillion?: number;
  cacheWritePricePerMillion?: number;
  currency: "USD_CREDIT";
  source: string;
  observedAt: string;
  status: "verified" | "estimated";
};

export const ROUTING_PREFERENCE_PARAMETERS: Record<RoutingPreference, RoutingPreferenceParameters> = {
  economy: { qualityTargetOffset: -6, costSensitivity: 2.8, fallbackRiskScale: 0.22 },
  balanced: { qualityTargetOffset: -1, costSensitivity: 1.6, fallbackRiskScale: 0.30 },
  quality: { qualityTargetOffset: 6, costSensitivity: 1.0, fallbackRiskScale: 0.70 },
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
  billingPrice?: ProfileBillingPrice;
  protocols: AlphaProtocol[];
  toolCallSupport: boolean;
  supportedToolTypes?: ToolCapability[];
  thinkingSupport: boolean;
  supportedReasoningEfforts?: string[];
  reasoningControlMode?: ReasoningControlMode;
  reasoningOverride?: ProfileReasoningOverride;
  contextWindow?: number;
  canonicalAdvertisedContextWindow?: number;
  providerDeclaredContextWindow?: number | null;
  observedSuccessfulInputTokens?: number;
  observedContextFailureThresholdTokens?: number;
  observedJudgeContextFailureThresholdTokens?: number;
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
  webTransportStatus?: WebTransportStatus;
  modelVendor?: string;
  modelCategory?: "text_agent" | "image" | "audio" | "realtime" | "unsupported";
  capabilityTier?: "LUNA" | "TERRA" | "SOL" | "FRONTIER";
  verificationStatus?: "discovered" | "verified_provisional" | "verified" | "rejected";
  autoRouteEnabled?: boolean;
  requiresFreshProbe?: boolean;
  runtimeHealth?: RuntimeHealth;
  utilityEffectivePrices?: {
    inputPricePerMillion: number;
    outputPricePerMillion: number;
  };
  utilityRuntimeMetric?: ProfileRuntimeMetric;
  utilityHealthSnapshot?: HealthSnapshot;
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
  hostedWebRequired?: boolean;
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
  workPhase?: WorkPhaseDecision;
  includeExecutionPresets?: boolean;
  routeMode?: "acu-auto" | "acu-high";
  utilityPolicy?: RoutingUtilityPolicy;
  workPhaseBiasOffsets?: Record<WorkPhaseDecision["phase"], number>;
  systemQualityBiasFloor?: number;
};

export type ExcludedProfile = { executionProfileId: string; reasons: string[] };

export type ExplicitProfileCandidates = {
  eligibleProfiles: AlphaExecutionProfile[];
  evaluations: ProfileEvaluation[];
  excludedProfiles: ExcludedProfile[];
  exclusionCounts: Record<ExclusionCategory, number>;
  candidateContextLimits: Record<string, number>;
};

export type ExplicitProfileDecision = ExplicitProfileCandidates & {
  selectedProfile: AlphaExecutionProfile;
  legacySelectedProfile: AlphaExecutionProfile;
  v2SelectedProfile?: AlphaExecutionProfile;
  profileUtilitiesV2: ProfileUtilityV2[];
  orderedExecutionProfileIds: string[];
  formulaMode: RoutingUtilityPolicy["formulaMode"];
  profileFormulaVersion: string;
  differsFromLegacy: boolean;
  differenceReason: "same_selection" | "profile_selection_changed";
  profileSelectionReason: string;
};

export type ProfileEvaluation = {
  executionProfileId: string;
  canonicalModelId: string;
  providerId: string;
  channelId: string;
  eligible: boolean;
  reasons: string[];
  excludedAtStage?: "runtime_health" | "protocol" | "tools" | "web" | "reasoning" | "context" | "policy" | "economics";
  profileState: string;
  channelState: string;
  providerState: string;
  probeState: string;
  blockingScope?: string;
  statusReason?: string;
};

export type ExclusionCategory = "context_window" | "tool_capability" | "protocol" | "web" | "thinking"
  | "health" | "allowlist" | "cost" | "adapter";

export function exclusionCategory(reason: string): ExclusionCategory {
  if (reason === "context_window") return "context_window";
  if (reason === "native_protocol") return "protocol";
  if (reason === "tool_call_support" || reason.startsWith("tool_type:")) return "tool_capability";
  if (reason.startsWith("web_")) return "web";
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
  formulaVersion: string;
  effectiveQualityTarget: number;
  preference: RoutingPreference;
  preferenceParameters: RoutingPreferenceParameters;
  workPhase: WorkPhaseDecision;
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
    v2Selected?: boolean;
    profileUtilityV2?: ProfileUtilityV2;
  }>;
  recommendation: ReturnType<typeof recommendModel>;
  candidateEstimates: Array<AcuModelEstimate & {
    executionProfileIds: string[];
    bestExecutionProfileId: string;
    costUnit: "CNY" | "USD";
    effectiveInputPriceCnyPerMillion: number;
    effectiveOutputPriceCnyPerMillion: number;
    providerCashInputPriceCnyPerMillion: number;
    providerCashOutputPriceCnyPerMillion: number;
    providerCashCachedInputPriceCnyPerMillion?: number;
    providerCashCacheWritePriceCnyPerMillion?: number;
    payableInputPriceCnyPerMillion?: number;
    payableOutputPriceCnyPerMillion?: number;
    payableCachedInputPriceCnyPerMillion?: number;
    payableCacheWritePriceCnyPerMillion?: number;
    effectiveCostStatus: "verified" | "estimated" | "missing";
  }>;
  paretoFrontier: string[];
  excludedProfiles: ExcludedProfile[];
  eligibleProfileIds: string[];
  profileEvaluations: ProfileEvaluation[];
  modelAvailability: Array<{ canonicalModelId: string; available: boolean; eligibleProfileCount: number; excludedProfileCount: number }>;
  effectiveQualityBias?: number;
  routingUtilityVersion?: string;
  formulaMode?: RoutingUtilityPolicy["formulaMode"];
  v2Counterfactual?: {
    selectedCandidateId: string;
    selectedModelId: string;
    selectedExecutionProfileId: string;
    differsFromLegacy: boolean;
    differenceReason:
      | "same_selection"
      | "model_selection_changed"
      | "profile_selection_changed";
    modelFormulaVersion: string;
    profileFormulaVersion: string;
    modelCandidates: AcuModelEstimate[];
    profileCandidates: ProfileUtilityV2[];
  };
  legacyCounterfactual?: {
    selectedCandidateId: string;
    selectedModelId: string;
    selectedExecutionProfileId: string;
  };
};

function nominalPrice(modelId: string): { inputPricePerMillion: number; outputPricePerMillion: number; cachedInputPricePerMillion?: number; cacheWritePricePerMillion?: number } {
  const model = getAcuModel(modelId);
  if (!model || model.inputPricePerMillion === null || model.outputPricePerMillion === null) {
    return { inputPricePerMillion: Number.POSITIVE_INFINITY, outputPricePerMillion: Number.POSITIVE_INFINITY };
  }
  return {
    inputPricePerMillion: model.inputPricePerMillion,
    outputPricePerMillion: model.outputPricePerMillion,
    ...(model.cachedInputPricePerMillion == null ? {} : { cachedInputPricePerMillion: model.cachedInputPricePerMillion }),
    ...(model.cacheWritePricePerMillion == null ? {} : { cacheWritePricePerMillion: model.cacheWritePricePerMillion }),
  };
}

export function resolveProfileBillingPrice(profile: AlphaExecutionProfile): {
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cachedInputPricePerMillion?: number;
  cacheWritePricePerMillion?: number;
} {
  return profile.billingPrice ?? nominalPrice(profile.modelId);
}

function profileEffectivePrices(profile: AlphaExecutionProfile): {
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cachedInputPricePerMillion?: number;
  cacheWritePricePerMillion?: number;
} {
  const nominal = resolveProfileBillingPrice(profile);
  const multiplier = profile.economics ? cashCnyPerNominalUsd(profile.economics) : 1;
  return {
    inputPricePerMillion: nominal.inputPricePerMillion * multiplier,
    outputPricePerMillion: nominal.outputPricePerMillion * multiplier,
    ...(nominal.cachedInputPricePerMillion == null ? {} : {
      cachedInputPricePerMillion: nominal.cachedInputPricePerMillion * multiplier,
    }),
    ...(nominal.cacheWritePricePerMillion == null ? {} : {
      cacheWritePricePerMillion: nominal.cacheWritePricePerMillion * multiplier,
    }),
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
  if (requirements.webIntent === "likely"
    && resolveWebEligibility(profile, { ...requirements, webIntent: "required" }).confidence === "verified") return 0.98;
  if (requirements.webIntent === "not_required" && requirements.clientDeclaredWebTool
    && profile.webToolDeclarationAccepted) return 0.99;
  return 1;
}

export function effectiveProviderSelectionScore(
  profile: AlphaExecutionProfile,
  requirements: AlphaRouteRequirements,
  inputTokens: number,
  outputTokens: number,
): number {
  return providerSelectionScore(profile, inputTokens, outputTokens) * webReliabilityFactor(profile, requirements);
}

export function profileSupportsExecutionPreset(
  profile: AlphaExecutionProfile,
  preset: AcuExecutionPreset,
  protocol?: AlphaProtocol,
): boolean {
  if (profile.modelId !== preset.modelId) return false;
  const protocols = protocol ? [protocol] : profile.protocols;
  return protocols.some((candidateProtocol) => {
    const decision = decideReasoning({
      mode: "acu-auto",
      presetEffort: preset.canonicalReasoningEffort,
      modelId: profile.modelId,
      protocol: candidateProtocol,
      profileOverride: profile.reasoningOverride,
      legacyControlMode: profile.reasoningControlMode,
      legacySupportedEfforts: profile.supportedReasoningEfforts,
    });
    return decision.mappingStatus === "exact" || decision.mappingStatus === "upgraded_alias";
  });
}

export type CandidateExecutionPlan = {
  candidateId: string;
  modelId: string;
  compatibleProfiles: AlphaExecutionProfile[];
  selectedProfile: AlphaExecutionProfile;
  profileUtilities: ProfileUtilityV2[];
  effectivePrices: {
    inputPricePerMillion: number;
    outputPricePerMillion: number;
  };
};

export function buildCandidateExecutionPlans(input: {
  eligibleProfiles: AlphaExecutionProfile[];
  requirements: AlphaRouteRequirements;
  inputTokens: number;
  expectedOutputTokens: number;
  utilityPolicy: RoutingUtilityPolicy;
  includeExecutionPresets?: boolean;
}): Map<string, CandidateExecutionPlan> {
  const modelIds = [...new Set(input.eligibleProfiles.map((profile) => profile.modelId))].filter(
    (modelId) => getAcuModel(modelId)?.routingEligible === true,
  );
  const allowedCandidateIds = new Set(input.utilityPolicy.allowedCandidateIds);
  const presets = input.includeExecutionPresets === false
    ? []
    : enabledExecutionPresets().filter((preset) => modelIds.includes(preset.modelId));
  const definitions: Array<{ candidateId: string; modelId: string; preset?: AcuExecutionPreset }> = [
    ...modelIds.map((modelId) => ({ candidateId: modelId, modelId })),
    ...presets.map((preset) => ({ candidateId: preset.candidateId, modelId: preset.modelId, preset })),
  ];
  const plans = new Map<string, CandidateExecutionPlan>();
  for (const definition of definitions) {
    if (allowedCandidateIds.size > 0 && !allowedCandidateIds.has(definition.candidateId)) continue;
    const compatibleProfiles = input.eligibleProfiles.filter((profile) =>
      profile.modelId === definition.modelId
      && (!definition.preset
        || profileSupportsExecutionPreset(profile, definition.preset, input.requirements.protocol))
    );
    if (compatibleProfiles.length === 0) continue;
    const outputTokens = Math.round(
      input.expectedOutputTokens * (definition.preset?.expectedOutputTokenMultiplier ?? 1),
    );
    const scored = scoreExecutionProfilesV2(
      compatibleProfiles.map((profile) => ({
        ...profile,
        utilityEffectivePrices: profileEffectivePrices(profile),
      })),
      input.inputTokens,
      outputTokens,
      input.utilityPolicy,
    );
    const selectedProfile = compatibleProfiles.find(
      (profile) => profile.executionProfileId === scored.selected.executionProfileId,
    )!;
    plans.set(definition.candidateId, {
      candidateId: definition.candidateId,
      modelId: definition.modelId,
      compatibleProfiles,
      selectedProfile,
      profileUtilities: scored.utilities,
      effectivePrices: profileEffectivePrices(selectedProfile),
    });
  }
  return plans;
}

export function compareExecutionProfiles(
  left: AlphaExecutionProfile,
  right: AlphaExecutionProfile,
  inputTokens: number,
  outputTokens: number,
  requirements: AlphaRouteRequirements = {
    protocol: "responses", requireTools: false, requireThinking: false,
  },
  preferredProfileId?: string,
): number {
  const scoreDifference = effectiveProviderSelectionScore(left, requirements, inputTokens, outputTokens)
    - effectiveProviderSelectionScore(right, requirements, inputTokens, outputTokens);
  if (scoreDifference !== 0) return scoreDifference;
  const leftPreferred = left.executionProfileId === preferredProfileId;
  const rightPreferred = right.executionProfileId === preferredProfileId;
  if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
  return left.executionProfileId.localeCompare(right.executionProfileId);
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
  const webEligibility = resolveWebEligibility(profile, requirements);
  if (!webEligibility.eligible) reasons.push(webEligibility.reason);
  if (requirements.requireThinking && !profile.thinkingSupport) reasons.push("thinking_support");
  if (requirements.reasoningEffort
    && !profile.supportedReasoningEfforts?.includes(requirements.reasoningEffort)) {
    reasons.push(`reasoning_effort:${requirements.reasoningEffort}`);
  }
  const requiredContextTokens = requirements.context?.requiredTotalContextTokens ?? requirements.contextTokens ?? 0;
  if (effectiveContextCeiling(profile) < requiredContextTokens) reasons.push("context_window");
  if ((profile.observedContextFailureThresholdTokens ?? Number.POSITIVE_INFINITY) <= requiredContextTokens) {
    reasons.push("context_window");
  }
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

function exclusionStage(reasons: string[]): ProfileEvaluation["excludedAtStage"] {
  const categories = reasons.map(exclusionCategory);
  if (categories.includes("health")) return "runtime_health";
  if (categories.includes("protocol")) return "protocol";
  if (categories.includes("tool_capability")) return "tools";
  if (categories.includes("web")) return "web";
  if (categories.includes("thinking")) return "reasoning";
  if (categories.includes("context_window")) return "context";
  if (categories.includes("allowlist")) return "policy";
  if (categories.includes("cost")) return "economics";
  return reasons.length ? "policy" : undefined;
}

export function evaluateProfiles(input: AlphaRouteInput): ProfileEvaluation[] {
  return input.profiles.map((profile) => {
    const reasons = [...new Set(exclusionReasons(profile, input.requirements, input))];
    const health = profile.runtimeHealth;
    return {
      executionProfileId: profile.executionProfileId,
      canonicalModelId: profile.modelId,
      providerId: profile.provider,
      channelId: profile.channelId ?? profile.channel,
      eligible: reasons.length === 0,
      reasons,
      excludedAtStage: exclusionStage(reasons),
      profileState: health?.profileState ?? profile.health,
      channelState: health?.channelState ?? "unknown",
      providerState: health?.providerState ?? profile.economics?.health ?? "unknown",
      probeState: health?.probeState ?? (profile.requiresFreshProbe ? "stale" : "not_required"),
      blockingScope: health?.blockingScope,
      statusReason: health?.statusReason,
    };
  });
}

export function profileEvaluationConserved(inputProfiles: AlphaExecutionProfile[], evaluations: ProfileEvaluation[]): boolean {
  const inputIds = inputProfiles.map((profile) => profile.executionProfileId).sort();
  const evaluationIds = evaluations.map((evaluation) => evaluation.executionProfileId).sort();
  return new Set(inputIds).size === inputIds.length
    && new Set(evaluationIds).size === evaluationIds.length
    && inputIds.length === evaluationIds.length
    && inputIds.every((id, index) => id === evaluationIds[index]);
}

export function routeWithCurrentAcuFormula(input: AlphaRouteInput): AlphaRouteDecision {
  const profileEvaluations = evaluateProfiles(input);
  if (!profileEvaluationConserved(input.profiles, profileEvaluations)) {
    const message = "Router Profile evaluation conservation failed";
    if (process.env.NODE_ENV === "test") throw new Error(message);
    console.error(message);
  }
  const eligibleIds = new Set(profileEvaluations.filter((evaluation) => evaluation.eligible)
    .map((evaluation) => evaluation.executionProfileId));
  const eligibleProfiles = input.profiles.filter((profile) => eligibleIds.has(profile.executionProfileId));
  const excludedProfiles: ExcludedProfile[] = profileEvaluations.filter((evaluation) => !evaluation.eligible)
    .map(({ executionProfileId, reasons }) => ({ executionProfileId, reasons }));
  const eligibleModelIds = [...new Set(eligibleProfiles.map((profile) => profile.modelId))];
  const modelAvailability = [...new Set(input.profiles.map((profile) => profile.modelId))].map((canonicalModelId) => {
    const evaluations = profileEvaluations.filter((evaluation) => evaluation.canonicalModelId === canonicalModelId);
    const eligibleProfileCount = evaluations.filter((evaluation) => evaluation.eligible).length;
    return { canonicalModelId, available: eligibleProfileCount > 0, eligibleProfileCount,
      excludedProfileCount: evaluations.length - eligibleProfileCount };
  });
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
    if (input.requirements.hostedWebRequired
      && normalizedExclusionCounts.web > 0) {
      throw new AlphaAdmissionError("web_capability_unavailable", "No eligible Alpha execution profile can execute the declared hosted Web Search tool", 400, {
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
  const workPhase = input.workPhase ?? {
    phase: "general" as const,
    confidence: "low" as const,
    signals: ["fallback:not_supplied"],
    qualityTargetOffset: 0,
    policyVersion: "acu-work-phase-policy-v1" as const,
  };
  const preferenceQualityTarget = Math.max(
    0,
    Math.min(100, input.effectiveQualityTarget + preferenceParameters.qualityTargetOffset + workPhase.qualityTargetOffset),
  );
  const utilityPolicy = input.utilityPolicy;
  const activeCandidatePlans = utilityPolicy?.formulaMode === "active"
    ? buildCandidateExecutionPlans({
      eligibleProfiles,
      requirements: input.requirements,
      inputTokens: input.inputTokens,
      expectedOutputTokens: input.expectedOutputTokens,
      utilityPolicy,
      includeExecutionPresets: input.includeExecutionPresets,
    })
    : undefined;
  if (activeCandidatePlans && activeCandidatePlans.size === 0) {
    const allowedCandidateIds = input.utilityPolicy?.allowedCandidateIds ?? [];
    const presetIds = new Set(enabledExecutionPresets().map((preset) => preset.candidateId));
    const onlyPresetsAllowed = allowedCandidateIds.length > 0
      && allowedCandidateIds.every((candidateId) => presetIds.has(candidateId));
    throw new AlphaAdmissionError(
      onlyPresetsAllowed ? "reasoning_effort_unavailable" : "no_executable_candidate",
      onlyPresetsAllowed
        ? "No allowed execution preset has a reasoning-compatible execution Profile."
        : "No allowed routing candidate has an executable Profile.",
      400,
      { allowed_candidate_ids: allowedCandidateIds },
    );
  }
  const legacyBestProfileByModel = new Map<string, AlphaExecutionProfile>();
  for (const profile of eligibleProfiles) {
    const current = legacyBestProfileByModel.get(profile.modelId);
    const webPreference = current ? compareWebPreference(profile, current, input.requirements) : 0;
    if (!current || webPreference < 0 || (webPreference === 0
      && effectiveProviderSelectionScore(profile, input.requirements, input.inputTokens, input.expectedOutputTokens)
      < effectiveProviderSelectionScore(current, input.requirements, input.inputTokens, input.expectedOutputTokens))) {
      legacyBestProfileByModel.set(profile.modelId, profile);
    }
  }
  const legacyEffectivePrices = activeCandidatePlans
    ? Object.fromEntries([...activeCandidatePlans].map(([candidateId, plan]) => (
      [candidateId, plan.effectivePrices]
    )))
    : Object.fromEntries([...legacyBestProfileByModel].map(([modelId, profile]) => (
      [modelId, profileEffectivePrices(profile)]
    )));
  const referenceEconomics = input.profiles.find((profile) => profile.provider === "closeai" && profile.economics?.enabled)?.economics
    ?? eligibleProfiles.find((profile) => profile.economics)?.economics;
  const effectiveSwitchCost = ACU_DEFAULT_SWITCH_COST_USD
    * (referenceEconomics ? cashCnyPerNominalUsd(referenceEconomics) : 1);
  const legacyRecommendation = recommendModel({
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
    effectivePrices: legacyEffectivePrices,
    switchCost: effectiveSwitchCost,
    includeExecutionPresets: input.includeExecutionPresets,
    allowedCandidateIds: activeCandidatePlans
      ? [...activeCandidatePlans.keys()]
      : utilityPolicy?.allowedCandidateIds,
  });
  const shouldComputeV2 =
    utilityPolicy?.formulaMode === "shadow" ||
    utilityPolicy?.formulaMode === "active";
  const v2BestProfileByCandidate = new Map<string, AlphaExecutionProfile>();
  const v2ProfileUtilitiesByCandidate = new Map<string, ProfileUtilityV2[]>();
  let v2Recommendation: ReturnType<typeof recommendModelV2> | undefined;
  let effectiveQualityBias: number | undefined;
  if (shouldComputeV2 && utilityPolicy) {
    if (activeCandidatePlans) {
      for (const [candidateId, plan] of activeCandidatePlans) {
        v2BestProfileByCandidate.set(candidateId, plan.selectedProfile);
        v2ProfileUtilitiesByCandidate.set(candidateId, plan.profileUtilities);
      }
    } else {
      for (const modelId of eligibleModelIds) {
        const modelProfiles = eligibleProfiles
          .filter((profile) => profile.modelId === modelId)
          .map((profile) => ({
            ...profile,
            utilityEffectivePrices: profileEffectivePrices(profile),
          }));
        const scored = scoreExecutionProfilesV2(
          modelProfiles,
          input.inputTokens,
          input.expectedOutputTokens,
          utilityPolicy,
        );
        v2BestProfileByCandidate.set(modelId, scored.selected);
        v2ProfileUtilitiesByCandidate.set(modelId, scored.utilities);
      }
    }
    effectiveQualityBias = resolveEffectiveQualityBias({
      qualityBias: utilityPolicy.qualityBias,
      acuHighBiasOffset: utilityPolicy.acuHighBiasOffset,
      routeMode: input.routeMode ?? "acu-auto",
      workPhase: workPhase.phase,
      workPhaseBiasOffsets:
        input.workPhaseBiasOffsets ??
        utilityPolicy.workPhaseBiasOffsets ??
        DEFAULT_WORK_PHASE_BIAS_OFFSETS,
      systemQualityBiasFloor: input.systemQualityBiasFloor,
    });
    const v2EffectivePrices = activeCandidatePlans
      ? Object.fromEntries([...activeCandidatePlans].map(([candidateId, plan]) => (
        [candidateId, plan.effectivePrices]
      )))
      : Object.fromEntries(
        [...v2BestProfileByCandidate].map(([modelId, profile]) => [
          modelId,
          profileEffectivePrices(profile),
        ]),
      );
    v2Recommendation = recommendModelV2({
      probabilities: input.judge,
      difficultyScore: input.judge.difficultyIndex,
      inputTokens: input.inputTokens,
      expectedOutputTokens: input.expectedOutputTokens,
      judgeCost: input.judgeCost,
      qualityTarget: preferenceQualityTarget / 100,
      eligibleModelIds,
      requireToolCallSupport: input.requirements.requireTools,
      effectivePrices: v2EffectivePrices,
      switchCost: effectiveSwitchCost,
      includeExecutionPresets: input.includeExecutionPresets,
      allowedCandidateIds: activeCandidatePlans
        ? [...activeCandidatePlans.keys()]
        : utilityPolicy.allowedCandidateIds,
      qualityBias: effectiveQualityBias,
      modelCostLogScale: utilityPolicy.modelCostLogScale,
      candidatePreferenceScores: utilityPolicy.candidatePreferenceScores,
    });
  }
  const profilesForCandidate = (candidate: AcuModelEstimate): AlphaExecutionProfile[] => {
    const planned = activeCandidatePlans?.get(candidate.candidateId);
    if (planned) return planned.compatibleProfiles;
    const modelProfiles = eligibleProfiles.filter((profile) => profile.modelId === candidate.modelId);
    const preset = enabledExecutionPresets().find((value) => value.candidateId === candidate.candidateId);
    if (!preset) return modelProfiles;
    const compatible = modelProfiles.filter((profile) =>
      profileSupportsExecutionPreset(profile, preset, input.requirements.protocol)
    );
    if (compatible.length === 0) {
      throw new AlphaAdmissionError(
        "reasoning_effort_unavailable",
        `No execution Profile for ${candidate.candidateId} supports reasoning effort ${preset.canonicalReasoningEffort}.`,
        400,
        { candidate_id: candidate.candidateId, reasoning_effort: preset.canonicalReasoningEffort },
      );
    }
    return compatible;
  };
  const refineLegacyProfileForCandidate = (candidate: AcuModelEstimate): void => {
    const compatible = profilesForCandidate(candidate);
    const selected = compatible.reduce((best, profile) => {
      const webPreference = compareWebPreference(profile, best, input.requirements);
      return webPreference < 0 || (webPreference === 0
        && effectiveProviderSelectionScore(profile, input.requirements, input.inputTokens, input.expectedOutputTokens)
        < effectiveProviderSelectionScore(best, input.requirements, input.inputTokens, input.expectedOutputTokens))
        ? profile : best;
    });
    legacyBestProfileByModel.set(candidate.modelId, selected);
  };
  refineLegacyProfileForCandidate(legacyRecommendation.recommended);
  if (v2Recommendation && utilityPolicy && !activeCandidatePlans) {
    const compatible = profilesForCandidate(v2Recommendation.recommended).map((profile) => ({
      ...profile,
      utilityEffectivePrices: profileEffectivePrices(profile),
    }));
    const scored = scoreExecutionProfilesV2(
      compatible,
      input.inputTokens,
      input.expectedOutputTokens,
      utilityPolicy,
    );
    v2BestProfileByCandidate.set(v2Recommendation.recommended.modelId, scored.selected);
    v2ProfileUtilitiesByCandidate.set(v2Recommendation.recommended.modelId, scored.utilities);
  }
  const activeV2 =
    utilityPolicy?.formulaMode === "active" && v2Recommendation !== undefined;
  const recommendation = activeV2 ? v2Recommendation! : legacyRecommendation;
  const bestProfileForCandidate = (candidate: AcuModelEstimate): AlphaExecutionProfile | undefined =>
    activeV2
      ? v2BestProfileByCandidate.get(candidate.candidateId)
      : legacyBestProfileByModel.get(candidate.modelId);
  const expectedCandidateModelIds = eligibleModelIds
    .filter((modelId) => getAcuModel(modelId)?.routingEligible === true)
    .sort();
  const unfilteredExpectedCandidateIds = [
    ...expectedCandidateModelIds,
    ...(input.includeExecutionPresets === false
      ? []
      : enabledExecutionPresets()
          .filter((preset) => expectedCandidateModelIds.includes(preset.modelId))
          .map((preset) => preset.candidateId)),
  ];
  const allowedCandidateIds = new Set(utilityPolicy?.allowedCandidateIds ?? []);
  const expectedCandidateIds = (activeCandidatePlans
    ? [...activeCandidatePlans.keys()]
    : unfilteredExpectedCandidateIds
      .filter((candidateId) => allowedCandidateIds.size === 0 || allowedCandidateIds.has(candidateId)))
    .sort();
  const actualCandidateIds = recommendation.estimates.map((estimate) => estimate.candidateId).sort();
  if (expectedCandidateIds.length !== actualCandidateIds.length
    || expectedCandidateIds.some((candidateId, index) => candidateId !== actualCandidateIds[index])) {
    const message = `Router execution candidate conservation failed: expected=${expectedCandidateIds.join(",")} actual=${actualCandidateIds.join(",")}`;
    if (process.env.NODE_ENV === "test") throw new Error(message);
    console.error(message);
  }
  const selectedProfile = bestProfileForCandidate(recommendation.recommended);
  if (!selectedProfile) throw new Error("Selected model has no compatible execution profile");
  const selectedCandidateProfiles = profilesForCandidate(recommendation.recommended);
  const selectedCandidateOutputTokens = Math.round(
    input.expectedOutputTokens * (recommendation.recommended.expectedOutputTokenMultiplier ?? 1),
  );
  const selectedCandidateV2Utilities =
    v2ProfileUtilitiesByCandidate.get(recommendation.recommended.candidateId)
    ?? v2ProfileUtilitiesByCandidate.get(recommendation.recommended.modelId)
    ?? [];
  const providerCandidateEstimates = selectedCandidateProfiles
    .map((profile) => ({
      executionProfileId: profile.executionProfileId,
      provider: profile.provider,
      channelId: profile.channelId ?? profile.channel,
      routingGroupName: profile.routingGroupName,
      providerModelId: profile.providerModelId ?? profile.modelId,
      effectiveCashCost: profileEstimatedCashCost(profile, input.inputTokens, selectedCandidateOutputTokens),
      providerSelectionScore: effectiveProviderSelectionScore(
        profile,
        input.requirements,
        input.inputTokens,
        selectedCandidateOutputTokens,
      ),
      health: profile.health,
      recentSuccessRate: profile.recentSuccessRate ?? 1,
      usageTrusted: profile.usageTrusted !== false,
      effectiveCostStatus: profile.effectiveCostStatus ?? "verified",
      observedLatencyMs: profile.observedLatencyMs,
      selected: profile.executionProfileId === selectedProfile.executionProfileId,
      v2Selected: selectedCandidateV2Utilities.find(
        (utility) => utility.executionProfileId === profile.executionProfileId,
      )?.selected,
      profileUtilityV2: selectedCandidateV2Utilities.find(
        (utility) => utility.executionProfileId === profile.executionProfileId,
      ),
    })).sort((left, right) =>
      activeV2
        ? (left.profileUtilityV2?.rank ?? Number.POSITIVE_INFINITY) -
          (right.profileUtilityV2?.rank ?? Number.POSITIVE_INFINITY)
        : left.providerSelectionScore - right.providerSelectionScore,
    );
  const selectedProviderEstimate = providerCandidateEstimates.find((candidate) => candidate.selected)!;
  const nextProviderEstimate = providerCandidateEstimates.find((candidate) => !candidate.selected);
  const selectedWebEligibility = resolveWebEligibility(selectedProfile, input.requirements);
  const selectedProfileV2Utility = selectedProviderEstimate.profileUtilityV2;
  const providerSelectionReason =
    activeV2 && utilityPolicy && selectedProfileV2Utility
      ? [
          `Selected ${selectedProfile.provider}/${selectedProfile.channelId ?? selectedProfile.channel}/${selectedProfile.providerModelId ?? selectedProfile.modelId}`,
          `for canonical model ${selectedProfile.modelId}`,
          `with Profile utility ${selectedProfileV2Utility.profileUtility.toFixed(4)}`,
          `weights cost=${utilityPolicy.supplyWeights.cost}% speed=${utilityPolicy.supplyWeights.speed}% reliability=${utilityPolicy.supplyWeights.reliability}%`,
          `utilities cost=${selectedProfileV2Utility.costUtility.toFixed(4)} speed=${selectedProfileV2Utility.speedUtility.toFixed(4)} reliability=${selectedProfileV2Utility.reliabilityUtility.toFixed(4)}`,
          `latency_source=${selectedProfileV2Utility.metricSource}`,
        ].join("; ")
      : [
          `Selected ${selectedProfile.provider}/${selectedProfile.channelId ?? selectedProfile.channel}/${selectedProfile.providerModelId ?? selectedProfile.modelId}`,
          `for canonical model ${selectedProfile.modelId}`,
          `using effective cash cost, health=${selectedProfile.health}`,
          `success_rate=${(selectedProfile.recentSuccessRate ?? 1).toFixed(3)}`,
          `usage_trusted=${selectedProfile.usageTrusted !== false}`,
          `effective_cost_status=${selectedProfile.effectiveCostStatus ?? "verified"}`,
          `latency_ms=${selectedProfile.observedLatencyMs ?? "unknown"}`,
          `web_model_capability=${selectedWebEligibility.modelCapability}`,
          `web_transport=${selectedWebEligibility.transportStatus}`,
          `web_eligibility=${selectedWebEligibility.confidence}`,
          `effective_cash_estimate=${selectedProviderEstimate.effectiveCashCost.toFixed(8)}`,
          nextProviderEstimate
            ? `next_channel=${nextProviderEstimate.channelId}:${nextProviderEstimate.effectiveCashCost.toFixed(8)}`
            : "next_channel=none",
        ].join("; ");
  const legacySelectedProfileId = legacyBestProfileByModel.get(
    legacyRecommendation.recommended.modelId,
  )!.executionProfileId;
  const v2SelectedProfileId = v2Recommendation
    ? (v2BestProfileByCandidate.get(v2Recommendation.recommended.candidateId)
      ?? v2BestProfileByCandidate.get(v2Recommendation.recommended.modelId))!.executionProfileId
    : undefined;
  return {
    formulaVersion: activeV2
      ? ACU_MODEL_UTILITY_V2_VERSION
      : ACU_ROUTING_MODEL_VERSION,
    effectiveQualityTarget: preferenceQualityTarget,
    preference,
    preferenceParameters,
    workPhase,
    selectedProfile,
    providerSelectionReason,
    effectiveSwitchCost,
    providerCandidateEstimates,
    recommendation,
    candidateEstimates: recommendation.estimates.map((estimate) => {
      const plan = activeCandidatePlans?.get(estimate.candidateId);
      const bestProfile = bestProfileForCandidate(estimate);
      if (!bestProfile) throw new Error(`Candidate ${estimate.candidateId} has no selected execution Profile`);
      const effectivePrices = profileEffectivePrices(bestProfile);
      return {
        ...estimate,
        bestExecutionProfileId: bestProfile.executionProfileId,
        costUnit: referenceEconomics ? "CNY" as const : "USD" as const,
        effectiveInputPriceCnyPerMillion: effectivePrices.inputPricePerMillion,
        effectiveOutputPriceCnyPerMillion: effectivePrices.outputPricePerMillion,
        providerCashInputPriceCnyPerMillion: effectivePrices.inputPricePerMillion,
        providerCashOutputPriceCnyPerMillion: effectivePrices.outputPricePerMillion,
        providerCashCachedInputPriceCnyPerMillion: effectivePrices.cachedInputPricePerMillion,
        providerCashCacheWritePriceCnyPerMillion: effectivePrices.cacheWritePricePerMillion,
        effectiveCostStatus: bestProfile.effectiveCostStatus ?? "verified",
        executionProfileIds: (plan?.compatibleProfiles
          ?? eligibleProfiles.filter((profile) => profile.modelId === estimate.modelId))
          .map((profile) => profile.executionProfileId),
      };
    }),
    paretoFrontier: recommendation.estimates
      .filter((estimate) => estimate.paretoEfficient)
      .map((estimate) => estimate.candidateId),
    excludedProfiles,
    eligibleProfileIds: eligibleProfiles.map((profile) => profile.executionProfileId),
    profileEvaluations,
    modelAvailability,
    effectiveQualityBias,
    routingUtilityVersion: utilityPolicy?.routingUtilityVersion,
    formulaMode: utilityPolicy?.formulaMode ?? "legacy",
    v2Counterfactual: v2Recommendation
      ? {
          selectedCandidateId: v2Recommendation.recommended.candidateId,
          selectedModelId: v2Recommendation.recommended.modelId,
          selectedExecutionProfileId: (v2BestProfileByCandidate.get(
            v2Recommendation.recommended.candidateId,
          ) ?? v2BestProfileByCandidate.get(v2Recommendation.recommended.modelId))!.executionProfileId,
          differsFromLegacy:
            v2Recommendation.recommended.candidateId !==
              legacyRecommendation.recommended.candidateId ||
            v2SelectedProfileId !== legacySelectedProfileId,
          differenceReason:
            v2Recommendation.recommended.candidateId !==
            legacyRecommendation.recommended.candidateId
              ? "model_selection_changed"
              : v2SelectedProfileId !== legacySelectedProfileId
                ? "profile_selection_changed"
                : "same_selection",
          modelFormulaVersion: ACU_MODEL_UTILITY_V2_VERSION,
          profileFormulaVersion: ACU_PROFILE_UTILITY_V2_VERSION,
          modelCandidates: v2Recommendation.estimates,
          profileCandidates: [...v2ProfileUtilitiesByCandidate.values()].flat(),
        }
      : undefined,
    legacyCounterfactual: activeV2
      ? {
          selectedCandidateId: legacyRecommendation.recommended.candidateId,
          selectedModelId: legacyRecommendation.recommended.modelId,
          selectedExecutionProfileId: legacyBestProfileByModel.get(
            legacyRecommendation.recommended.modelId,
          )!.executionProfileId,
        }
      : undefined,
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
  const candidates = resolveExplicitProfileCandidates(requestedModel, profiles, requirements);
  assertExplicitProfileCandidates(requestedModel, requirements, candidates);
  return [...candidates.eligibleProfiles].sort((left, right) => effectiveProviderSelectionScore(
    left,
    requirements,
    requirements.context?.estimatedInputTokens ?? requirements.contextTokens ?? 0,
    requirements.expectedOutputTokens ?? 0,
  ) - effectiveProviderSelectionScore(
    right,
    requirements,
    requirements.context?.estimatedInputTokens ?? requirements.contextTokens ?? 0,
    requirements.expectedOutputTokens ?? 0,
  ))[0]!;
}

export function resolveExplicitProfileCandidates(
  requestedModel: string,
  profiles: AlphaExecutionProfile[],
  requirements: AlphaRouteRequirements,
): ExplicitProfileCandidates {
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
  return {
    eligibleProfiles: evaluated.filter((item) => item.reasons.length === 0).map((item) => item.candidate),
    evaluations: evaluated.map(({ candidate, reasons }) => ({
      executionProfileId: candidate.executionProfileId,
      canonicalModelId: candidate.modelId,
      providerId: candidate.provider,
      channelId: candidate.channelId ?? candidate.channel,
      eligible: reasons.length === 0,
      reasons,
      excludedAtStage: exclusionStage(reasons),
      profileState: candidate.runtimeHealth?.profileState ?? candidate.health,
      channelState: candidate.runtimeHealth?.channelState ?? "unknown",
      providerState: candidate.runtimeHealth?.providerState ?? candidate.economics?.health ?? "unknown",
      probeState: candidate.runtimeHealth?.probeState ?? (candidate.requiresFreshProbe ? "stale" : "not_required"),
      blockingScope: candidate.runtimeHealth?.blockingScope,
      statusReason: candidate.runtimeHealth?.statusReason,
    })),
    excludedProfiles: evaluated.filter((item) => item.reasons.length > 0).map(({ candidate, reasons }) => ({
      executionProfileId: candidate.executionProfileId,
      reasons,
    })),
    exclusionCounts: normalizedExclusionCounts,
    candidateContextLimits: Object.fromEntries(matching.map((candidate) => (
      [candidate.executionProfileId, effectiveContextCeiling(candidate)]
    ))),
  };
}

function assertExplicitProfileCandidates(
  requestedModel: string,
  requirements: AlphaRouteRequirements,
  candidates: ExplicitProfileCandidates,
): void {
  if (candidates.eligibleProfiles.length > 0) return;
  const contextOnly = candidates.evaluations.length > 0 && candidates.evaluations.every((item) => (
    item.reasons.length > 0 && item.reasons.every((reason) => reason === "context_window")
  ));
  if (contextOnly) {
    const candidateContextLimits = candidates.candidateContextLimits;
    throw new AlphaAdmissionError(
      "context_length_exceeded",
      "The request exceeds the maximum context available from eligible execution profiles.",
      400,
      {
        estimated_input_tokens: requirements.context?.estimatedInputTokens ?? requirements.contextTokens ?? 0,
        required_total_context_tokens: requirements.context?.requiredTotalContextTokens ?? requirements.contextTokens ?? 0,
        maximum_available_context_tokens: Math.max(...Object.values(candidateContextLimits)),
        candidate_context_limits: candidateContextLimits,
        exclusion_counts: candidates.exclusionCounts,
      },
    );
  }
  if (candidates.exclusionCounts.tool_capability > 0) {
    throw new AlphaAdmissionError(
      "tool_capability_unavailable",
      "No compatible Alpha execution profile supports required tool capabilities.",
      400,
      {
        required_tool_types: requirements.requiredToolTypes ?? [],
        exclusion_counts: candidates.exclusionCounts,
      },
    );
  }
  if (requirements.allowedProfileIds) {
    const allowed = new Set(requirements.allowedProfileIds);
    const allowedEvaluations = candidates.evaluations.filter((evaluation) => allowed.has(evaluation.executionProfileId));
    const temporaryReasons = new Set(["provider_cooldown", "usage_untrusted"]);
    if (allowedEvaluations.some(({ reasons }) => reasons.length > 0
      && reasons.every((reason) => reason.startsWith("health_") || temporaryReasons.has(reason)))) {
      throw new AlphaAdmissionError(
        "allowed_profiles_temporarily_unavailable",
        "All compatible execution Profiles allowed by this API Token are temporarily unavailable.",
        503,
        { exclusion_counts: candidates.exclusionCounts },
      );
    }
    throw new AlphaAdmissionError(
      "no_profile_satisfies_token_supply_policy",
      "No execution Profile allowed by this API Token satisfies the explicit model request.",
      400,
      { exclusion_counts: candidates.exclusionCounts },
    );
  }
  throw new Error(`Explicit model ${requestedModel} has no compatible execution profile`);
}

export function resolveExplicitProfileDecision(input: {
  requestedModel: string;
  profiles: AlphaExecutionProfile[];
  requirements: AlphaRouteRequirements;
  inputTokens: number;
  expectedOutputTokens: number;
  utilityPolicy: RoutingUtilityPolicy;
}): ExplicitProfileDecision {
  const candidates = resolveExplicitProfileCandidates(input.requestedModel, input.profiles, input.requirements);
  assertExplicitProfileCandidates(input.requestedModel, input.requirements, candidates);
  const legacyOrdered = [...candidates.eligibleProfiles].sort((left, right) =>
    effectiveProviderSelectionScore(left, input.requirements, input.inputTokens, input.expectedOutputTokens)
    - effectiveProviderSelectionScore(right, input.requirements, input.inputTokens, input.expectedOutputTokens));
  const legacySelectedProfile = legacyOrdered[0]!;
  const computeV2 = input.utilityPolicy.formulaMode !== "legacy";
  const v2 = computeV2 ? scoreExecutionProfilesV2(
    candidates.eligibleProfiles.map((profile) => ({
      ...profile,
      utilityEffectivePrices: profileEffectivePrices(profile),
    })),
    input.inputTokens,
    input.expectedOutputTokens,
    input.utilityPolicy,
  ) : undefined;
  const selectedProfile = input.utilityPolicy.formulaMode === "active" && v2
    ? candidates.eligibleProfiles.find((profile) => profile.executionProfileId === v2.selected.executionProfileId)!
    : legacySelectedProfile;
  const v2SelectedProfile = v2
    ? candidates.eligibleProfiles.find((profile) => profile.executionProfileId === v2.selected.executionProfileId)
    : undefined;
  const orderedExecutionProfileIds = input.utilityPolicy.formulaMode === "active" && v2
    ? v2.utilities.map((utility) => utility.executionProfileId)
    : legacyOrdered.map((profile) => profile.executionProfileId);
  const selectedUtility = v2?.utilities.find((utility) => utility.executionProfileId === selectedProfile.executionProfileId);
  const profileSelectionReason = input.utilityPolicy.formulaMode === "active" && selectedUtility
    ? [
        `Selected ${selectedProfile.executionProfileId} with Profile utility ${selectedUtility.profileUtility.toFixed(4)}`,
        `weights cost=${input.utilityPolicy.supplyWeights.cost}% speed=${input.utilityPolicy.supplyWeights.speed}% reliability=${input.utilityPolicy.supplyWeights.reliability}%`,
        `utilities cost=${selectedUtility.costUtility.toFixed(4)} speed=${selectedUtility.speedUtility.toFixed(4)} reliability=${selectedUtility.reliabilityUtility.toFixed(4)}`,
        `latency_source=${selectedUtility.metricSource}`,
      ].join("; ")
    : `Selected ${selectedProfile.executionProfileId} with legacy effective Provider selection score.`;
  const differsFromLegacy = Boolean(v2SelectedProfile
    && v2SelectedProfile.executionProfileId !== legacySelectedProfile.executionProfileId);
  return {
    ...candidates,
    selectedProfile,
    legacySelectedProfile,
    v2SelectedProfile,
    profileUtilitiesV2: v2?.utilities ?? [],
    orderedExecutionProfileIds,
    formulaMode: input.utilityPolicy.formulaMode,
    profileFormulaVersion: computeV2 ? ACU_PROFILE_UTILITY_V2_VERSION : "legacy-provider-selection-v1",
    differsFromLegacy,
    differenceReason: differsFromLegacy ? "profile_selection_changed" : "same_selection",
    profileSelectionReason,
  };
}
