import { effectiveContextCeiling } from "./context-admission.js";
import { resolveProfileBillingPrice, type AlphaExecutionProfile } from "./routing.js";
import { cashCnyPerNominalUsd } from "./provider-economics.js";
import {
  ACU_PROFILE_UTILITY_V2_VERSION,
  DEFAULT_ROUTING_UTILITY_POLICY,
  scoreExecutionProfilesV2,
  type ProfileUtilityV2,
  type RoutingUtilityPolicy,
} from "./routing-utility-v2.js";

function observedJudgeFailureThreshold(profile: AlphaExecutionProfile): number {
  const value = Number(profile.observedJudgeContextFailureThresholdTokens);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

export type JudgeProfileSelection = {
  profiles: AlphaExecutionProfile[];
  utilities: ProfileUtilityV2[];
  summary: {
    formulaVersion: typeof ACU_PROFILE_UTILITY_V2_VERSION;
    supplyStrategy: RoutingUtilityPolicy["supplyStrategy"];
    candidateCount: number;
    selectedExecutionProfileId?: string;
    selectedProfileRank?: number;
    selectedProfileUtility?: number;
  };
};

export function getEligibleJudgeProfiles(input: {
  profiles: AlphaExecutionProfile[];
  judgeModel: string;
  judgeReasoningEffort?: "default" | "low" | "medium" | "high" | "max";
  requiredContextTokens: number;
  preferredProfileId?: string;
  maxProfiles?: number;
  expectedOutputTokens?: number;
  utilityPolicy?: RoutingUtilityPolicy;
}): JudgeProfileSelection {
  const utilityPolicy = input.utilityPolicy ?? DEFAULT_ROUTING_UTILITY_POLICY;
  const eligible = input.profiles.filter((profile) =>
    profile.modelId === input.judgeModel
    && profile.providerModelId === input.judgeModel
    && profile.protocols.includes("responses")
    && (input.judgeReasoningEffort === undefined || input.judgeReasoningEffort === "default" || (
      profile.thinkingSupport === true && profile.reasoningControlMode === "standard_effort"
    ))
    && profile.enabled
    && profile.administratorAllowed
    && profile.verificationStatus !== "rejected"
    && profile.autoRouteEnabled === true
    && profile.usageTrusted === true
    && profile.health !== "disabled"
    && profile.health !== "open"
    && profile.health !== "half_open"
    && profile.health !== "cooldown"
    && profile.runtimeHealth?.effectiveState !== "disabled"
    && profile.runtimeHealth?.effectiveState !== "temporarily_unavailable"
    && effectiveContextCeiling(profile) >= input.requiredContextTokens
    && observedJudgeFailureThreshold(profile) > input.requiredContextTokens,
  );
  if (eligible.length === 0) return {
    profiles: [],
    utilities: [],
    summary: {
      formulaVersion: ACU_PROFILE_UTILITY_V2_VERSION,
      supplyStrategy: utilityPolicy.supplyStrategy,
      candidateCount: 0,
    },
  };
  const priced = eligible.map((profile) => {
    const price = resolveProfileBillingPrice(profile);
    const cashMultiplier = profile.economics ? cashCnyPerNominalUsd(profile.economics) : 1;
    return {
      ...profile,
      utilityEffectivePrices: {
        inputPricePerMillion: price.inputPricePerMillion * cashMultiplier,
        outputPricePerMillion: price.outputPricePerMillion * cashMultiplier,
      },
    };
  });
  const scored = scoreExecutionProfilesV2(
    priced,
    input.requiredContextTokens,
    input.expectedOutputTokens ?? 300,
    utilityPolicy,
  );
  const utilities = [...scored.utilities].sort((left, right) => {
    const difference = right.profileUtility - left.profileUtility;
    if (difference !== 0) return difference;
    const leftPreferred = left.executionProfileId === input.preferredProfileId;
    const rightPreferred = right.executionProfileId === input.preferredProfileId;
    if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
    return left.executionProfileId.localeCompare(right.executionProfileId);
  });
  utilities.forEach((utility, index) => {
    utility.rank = index + 1;
    utility.selected = index === 0;
  });
  const byId = new Map(eligible.map((profile) => [profile.executionProfileId, profile]));
  const profiles = utilities.slice(0, input.maxProfiles ?? 3)
    .map((utility) => byId.get(utility.executionProfileId)!);
  const selected = utilities[0];
  return {
    profiles,
    utilities,
    summary: {
      formulaVersion: ACU_PROFILE_UTILITY_V2_VERSION,
      supplyStrategy: utilityPolicy.supplyStrategy,
      candidateCount: eligible.length,
      selectedExecutionProfileId: selected?.executionProfileId,
      selectedProfileRank: selected?.rank,
      selectedProfileUtility: selected?.profileUtility,
    },
  };
}

export function getEligibleLunaJudgeProfiles(input: Omit<Parameters<typeof getEligibleJudgeProfiles>[0], "judgeModel">): JudgeProfileSelection {
  return getEligibleJudgeProfiles({ ...input, judgeModel: "gpt-5.6-luna", judgeReasoningEffort: input.judgeReasoningEffort ?? "max" });
}
