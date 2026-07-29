import { describe, expect, it } from "vitest";
import { recommendModel, selectValueRoute } from "../src/acu/decision.js";
import type { AcuJudgeResult } from "../src/acu/types.js";
import {
  resolveExplicitProfile,
  routeWithCurrentAcuFormula,
  type AlphaExecutionProfile,
  type AlphaRouteRequirements,
} from "../src/alpha/routing.js";

const judge: AcuJudgeResult = {
  pLow: 0.1,
  pMid: 0.2,
  pMidHigh: 0.5,
  pHigh: 0.2,
  confidence: 0.8,
  difficultyScoreRaw: 68,
  factors: {
    reasoningDepth: 7,
    taskScope: 6,
    constraintDensity: 6,
    toolDependency: 8,
    verificationBurden: 7,
    contextBurden: 5,
  },
  factorComposite: 67,
  difficultyIndex: 67.2,
  difficultyMethodVersion: "acu-difficulty-index-v1",
  difficultyScore: 67.2,
  signals: ["multi_file", "tools"],
  explanation: "fixture",
};

const profiles: AlphaExecutionProfile[] = [
  {
    executionProfileId: "closeai:gpt-5.4-mini:responses",
    modelId: "gpt-5.4-mini",
    provider: "closeai",
    channel: "openai",
    protocols: ["responses"],
    toolCallSupport: true,
    thinkingSupport: true,
    contextWindow: 1_048_576,
    health: "healthy",
    enabled: true,
    administratorAllowed: true,
  },
  {
    executionProfileId: "closeai:gpt-5.5:responses",
    modelId: "gpt-5.5",
    provider: "closeai",
    channel: "openai",
    protocols: ["responses"],
    toolCallSupport: true,
    thinkingSupport: true,
    contextWindow: 1_048_576,
    health: "healthy",
    enabled: true,
    administratorAllowed: true,
  },
  {
    executionProfileId: "closeai:claude-sonnet-5:messages",
    modelId: "claude-sonnet-5",
    provider: "closeai",
    channel: "anthropic",
    protocols: ["messages"],
    toolCallSupport: true,
    thinkingSupport: true,
    contextWindow: 200_000,
    health: "healthy",
    enabled: true,
    administratorAllowed: true,
  },
];

const requirements: AlphaRouteRequirements = {
  protocol: "responses",
  requireTools: true,
  requireThinking: false,
  contextTokens: 10_000,
};

describe("Alpha current-formula routing", () => {
  it("replays the existing decision.ts recommendation exactly", () => {
    const actual = routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0.001,
      inputTokens: 12_000,
      expectedOutputTokens: 1_000,
      effectiveQualityTarget: 88,
      profiles,
      requirements,
    });
    const expected = recommendModel({
      probabilities: judge,
      difficultyScore: judge.difficultyIndex,
      inputTokens: 12_000,
      expectedOutputTokens: 1_000,
      judgeCost: 0.001,
      qualityTarget: 0.88,
      eligibleModelIds: ["gpt-5.4-mini", "gpt-5.5"],
      requireToolCallSupport: true,
    });
    expect(actual.recommendation).toEqual(expected);
    expect(actual.selectedProfile.modelId).toBe(expected.recommended.modelId);
    expect(actual.excludedProfiles).toContainEqual({
      executionProfileId: "closeai:claude-sonnet-5:messages",
      reasons: ["native_protocol"],
    });
  });

  it("keeps all below-target candidates eligible", () => {
    const candidates = [
      { modelId: "low", displayName: "Low", predictedScore: 61, conservativeScore: 58, riskAdjustedCost: 0.1 },
      { modelId: "mid", displayName: "Mid", predictedScore: 72, conservativeScore: 68, riskAdjustedCost: 0.5 },
    ];
    const result = selectValueRoute(candidates, 88);
    expect(["low", "mid"]).toContain(result.selected.modelId);
    expect(result.utilities.size).toBe(2);
  });

  it("continues to use cost utility when all candidates exceed target", () => {
    const candidates = [
      { modelId: "cheap", displayName: "Cheap", predictedScore: 94, conservativeScore: 93, riskAdjustedCost: 0.1 },
      { modelId: "expensive", displayName: "Expensive", predictedScore: 95, conservativeScore: 94, riskAdjustedCost: 10 },
    ];
    const result = selectValueRoute(candidates, 88);
    expect(result.utilities.get("cheap")?.costUtility).toBe(1);
    expect(result.utilities.get("expensive")?.costUtility).toBe(0);
    expect(result.selected.modelId).toBe("cheap");
  });

  it("does not use meetsQualityTarget as a hard filter", () => {
    const result = routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0,
      inputTokens: 2_000,
      expectedOutputTokens: 500,
      effectiveQualityTarget: 99,
      profiles,
      requirements,
    });
    expect(result.candidateEstimates.length).toBe(2);
    expect(result.candidateEstimates.every((candidate) => !candidate.meetsQualityTarget)).toBe(true);
    expect(result.selectedProfile).toBeDefined();
  });

  it("prevents downgrade during capability recovery", () => {
    const result = routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0,
      inputTokens: 2_000,
      expectedOutputTokens: 500,
      effectiveQualityTarget: 88,
      profiles,
      requirements,
      routeDirection: "hold_or_upgrade",
      currentProfile: profiles[1],
    });
    expect(result.selectedProfile.modelId).toBe("gpt-5.5");
    expect(result.excludedProfiles).toContainEqual({
      executionProfileId: "closeai:gpt-5.4-mini:responses",
      reasons: ["recovery_no_downgrade"],
    });
  });

  it("resolves explicit models without invoking Judge or substituting a model", () => {
    expect(resolveExplicitProfile("gpt-5.4-mini", profiles, requirements).modelId).toBe("gpt-5.4-mini");
    expect(() => resolveExplicitProfile("acu-auto", profiles, requirements)).toThrow(/no compatible/);
  });
});
