import { describe, expect, it } from "vitest";
import { recommendModelV2 } from "../src/acu/decision.js";
import { continuousTierProbabilities } from "../src/acu/math.js";
import type { AlphaExecutionProfile } from "../src/alpha/routing.js";
import { resolveExplicitProfileDecision, routeWithCurrentAcuFormula } from "../src/alpha/routing.js";
import { routingReuseInvalidationReason } from "../src/alpha/processor.js";
import {
  DEFAULT_ROUTING_UTILITY_POLICY,
  resolveEffectiveQualityBias,
  scoreExecutionProfilesV2,
} from "../src/alpha/routing-utility-v2.js";

const modelInput = {
  probabilities: continuousTierProbabilities(0.5),
  difficultyScore: 50,
  inputTokens: 100_000,
  expectedOutputTokens: 4_000,
  judgeCost: 0.2,
  eligibleModelIds: ["gpt-5.6-luna", "gpt-5.6-sol"],
  includeExecutionPresets: false,
  effectivePrices: {
    "gpt-5.6-luna": { inputPricePerMillion: 1, outputPricePerMillion: 1 },
    "gpt-5.6-sol": { inputPricePerMillion: 100, outputPricePerMillion: 100 },
  },
};

function profile(
  id: string,
  cost: number,
  latency: number,
  reliability: number,
): AlphaExecutionProfile {
  return {
    executionProfileId: id,
    modelId: "gpt-5.6-luna",
    provider: id,
    channel: id,
    protocols: ["responses"],
    toolCallSupport: true,
    thinkingSupport: true,
    health: "healthy",
    enabled: true,
    administratorAllowed: true,
    billingPrice: { inputPricePerMillion: cost, outputPricePerMillion: cost },
    utilityEffectivePrices: { inputPricePerMillion: cost, outputPricePerMillion: cost },
    utilityRuntimeMetric: {
      firstEventP50Ms: latency,
      firstEventSamples: 10,
      totalLatencyP50Ms: latency * 2,
      totalLatencySamples: 10,
      consideredAttempts: 10,
      successfulAttempts: Math.round(reliability * 10),
    },
  };
}

describe("ACU Router V2 model utility", () => {
  it("strictly honors the cost and conservative-quality endpoints", () => {
    const cheapest = recommendModelV2({ ...modelInput, qualityBias: -100, modelCostLogScale: 2.5 });
    expect(cheapest.recommended.modelId).toBe("gpt-5.6-luna");
    const highestQuality = recommendModelV2({
      ...modelInput,
      qualityBias: 100,
      modelCostLogScale: 2.5,
    });
    expect(highestQuality.recommended.conservativeQuality).toBe(
      Math.max(...highestQuality.estimates.map((candidate) => candidate.conservativeQuality)),
    );
    expect(
      highestQuality.estimates.every(
        (candidate) =>
          candidate.expectedFallbackCost === 0 &&
          candidate.selectionCost === candidate.estimatedCallCost &&
          candidate.riskAdjustedCost === candidate.estimatedCallCost,
      ),
    ).toBe(true);
  });

  it("scores every finite candidate with a stable additive utility", () => {
    const first = recommendModelV2({ ...modelInput, qualityBias: 0, modelCostLogScale: 2.5 });
    const second = recommendModelV2({ ...modelInput, qualityBias: 0, modelCostLogScale: 2.5 });
    expect(first.estimates).toHaveLength(2);
    expect(first.estimates.map((candidate) => [candidate.candidateId, candidate.rank])).toEqual(
      second.estimates.map((candidate) => [candidate.candidateId, candidate.rank]),
    );
    for (const candidate of first.estimates) {
      expect(candidate.valueUtility).toBeCloseTo(
        0.5 * candidate.qualityUtility + 0.5 * candidate.costUtility,
        12,
      );
      expect(Number.isFinite(candidate.valueUtility)).toBe(true);
    }
  });

  it("keeps shadow selection legacy and switches only in active mode", () => {
    const routeProfiles = ["luna", "sol"].map((tier): AlphaExecutionProfile => ({
      ...profile(`provider-${tier}`, 1, 100, 0.9),
      executionProfileId: `provider:gpt-5.6-${tier}:responses`,
      modelId: `gpt-5.6-${tier}`,
      providerModelId: `gpt-5.6-${tier}`,
      contextWindow: 1_000_000,
      usageTrusted: true,
    }));
    const base = {
      judge: {
        ...continuousTierProbabilities(0.5),
        difficultyScoreRaw: 50,
        difficultyIndex: 50,
        difficultyScore: 50,
        factorComposite: 50,
        difficultyMethodVersion: "acu-difficulty-index-v1" as const,
        factors: {
          reasoningDepth: 0,
          taskScope: 0,
          constraintDensity: 0,
          toolDependency: 0,
          verificationBurden: 0,
          contextBurden: 0,
        },
        signals: [],
        explanation: "fixture",
      },
      judgeCost: 0.01,
      inputTokens: 10_000,
      expectedOutputTokens: 1_000,
      effectiveQualityTarget: 70,
      profiles: routeProfiles,
      requirements: {
        protocol: "responses" as const,
        requireTools: true,
        requireThinking: false,
        contextTokens: 11_000,
      },
    };
    const legacy = routeWithCurrentAcuFormula(base);
    const shadow = routeWithCurrentAcuFormula({
      ...base,
      utilityPolicy: { ...DEFAULT_ROUTING_UTILITY_POLICY, formulaMode: "shadow" },
    });
    expect(shadow.recommendation.recommended.candidateId).toBe(
      legacy.recommendation.recommended.candidateId,
    );
    expect(shadow.selectedProfile.executionProfileId).toBe(
      legacy.selectedProfile.executionProfileId,
    );
    expect(shadow.formulaVersion).toBe(legacy.formulaVersion);
    expect(shadow.v2Counterfactual).toBeDefined();
    expect(["same_selection", "model_selection_changed", "profile_selection_changed"]).toContain(
      shadow.v2Counterfactual?.differenceReason,
    );

    const active = routeWithCurrentAcuFormula({
      ...base,
      utilityPolicy: { ...DEFAULT_ROUTING_UTILITY_POLICY, formulaMode: "active" },
    });
    expect(active.formulaVersion).toBe("acu-model-utility-v2");
    expect(active.recommendation.recommended.candidateId).toBe(
      active.v2Counterfactual?.selectedCandidateId,
    );
    expect(active.selectedProfile.executionProfileId).toBe(
      active.v2Counterfactual?.selectedExecutionProfileId,
    );
    expect(active.legacyCounterfactual?.selectedCandidateId).toBe(
      legacy.recommendation.recommended.candidateId,
    );
    expect(active.providerSelectionReason).toContain("weights cost=");
  });
});

describe("ACU Router V2 Profile utility", () => {
  const profiles = [
    profile("cheap", 1, 900, 0.7),
    profile("fast", 3, 100, 0.8),
    profile("reliable", 5, 400, 1),
  ];

  it.each([
    [{ cost: 100, speed: 0, reliability: 0 }, "cheap"],
    [{ cost: 0, speed: 100, reliability: 0 }, "fast"],
    [{ cost: 0, speed: 0, reliability: 100 }, "reliable"],
  ] as const)("honors endpoint weights %o", (weights, expected) => {
    const result = scoreExecutionProfilesV2(profiles, 100_000, 4_000, {
      ...DEFAULT_ROUTING_UTILITY_POLICY,
      formulaMode: "active",
      supplyWeights: weights,
    });
    expect(result.selected.executionProfileId).toBe(expected);
    expect(result.utilities).toHaveLength(3);
  });

  it("does not treat unknown or small-sample data as fastest or perfectly reliable", () => {
    const unknown = {
      ...profile("unknown", 1, 100, 1),
      utilityRuntimeMetric: {
        firstEventSamples: 0,
        totalLatencySamples: 0,
        consideredAttempts: 1,
        successfulAttempts: 1,
      },
    };
    const result = scoreExecutionProfilesV2([profile("known", 1, 500, 0.8), unknown], 1_000, 100, {
      ...DEFAULT_ROUTING_UTILITY_POLICY,
      formulaMode: "active",
      supplyWeights: { cost: 0, speed: 100, reliability: 0 },
    });
    expect(result.selected.executionProfileId).toBe("known");
    const unknownUtility = result.utilities.find(
      (value) => value.executionProfileId === "unknown",
    )!;
    expect(unknownUtility.reliabilityUtility).toBeLessThanOrEqual(
      DEFAULT_ROUTING_UTILITY_POLICY.reliability.unknownDefault,
    );
  });

  it("uses first-event P50 first and total-latency P50 when first-event samples are insufficient", () => {
    const totalFallback = {
      ...profile("total-fallback", 1, 900, 0.8),
      utilityRuntimeMetric: {
        firstEventP50Ms: 50,
        firstEventSamples: 4,
        totalLatencyP50Ms: 200,
        totalLatencySamples: 10,
        consideredAttempts: 10,
        successfulAttempts: 8,
      },
    };
    const firstEvent = profile("first-event", 1, 300, 0.8);
    const result = scoreExecutionProfilesV2([totalFallback, firstEvent], 1_000, 100, {
      ...DEFAULT_ROUTING_UTILITY_POLICY,
      formulaMode: "active",
      supplyWeights: { cost: 0, speed: 100, reliability: 0 },
    });
    expect(result.selected.executionProfileId).toBe("total-fallback");
    expect(
      result.utilities.find((value) => value.executionProfileId === "total-fallback"),
    ).toMatchObject({ metricSource: "total_latency_p50", profileLatencyMs: 200 });
    expect(
      result.utilities.find((value) => value.executionProfileId === "first-event"),
    ).toMatchObject({ metricSource: "first_event_p50", profileLatencyMs: 300 });
  });

  it("uses observed reliability as the primary signal and applies degraded state correction", () => {
    const healthy = profile("healthy", 1, 100, 0.8);
    const degraded = {
      ...profile("degraded", 1, 100, 0.9),
      economics: { health: "degraded" } as AlphaExecutionProfile["economics"],
    };
    const result = scoreExecutionProfilesV2([healthy, degraded], 1_000, 100, {
      ...DEFAULT_ROUTING_UTILITY_POLICY,
      formulaMode: "active",
      supplyWeights: { cost: 0, speed: 0, reliability: 100 },
    });
    expect(result.selected.executionProfileId).toBe("healthy");
    expect(
      result.utilities.find((value) => value.executionProfileId === "degraded")?.reliabilityUtility,
    ).toBeCloseTo(0.9 * DEFAULT_ROUTING_UTILITY_POLICY.reliability.degradedMultiplier, 12);
  });

  it("applies acu-high and work phase offsets directly in bias space", () => {
    expect(
      resolveEffectiveQualityBias({
        qualityBias: 20,
        acuHighBiasOffset: 40,
        routeMode: "acu-high",
        workPhase: "planning",
        workPhaseBiasOffsets: DEFAULT_ROUTING_UTILITY_POLICY.workPhaseBiasOffsets,
      }),
    ).toBe(70);
    expect(
      resolveEffectiveQualityBias({
        qualityBias: -60,
        acuHighBiasOffset: 0,
        routeMode: "acu-auto",
        workPhase: "general",
        workPhaseBiasOffsets: DEFAULT_ROUTING_UTILITY_POLICY.workPhaseBiasOffsets,
        systemQualityBiasFloor: 70,
      }),
    ).toBe(70);
  });

  it("applies Supply Strategy to explicit models while preserving legacy and shadow selection", () => {
    const candidates = [
      profile("cheap", 1, 900, 0.7),
      profile("fast", 3, 100, 0.8),
      profile("reliable", 5, 400, 1),
    ];
    const requirements = {
      protocol: "responses" as const,
      requireTools: false,
      requireThinking: false,
      contextTokens: 1_000,
    };
    const decide = (formulaMode: "legacy" | "shadow" | "active", supplyWeights: {
      cost: number; speed: number; reliability: number;
    }) => resolveExplicitProfileDecision({
      requestedModel: "gpt-5.6-luna",
      profiles: candidates,
      requirements,
      inputTokens: 100_000,
      expectedOutputTokens: 4_000,
      utilityPolicy: {
        ...DEFAULT_ROUTING_UTILITY_POLICY,
        formulaMode,
        supplyWeights,
      },
    });

    const legacy = decide("legacy", { cost: 40, speed: 25, reliability: 35 });
    const shadow = decide("shadow", { cost: 0, speed: 100, reliability: 0 });
    expect(shadow.selectedProfile.executionProfileId).toBe(legacy.selectedProfile.executionProfileId);
    expect(shadow.v2SelectedProfile?.executionProfileId).toBe("fast");
    expect(shadow.profileUtilitiesV2).toHaveLength(3);

    expect(decide("active", { cost: 100, speed: 0, reliability: 0 }).selectedProfile.executionProfileId).toBe("cheap");
    expect(decide("active", { cost: 0, speed: 100, reliability: 0 }).selectedProfile.executionProfileId).toBe("fast");
    expect(decide("active", { cost: 0, speed: 0, reliability: 100 }).selectedProfile.executionProfileId).toBe("reliable");
    const balanced = decide("active", { cost: 40, speed: 25, reliability: 35 });
    expect(balanced.selectedProfile.executionProfileId).toBe(
      [...balanced.profileUtilitiesV2].sort((left, right) => left.rank - right.rank)[0]?.executionProfileId,
    );
    expect(balanced.orderedExecutionProfileIds).toEqual(
      [...balanced.profileUtilitiesV2].sort((left, right) => left.rank - right.rank)
        .map((utility) => utility.executionProfileId),
    );
  });
});

describe("Segment routing utility invalidation", () => {
  const same = {
    profilePolicyChanged: false,
    routingPolicyVersionMatches: true,
    modelFormulaVersionMatches: true,
    routingUtilityVersionMatches: true,
    formulaModeMatches: true,
  };

  it.each([
    ["custom bias", { routingUtilityVersionMatches: false }],
    ["supply strategy", { routingUtilityVersionMatches: false }],
    ["administrator supply preset", { routingUtilityVersionMatches: false }],
    ["shadow to active", { formulaModeMatches: false, modelFormulaVersionMatches: false }],
  ])("invalidates reuse when %s changes", (_label, changed) => {
    expect(routingReuseInvalidationReason({ ...same, ...changed })).toBe(
      changed.modelFormulaVersionMatches === false ? "routing_formula_changed" : "routing_utility_changed",
    );
  });

  it("keeps invalidation priority stable and reuses identical configuration", () => {
    expect(routingReuseInvalidationReason({
      ...same,
      profilePolicyChanged: true,
      routingPolicyVersionMatches: false,
      modelFormulaVersionMatches: false,
      routingUtilityVersionMatches: false,
    })).toBe("profile_policy_changed");
    expect(routingReuseInvalidationReason({ ...same, fallbackReason: "work_phase_route_refresh" })).toBe(
      "work_phase_route_refresh",
    );
    expect(routingReuseInvalidationReason(same)).toBeUndefined();
  });
});
