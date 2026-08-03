import { effectiveContextCeiling } from "./context-admission.js";
import { compareExecutionProfiles, type AlphaExecutionProfile } from "./routing.js";

function observedJudgeFailureThreshold(profile: AlphaExecutionProfile): number {
  const value = Number(profile.observedJudgeContextFailureThresholdTokens);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

export function getEligibleLunaJudgeProfiles(input: {
  profiles: AlphaExecutionProfile[];
  requiredContextTokens: number;
  preferredProfileId?: string;
  maxProfiles?: number;
  expectedOutputTokens?: number;
}): AlphaExecutionProfile[] {
  const eligible = input.profiles.filter((profile) =>
    profile.modelId === "gpt-5.6-luna"
    && profile.providerModelId === "gpt-5.6-luna"
    && profile.protocols.includes("responses")
    && profile.enabled
    && profile.administratorAllowed
    && profile.verificationStatus !== "rejected"
    && profile.autoRouteEnabled === true
    && profile.usageTrusted === true
    && profile.health !== "disabled"
    && profile.health !== "open"
    && profile.health !== "half_open"
    && profile.runtimeHealth?.effectiveState !== "disabled"
    && profile.runtimeHealth?.effectiveState !== "temporarily_unavailable"
    && effectiveContextCeiling(profile) >= input.requiredContextTokens
    && observedJudgeFailureThreshold(profile) > input.requiredContextTokens,
  );
  return eligible.sort((left, right) => {
    const leftCoversContext = (left.observedSuccessfulInputTokens ?? 0) >= input.requiredContextTokens;
    const rightCoversContext = (right.observedSuccessfulInputTokens ?? 0) >= input.requiredContextTokens;
    if (leftCoversContext !== rightCoversContext) return leftCoversContext ? -1 : 1;
    if (!leftCoversContext) {
      const evidence = (right.observedSuccessfulInputTokens ?? 0) - (left.observedSuccessfulInputTokens ?? 0);
      if (evidence !== 0) return evidence;
    }
    const ranked = compareExecutionProfiles(
      left, right, input.requiredContextTokens, input.expectedOutputTokens ?? 300,
      undefined, input.preferredProfileId,
    );
    return ranked;
  }).slice(0, input.maxProfiles ?? 5);
}
