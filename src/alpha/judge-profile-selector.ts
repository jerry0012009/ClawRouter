import { effectiveContextCeiling } from "./context-admission.js";
import type { AlphaExecutionProfile } from "./routing.js";

export function getEligibleLunaJudgeProfiles(input: {
  profiles: AlphaExecutionProfile[];
  requiredContextTokens: number;
  preferredProfileId?: string;
  maxProfiles?: number;
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
    && effectiveContextCeiling(profile) >= input.requiredContextTokens,
  );
  const preferred = input.preferredProfileId
    ? eligible.filter((profile) => profile.executionProfileId === input.preferredProfileId)
    : [];
  const rest = eligible
    .filter((profile) => profile.executionProfileId !== input.preferredProfileId)
    .sort((left, right) => left.executionProfileId.localeCompare(right.executionProfileId));
  return [...preferred, ...rest].slice(0, input.maxProfiles ?? 3);
}
