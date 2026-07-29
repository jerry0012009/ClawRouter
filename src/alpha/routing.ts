import { getAcuModel } from "../acu/catalog.js";
import { ACU_ROUTING_MODEL_VERSION } from "../acu/config.js";
import { recommendModel } from "../acu/decision.js";
import type { AcuEvaluation, AcuJudgeResult, AcuModelEstimate } from "../acu/types.js";
import type { AlphaProtocol } from "./repository.js";

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
  recommendation: ReturnType<typeof recommendModel>;
  candidateEstimates: Array<AcuModelEstimate & { executionProfileIds: string[] }>;
  paretoFrontier: string[];
  excludedProfiles: ExcludedProfile[];
};

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
  });
  const selectedProfile = eligibleProfiles.find((profile) => profile.modelId === recommendation.recommended.modelId);
  if (!selectedProfile) throw new Error("Selected model has no compatible execution profile");
  return {
    formulaVersion: ACU_ROUTING_MODEL_VERSION,
    effectiveQualityTarget: preferenceQualityTarget,
    preference,
    preferenceParameters,
    selectedProfile,
    recommendation,
    candidateEstimates: recommendation.estimates.map((estimate) => ({
      ...estimate,
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
