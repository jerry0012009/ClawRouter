import { getAcuModel } from "../acu/catalog.js";
import { recommendModel } from "../acu/decision.js";
import type { AcuEvaluation, AcuJudgeResult, AcuModelEstimate } from "../acu/types.js";
import type { AlphaProtocol } from "./repository.js";

export type ProfileHealth = "healthy" | "degraded" | "cooldown" | "unknown";

export type AlphaExecutionProfile = {
  executionProfileId: string;
  modelId: string;
  provider: string;
  channel: string;
  protocols: AlphaProtocol[];
  toolCallSupport: boolean;
  thinkingSupport: boolean;
  contextWindow: number;
  health: ProfileHealth;
  enabled: boolean;
  administratorAllowed: boolean;
};

export type AlphaRouteRequirements = {
  protocol: AlphaProtocol;
  requireTools: boolean;
  requireThinking: boolean;
  contextTokens: number;
  allowedModelIds?: string[];
};

export type AlphaRouteInput = {
  judge: AcuJudgeResult;
  judgeCost: number;
  inputTokens: number;
  expectedOutputTokens: number;
  effectiveQualityTarget: number;
  profiles: AlphaExecutionProfile[];
  requirements: AlphaRouteRequirements;
  routeDirection?: "any" | "hold_or_upgrade";
  currentProfile?: AlphaExecutionProfile;
};

export type ExcludedProfile = { executionProfileId: string; reasons: string[] };

export type AlphaRouteDecision = {
  formulaVersion: "acu-routing-model-v0.1";
  effectiveQualityTarget: number;
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
  if (requirements.requireThinking && !profile.thinkingSupport) reasons.push("thinking_support");
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
  if (eligibleModelIds.length === 0) throw new Error("No compatible Alpha execution profile is available");
  const recommendation = recommendModel({
    probabilities: input.judge,
    difficultyScore: input.judge.difficultyIndex,
    inputTokens: input.inputTokens,
    expectedOutputTokens: input.expectedOutputTokens,
    judgeCost: input.judgeCost,
    qualityTarget: input.effectiveQualityTarget / 100,
    eligibleModelIds,
    requireToolCallSupport: input.requirements.requireTools,
  });
  const selectedProfile = eligibleProfiles.find((profile) => profile.modelId === recommendation.recommended.modelId);
  if (!selectedProfile) throw new Error("Selected model has no compatible execution profile");
  return {
    formulaVersion: "acu-routing-model-v0.1",
    effectiveQualityTarget: input.effectiveQualityTarget,
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
