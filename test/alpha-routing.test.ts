import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
  it("does not let shared Judge overhead change model selection or Pareto membership", () => {
    const input = {
      probabilities: judge,
      difficultyScore: judge.difficultyIndex,
      inputTokens: 57_307,
      expectedOutputTokens: 1_000,
      qualityTarget: 0.68,
      costSensitivity: 1.8,
      fallbackRiskScale: 0.35,
      eligibleModelIds: ["gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
    };
    const withoutJudgeCost = recommendModel({ ...input, judgeCost: 0 });
    const withLargeJudgeCost = recommendModel({ ...input, judgeCost: 100 });
    expect(withLargeJudgeCost.recommended.modelId).toBe(withoutJudgeCost.recommended.modelId);
    expect(withLargeJudgeCost.estimates.map((estimate) => [estimate.modelId, estimate.paretoEfficient]))
      .toEqual(withoutJudgeCost.estimates.map((estimate) => [estimate.modelId, estimate.paretoEfficient]));
    for (const estimate of withLargeJudgeCost.estimates) {
      const baseline = withoutJudgeCost.estimates.find((item) => item.modelId === estimate.modelId)!;
      expect(estimate.selectionCost).toBeCloseTo(baseline.selectionCost, 12);
      expect(estimate.riskAdjustedCost).toBeCloseTo(baseline.riskAdjustedCost, 12);
      expect(estimate.expectedEndToEndCost - baseline.expectedEndToEndCost).toBeCloseTo(100, 12);
      expect(estimate.judgeOverheadCost).toBe(100);
    }
  });

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
      qualityTarget: 0.85,
      costSensitivity: 1.4,
      fallbackRiskScale: 0.25,
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

  it("does not hard-filter ordinary Coding because the client declared Web Search", () => {
    const webProfiles = profiles.map((profile, index) => ({
      ...profile,
      webToolDeclarationAccepted: index === 0,
      webSearchExecutionVerified: index === 0,
    }));
    const result = routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0,
      inputTokens: 2_000,
      expectedOutputTokens: 500,
      effectiveQualityTarget: 70,
      profiles: webProfiles,
      requirements: {
        ...requirements,
        requireTools: false,
        clientDeclaredWebTool: true,
        webIntent: "not_required",
      },
    });
    expect(result.candidateEstimates).toHaveLength(2);
  });

  it("prefers verified Web transport but admits optimistic pass-through for a supported model", () => {
    const verified = {
      ...profiles[0],
      executionProfileId: "verified",
      modelId: "gpt-5.4-mini",
      webSearchExecutionVerified: true,
    };
    const unverified = {
      ...profiles[0],
      executionProfileId: "optimistic",
      modelId: "gpt-5.4-mini",
      webSearchExecutionVerified: false,
      webSearchFailureReason: "not_verified_for_full_pool_profile",
    };
    const result = routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0,
      inputTokens: 2_000,
      expectedOutputTokens: 500,
      effectiveQualityTarget: 70,
      profiles: [verified, unverified],
      requirements: {
        ...requirements,
        requireTools: false,
        clientDeclaredWebTool: true,
        hostedWebRequired: true,
        webIntent: "required",
      },
    });
    expect(result.candidateEstimates).toHaveLength(1);
    expect(result.candidateEstimates[0]?.executionProfileIds).toEqual(["verified", "optimistic"]);
    expect(result.eligibleProfileIds).toEqual(["verified", "optimistic"]);
    expect(result.selectedProfile.executionProfileId).toBe("verified");
    expect(result.excludedProfiles).toEqual([]);
  });

  it("routes a supported model through a compatible unverified Web transport", () => {
    const optimistic = {
      ...profiles[0],
      modelId: "gpt-5.6-sol",
      webSearchExecutionVerified: false,
      webSearchFailureReason: "not_verified_for_full_pool_profile",
    };
    const result = routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0,
      inputTokens: 2_000,
      expectedOutputTokens: 500,
      effectiveQualityTarget: 70,
      profiles: [optimistic],
      requirements: {
        ...requirements,
        requireTools: false,
        clientDeclaredWebTool: true,
        hostedWebRequired: true,
        webIntent: "required",
      },
    });
    expect(result.selectedProfile.executionProfileId).toBe(optimistic.executionProfileId);
    expect(result.providerSelectionReason).toContain("web_eligibility=optimistic");
  });

  it("excludes explicit Web transport incompatibility", () => {
    const incompatible = {
      ...profiles[0],
      modelId: "gpt-5.6-luna",
      webSearchFailureReason: "web_search_output_item_missing",
    };
    expect(() => routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0,
      inputTokens: 2_000,
      expectedOutputTokens: 500,
      effectiveQualityTarget: 70,
      profiles: [incompatible],
      requirements: {
        ...requirements,
        requireTools: false,
        clientDeclaredWebTool: true,
        hostedWebRequired: true,
        webIntent: "required",
      },
    })).toThrowError(expect.objectContaining({
      errorType: "web_capability_unavailable",
      details: { exclusion_counts: expect.objectContaining({ web: 1 }) },
    }));
  });

  it("does not require hosted Web transport for client-side Web tools", () => {
    const result = routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0,
      inputTokens: 2_000,
      expectedOutputTokens: 500,
      effectiveQualityTarget: 70,
      profiles,
      requirements: {
        ...requirements,
        requireTools: false,
        clientDeclaredWebTool: false,
        webIntent: "required",
      },
    });
    expect(result.candidateEstimates).toHaveLength(2);
  });

  it("keeps ordinary Profiles eligible when Web intent is required but hosted Web is not", () => {
    const result = routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0,
      inputTokens: 2_000,
      expectedOutputTokens: 500,
      effectiveQualityTarget: 70,
      profiles,
      requirements: {
        ...requirements,
        requireTools: false,
        clientDeclaredWebTool: true,
        hostedWebRequired: false,
        webIntent: "required",
      },
    });
    expect(result.candidateEstimates).toHaveLength(2);
    expect(result.excludedProfiles.flatMap((profile) => profile.reasons).some((reason) => reason.startsWith("web_")))
      .toBe(false);
  });

  it("keeps at least three production Coding candidates when Codex declares Web without Web intent", () => {
    const configured = JSON.parse(readFileSync(new URL("../deploy/alpha/execution-profiles.json", import.meta.url), "utf8")) as AlphaExecutionProfile[];
    const result = routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0,
      inputTokens: 2_000,
      expectedOutputTokens: 500,
      effectiveQualityTarget: 70,
      routingPreference: "economy",
      profiles: configured,
      requirements: {
        protocol: "responses",
        requireTools: true,
        requiredToolTypes: ["function", "local_tool"],
        requireThinking: false,
        contextTokens: 10_000,
        clientDeclaredWebTool: true,
        webIntent: "not_required",
      },
    });
    expect(result.candidateEstimates.length).toBeGreaterThanOrEqual(3);
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

  it("excludes a profile that explicitly does not support the requested reasoning effort", () => {
    const effortProfiles = profiles.map((profile) => ({
      ...profile,
      supportedReasoningEfforts: profile.modelId === "gpt-5.4-mini" ? ["low", "medium"] : ["high"],
    }));
    const result = routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0,
      inputTokens: 2_000,
      expectedOutputTokens: 500,
      effectiveQualityTarget: 88,
      profiles: effortProfiles,
      requirements: { ...requirements, reasoningEffort: "high" },
    });
    expect(result.excludedProfiles).toContainEqual({
      executionProfileId: "closeai:gpt-5.4-mini:responses",
      reasons: ["reasoning_effort:high"],
    });
  });

  it("hard-filters unsupported hosted tools with an auditable reason", () => {
    const capabilityProfiles = profiles.map((profile) => ({
      ...profile,
      supportedToolTypes: profile.modelId === "gpt-5.5"
        ? ["function", "hosted_web_search"] as const
        : ["function"] as const,
    }));
    const result = routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0,
      inputTokens: 2_000,
      expectedOutputTokens: 500,
      effectiveQualityTarget: 88,
      profiles: capabilityProfiles,
      requirements: { ...requirements, requiredToolTypes: ["function", "hosted_web_search"] },
    });
    expect(result.selectedProfile.modelId).toBe("gpt-5.5");
    expect(result.excludedProfiles).toContainEqual({
      executionProfileId: "closeai:gpt-5.4-mini:responses",
      reasons: ["tool_type:hosted_web_search"],
    });
  });

  it("returns a clear capability error when no profile supports a hosted tool", () => {
    expect(() => routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0,
      inputTokens: 2_000,
      expectedOutputTokens: 500,
      effectiveQualityTarget: 88,
      profiles,
      requirements: { ...requirements, requiredToolTypes: ["file_search"] },
    })).toThrow(/required tool capabilities: file_search/);
  });

  it("replays economy, balanced and quality across difficulty and token sizes without fixed-model routing", () => {
    const configured = JSON.parse(readFileSync(
      new URL("../deploy/alpha/execution-profiles.json", import.meta.url),
      "utf8",
    )) as AlphaExecutionProfile[];
    const responseProfiles = configured.filter((profile) => profile.protocols.includes("responses"));
    const tokenSizes = [[100, 20], [2_000, 300], [12_000, 1_200], [30_000, 10_000]] as const;
    const selected = {
      economy: new Set<string>(),
      balanced: new Set<string>(),
      quality: new Set<string>(),
    };
    for (const [inputTokens, expectedOutputTokens] of tokenSizes) {
      for (let difficulty = 0; difficulty <= 100; difficulty += 1) {
        const replayJudge = { ...judge, difficultyIndex: difficulty, difficultyScore: difficulty };
        const decisions = (["economy", "balanced", "quality"] as const).map((routingPreference) => (
          routeWithCurrentAcuFormula({
            judge: replayJudge,
            judgeCost: 0.001,
            inputTokens,
            expectedOutputTokens,
            effectiveQualityTarget: 80,
            routingPreference,
            profiles: responseProfiles,
            requirements: {
              protocol: "responses",
              requireTools: true,
              requiredToolTypes: ["function", "local_tool"],
              requireThinking: true,
              reasoningEffort: "medium",
              contextTokens: inputTokens,
            },
          })
        ));
        decisions.forEach((decision, index) => {
          selected[(["economy", "balanced", "quality"] as const)[index]].add(decision.selectedProfile.modelId);
          expect(decision.formulaVersion).toBe("acu-routing-model-v0.4");
        });
        const balancedQuality = decisions[1].recommendation.recommended.estimatedQuality;
        const qualityQuality = decisions[2].recommendation.recommended.estimatedQuality;
        expect(qualityQuality + 1e-12).toBeGreaterThanOrEqual(balancedQuality);
      }
    }
    expect(selected.economy.has("gemini-2.5-flash")).toBe(true);
    expect(selected.economy.size).toBeGreaterThan(1);
    expect(selected.balanced.size).toBeGreaterThan(1);
    expect(selected.quality.size).toBeGreaterThan(1);
  });

  it("resolves explicit models without invoking Judge or substituting a model", () => {
    expect(resolveExplicitProfile("gpt-5.4-mini", profiles, requirements).modelId).toBe("gpt-5.4-mini");
    expect(() => resolveExplicitProfile("acu-auto", profiles, requirements)).toThrow(/no compatible/);
  });

  it("keeps ten Profiles as one model candidate and selects the cheapest healthy Profile", () => {
    const modelProfiles = Array.from({ length: 10 }, (_, index) => ({
      ...profiles[0],
      executionProfileId: `provider-${index}:gpt-5.4-mini:responses`,
      provider: `provider-${index}`,
      channel: `channel-${index}`,
      economics: {
        providerId: `provider-${index}`,
        displayName: `Provider ${index}`,
        protocol: "responses",
        baseUrlEnv: `BASE_${index}`,
        apiKeyEnv: `KEY_${index}`,
        balanceCurrency: "USD-denominated credits" as const,
        rechargeCashCny: 1,
        creditsReceivedUsd: 1,
        observedBillingMultiplier: index === 0 ? 0.01 : index + 1,
        priceSource: "fixture",
        priceObservedAt: "2026-01-01",
        health: "healthy" as const,
        priority: index,
        enabled: true,
        effectiveCostStatus: "verified" as const,
        effectiveCostSource: "fixture",
        effectiveCostVersion: "test-v1",
      },
    }));
    const result = routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0,
      inputTokens: 2_000,
      expectedOutputTokens: 500,
      effectiveQualityTarget: 70,
      profiles: modelProfiles,
      requirements,
    });
    expect(result.candidateEstimates).toHaveLength(1);
    expect(result.selectedProfile.executionProfileId).toBe('provider-0:gpt-5.4-mini:responses');
    expect(result.providerCandidateEstimates).toHaveLength(10);
  });

  it("does not let an unhealthy cheap Profile represent its model", () => {
    const modelProfiles = [
      { ...profiles[0], economics: { ...modelEconomicsFixture(0.01) }, health: "cooldown" as const },
      { ...profiles[0], executionProfileId: "healthy:gpt-5.4-mini:responses", channel: "healthy", economics: { ...modelEconomicsFixture(2) }, health: "healthy" as const },
    ];
    const result = routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0,
      inputTokens: 2_000,
      expectedOutputTokens: 500,
      effectiveQualityTarget: 70,
      profiles: modelProfiles,
      requirements,
    });
    expect(result.candidateEstimates).toHaveLength(1);
    expect(result.providerCandidateEstimates[0].executionProfileId).toBe('healthy:gpt-5.4-mini:responses');
  });

  it("hard-filters Token-disallowed Profiles before model aggregation and pricing", () => {
    const cheap = { ...profiles[0], economics: modelEconomicsFixture(0.03) };
    const allowed = {
      ...profiles[0],
      executionProfileId: "allowed:gpt-5.4-mini:responses",
      provider: "allowed-provider",
      channel: "allowed-channel",
      economics: modelEconomicsFixture(1.2),
    };
    const result = routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0,
      inputTokens: 2_000,
      expectedOutputTokens: 500,
      effectiveQualityTarget: 70,
      profiles: [cheap, allowed],
      requirements: { ...requirements, allowedProfileIds: [allowed.executionProfileId] },
    });
    expect(result.candidateEstimates).toHaveLength(1);
    expect(result.selectedProfile.executionProfileId).toBe(allowed.executionProfileId);
    expect(result.providerCandidateEstimates).toHaveLength(1);
    expect(result.excludedProfiles).toContainEqual({
      executionProfileId: cheap.executionProfileId,
      reasons: ["profile_policy"],
    });
  });

  it("selects the lowest-score allowed Profile for an explicit model", () => {
    const expensive = { ...profiles[0], economics: modelEconomicsFixture(3) };
    const cheap = {
      ...profiles[0],
      executionProfileId: "cheap:gpt-5.4-mini:responses",
      provider: "cheap-provider",
      channel: "cheap-channel",
      economics: modelEconomicsFixture(0.5),
    };
    const selected = resolveExplicitProfile("gpt-5.4-mini", [expensive, cheap], {
      ...requirements,
      contextTokens: 2_000,
      expectedOutputTokens: 500,
      allowedProfileIds: [expensive.executionProfileId, cheap.executionProfileId],
    });
    expect(selected.executionProfileId).toBe(cheap.executionProfileId);
  });

  it("distinguishes incompatible policy from temporarily unavailable allowed supply", () => {
    expect(() => routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0,
      inputTokens: 2_000,
      expectedOutputTokens: 500,
      effectiveQualityTarget: 70,
      profiles,
      requirements: { ...requirements, allowedProfileIds: [profiles[2].executionProfileId] },
    })).toThrow(/No execution Profile allowed/);
    expect(() => routeWithCurrentAcuFormula({
      judge,
      judgeCost: 0,
      inputTokens: 2_000,
      expectedOutputTokens: 500,
      effectiveQualityTarget: 70,
      profiles: [{ ...profiles[0], health: "cooldown" }],
      requirements: { ...requirements, allowedProfileIds: [profiles[0].executionProfileId] },
    })).toThrow(/temporarily unavailable/);
  });
});

function modelEconomicsFixture(observedBillingMultiplier: number) {
  return {
    providerId: "fixture",
    displayName: "Fixture",
    protocol: "responses",
    baseUrlEnv: "BASE",
    apiKeyEnv: "KEY",
    balanceCurrency: "USD-denominated credits" as const,
    rechargeCashCny: 1,
    creditsReceivedUsd: 1,
    observedBillingMultiplier,
    priceSource: "fixture",
    priceObservedAt: "2026-01-01",
    health: "healthy" as const,
    priority: 1,
    enabled: true,
    effectiveCostStatus: "verified" as const,
    effectiveCostSource: "fixture",
    effectiveCostVersion: "test-v1",
  };
}
