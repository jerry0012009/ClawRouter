import { effectiveContextCeiling } from "./context-admission.js";
import { effectiveProviderSelectionScore, type AlphaExecutionProfile } from "./routing.js";

const JUDGE_SUCCESS_RATE_EXPONENT_BONUS = 0.25;
const JUDGE_MAX_EXTRA_LATENCY_PENALTY = 0.08;

function judgeProfileScore(
  profile: AlphaExecutionProfile,
  inputTokens: number,
  outputTokens: number,
): number {
  const sharedScore = effectiveProviderSelectionScore(profile, {
    protocol: "responses", requireTools: false, requireThinking: false,
  }, inputTokens, outputTokens);
  const successRate = Math.max(0.5, Math.min(1, profile.recentSuccessRate ?? 1));
  const reliabilityPenalty = 1 / (successRate ** JUDGE_SUCCESS_RATE_EXPONENT_BONUS);
  const latencyPenalty = 1 + Math.min(
    JUDGE_MAX_EXTRA_LATENCY_PENALTY,
    Math.max(0, profile.observedLatencyMs ?? 0) / 1_000_000,
  );
  return sharedScore * reliabilityPenalty * latencyPenalty;
}

function diversifyJudgeProviders(
  ranked: AlphaExecutionProfile[],
  limit: number,
): AlphaExecutionProfile[] {
  const selected = ranked.slice(0, limit);
  if (selected.length < 3 || new Set(selected.map((profile) => profile.provider)).size > 1) return selected;
  const alternative = ranked.slice(limit).find((profile) => (
    profile.provider !== selected[0]!.provider && profile.health === "healthy"
  ));
  if (alternative) selected[selected.length - 1] = alternative;
  return selected;
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
    && effectiveContextCeiling(profile) >= input.requiredContextTokens,
  );
  const outputTokens = input.expectedOutputTokens ?? 300;
  const scores = new Map(eligible.map((profile) => [
    profile.executionProfileId,
    judgeProfileScore(profile, input.requiredContextTokens, outputTokens),
  ]));
  const ranked = eligible.sort((left, right) => {
    const scoreDifference = scores.get(left.executionProfileId)! - scores.get(right.executionProfileId)!;
    if (scoreDifference !== 0) return scoreDifference;
    const leftPreferred = left.executionProfileId === input.preferredProfileId;
    const rightPreferred = right.executionProfileId === input.preferredProfileId;
    if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
    return left.executionProfileId.localeCompare(right.executionProfileId);
  });
  return diversifyJudgeProviders(ranked, input.maxProfiles ?? 3);
}
