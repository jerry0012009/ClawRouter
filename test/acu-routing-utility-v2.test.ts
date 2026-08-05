import { describe, expect, it } from "vitest";
import {
  ACU_MODEL_UTILITY_V2_VERSION,
  ACU_QUALITY_SATISFACTION_ANCHORS,
  ACU_QUALITY_SATISFACTION_VERSION,
  recommendModelV2,
} from "../src/acu/decision.js";
import { continuousTierProbabilities, piecewiseLinearSatisfaction } from "../src/acu/math.js";
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
      expect(candidate.baseValueUtility).toBe(candidate.valueUtility);
      expect(candidate.candidatePreferenceScore).toBe(100);
      expect(candidate.candidatePreferenceMultiplier).toBe(1);
      expect(candidate.adjustedValueUtility).toBe(candidate.valueUtility);
      expect(Number.isFinite(candidate.rawQualityUtility)).toBe(true);
      expect(Number.isFinite(candidate.rawCostUtility)).toBe(true);
      expect(candidate.qualitySatisfactionUtility).toBeCloseTo(
        piecewiseLinearSatisfaction(candidate.conservativeQuality, ACU_QUALITY_SATISFACTION_ANCHORS),
        12,
      );
      expect(candidate.qualitySatisfactionVersion).toBe(ACU_QUALITY_SATISFACTION_VERSION);
      expect(candidate.qualityUtility).toBe(candidate.qualitySatisfactionUtility);
      expect(candidate.costUtility).toBe(candidate.rawCostUtility);
      expect(candidate.normalizedQualityUtility).toBeUndefined();
      expect(candidate.normalizedCostUtility).toBeUndefined();
      expect(candidate.normalizationVersion).toBeUndefined();
      expect(candidate.formulaVersion).toBe(ACU_MODEL_UTILITY_V2_VERSION);
      expect(Number.isFinite(candidate.valueUtility)).toBe(true);
    }
  });

  it("applies sparse candidate preferences without changing objective candidate metrics", () => {
    const neutral = recommendModelV2({ ...modelInput, qualityBias: 0, modelCostLogScale: 2.5 });
    const adjusted = recommendModelV2({
      ...modelInput,
      qualityBias: 0,
      modelCostLogScale: 2.5,
      candidatePreferenceScores: { "gpt-5.6-luna": 0, "gpt-5.6-sol": 200 },
    });
    const byId = new Map(neutral.estimates.map((candidate) => [candidate.candidateId, candidate]));
    for (const candidate of adjusted.estimates) {
      const baseline = byId.get(candidate.candidateId)!;
      expect(candidate.candidatePreferenceMultiplier).toBe(candidate.modelId === "gpt-5.6-sol" ? 1.5 : 0.5);
      expect(candidate.adjustedValueUtility).toBeCloseTo(
        candidate.baseValueUtility! * candidate.candidatePreferenceMultiplier!, 12,
      );
      expect({
        quality: candidate.estimatedQuality,
        conservative: candidate.conservativeQuality,
        cost: candidate.estimatedCallCost,
        costUtility: candidate.costUtility,
        qualityUtility: candidate.qualitySatisfactionUtility,
        pareto: candidate.paretoEfficient,
      }).toEqual({
        quality: baseline.estimatedQuality,
        conservative: baseline.conservativeQuality,
        cost: baseline.estimatedCallCost,
        costUtility: baseline.costUtility,
        qualityUtility: baseline.qualitySatisfactionUtility,
        pareto: baseline.paretoEfficient,
      });
    }
  });

  it("changes nearby selection and honors preferences at both quality-bias endpoints", () => {
    const closePrices = {
      "gpt-5.6-luna": { inputPricePerMillion: 1, outputPricePerMillion: 1 },
      "gpt-5.6-sol": { inputPricePerMillion: 1, outputPricePerMillion: 1 },
    };
    const neutral = recommendModelV2({ ...modelInput, effectivePrices: closePrices, qualityBias: 0, modelCostLogScale: 2.5 });
    const preferred = recommendModelV2({
      ...modelInput, effectivePrices: closePrices, qualityBias: 0, modelCostLogScale: 2.5,
      candidatePreferenceScores: { "gpt-5.6-luna": 200, "gpt-5.6-sol": 0 },
    });
    expect(neutral.recommended.modelId).toBe("gpt-5.6-sol");
    expect(preferred.recommended.modelId).toBe("gpt-5.6-luna");
    for (const qualityBias of [-100, 100]) {
      const result = recommendModelV2({
        ...modelInput, qualityBias, modelCostLogScale: 2.5,
        candidatePreferenceScores: { "gpt-5.6-luna": 0, "gpt-5.6-sol": 200 },
      });
      const ordered = [...result.estimates].sort((left, right) =>
        right.adjustedValueUtility! - left.adjustedValueUtility!
        || right.conservativeQuality - left.conservativeQuality
        || left.estimatedCallCost - right.estimatedCallCost
        || left.candidateId.localeCompare(right.candidateId));
      expect(result.recommended.candidateId).toBe(ordered[0]?.candidateId);
    }
  });

  it("allows base and preset candidates to have independent scope and preferences", () => {
    const result = recommendModelV2({
      ...modelInput,
      eligibleModelIds: ["gpt-5.6-luna"],
      qualityBias: 0,
      modelCostLogScale: 2.5,
      includeExecutionPresets: true,
      allowedCandidateIds: ["gpt-5.6-luna@max"],
      candidatePreferenceScores: { "gpt-5.6-luna": 80, "gpt-5.6-luna@max": 150 },
    });
    expect(result.estimates.map((candidate) => candidate.candidateId)).toEqual(["gpt-5.6-luna@max"]);
    expect(result.recommended).toMatchObject({
      candidateId: "gpt-5.6-luna@max",
      modelId: "gpt-5.6-luna",
      executionPresetId: "gpt-5.6-luna:max",
      candidatePreferenceScore: 150,
      candidatePreferenceMultiplier: 1.25,
    });
  });

  it("filters forbidden presets before cost, Pareto, and utility calculations", () => {
    const withoutPresets = recommendModelV2({ ...modelInput, qualityBias: 0, modelCostLogScale: 2.5, includeExecutionPresets: false });
    const filtered = recommendModelV2({
      ...modelInput, qualityBias: 0, modelCostLogScale: 2.5, includeExecutionPresets: true,
      allowedCandidateIds: ["gpt-5.6-luna", "gpt-5.6-sol"],
    });
    expect(filtered.estimates).toEqual(withoutPresets.estimates);
  });

  it("values the same quality gain more at low quality than above 95 percent", () => {
    const satisfaction = (quality: number) => piecewiseLinearSatisfaction(
      quality,
      ACU_QUALITY_SATISFACTION_ANCHORS,
    );
    expect(satisfaction(0.4) - satisfaction(0.39)).toBeGreaterThan(
      satisfaction(0.97) - satisfaction(0.96),
    );
  });

  it("keeps absolute quality utility independent of the eligible candidate set", () => {
    const lunaOnly = recommendModelV2({
      ...modelInput,
      eligibleModelIds: ["gpt-5.6-luna"],
      qualityBias: 0,
      modelCostLogScale: 0.75,
    });
    const both = recommendModelV2({ ...modelInput, qualityBias: 0, modelCostLogScale: 0.75 });
    const luna = both.estimates.find((candidate) => candidate.modelId === "gpt-5.6-luna")!;
    expect(luna.qualityUtility).toBeCloseTo(lunaOnly.recommended.qualityUtility, 12);
    expect(luna.qualityUtility).toBeLessThan(1);
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
    expect(active.formulaVersion).toBe(ACU_MODEL_UTILITY_V2_VERSION);
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

  it("treats the candidate allowlist as a hard constraint in legacy, shadow, and active modes", () => {
    const routeProfiles = ["luna", "sol", "terra"].map((tier): AlphaExecutionProfile => ({
      ...profile(`provider-${tier}`, 1, 100, 0.9),
      executionProfileId: `provider:gpt-5.6-${tier}:responses`,
      modelId: `gpt-5.6-${tier}`,
      providerModelId: `gpt-5.6-${tier}`,
      contextWindow: 1_000_000,
      usageTrusted: true,
      supportedReasoningEfforts: ["max", "high", "xhigh"],
    }));
    const base = {
      judge: {
        ...continuousTierProbabilities(0.5),
        difficultyScoreRaw: 50, difficultyIndex: 50, difficultyScore: 50, factorComposite: 50,
        difficultyMethodVersion: "acu-difficulty-index-v1" as const,
        factors: { reasoningDepth: 0, taskScope: 0, constraintDensity: 0, toolDependency: 0,
          verificationBurden: 0, contextBurden: 0 },
        signals: [], explanation: "fixture",
      },
      judgeCost: 0.01, inputTokens: 10_000, expectedOutputTokens: 1_000,
      effectiveQualityTarget: 70, profiles: routeProfiles,
      requirements: { protocol: "responses" as const, requireTools: true, requireThinking: false, contextTokens: 11_000 },
      includeExecutionPresets: true,
    };

    for (const formulaMode of ["legacy", "shadow", "active"] as const) {
      const result = routeWithCurrentAcuFormula({
        ...base,
        utilityPolicy: {
          ...DEFAULT_ROUTING_UTILITY_POLICY,
          formulaMode,
          allowedCandidateIds: ["gpt-5.6-luna@max"],
          candidatePreferenceScores: { "gpt-5.6-luna@max": 200 },
        },
      });
      expect(result.candidateEstimates.map((candidate) => candidate.candidateId))
        .toEqual(["gpt-5.6-luna@max"]);
      expect(result.paretoFrontier).toEqual(["gpt-5.6-luna@max"]);
      expect(result.recommendation.recommended.candidateId).toBe("gpt-5.6-luna@max");
      if (formulaMode === "active") {
        expect(result.recommendation.estimates[0]).toMatchObject({
          rank: 1,
          candidatePreferenceScore: 200,
          candidatePreferenceMultiplier: 1.5,
        });
      } else {
        expect(result.recommendation.estimates[0]?.rank).toBeUndefined();
        expect(result.recommendation.estimates[0]?.candidatePreferenceScore).toBeUndefined();
      }
      if (formulaMode === "shadow") {
        expect(result.v2Counterfactual?.modelCandidates).toHaveLength(1);
        expect(result.v2Counterfactual?.modelCandidates[0]).toMatchObject({
          candidateId: "gpt-5.6-luna@max",
          rank: 1,
          candidatePreferenceScore: 200,
          candidatePreferenceMultiplier: 1.5,
        });
      }
    }
  });

  it("selects a preset-compatible Profile without changing Standard Profile selection", () => {
    const cheap = {
      ...profile("cheap", 1, 100, 0.9),
      contextWindow: 1_000_000,
      usageTrusted: true,
      supportedReasoningEfforts: ["high"],
      reasoningOverride: { rejectedEfforts: ["max"] },
    };
    const compatible = {
      ...profile("compatible", 10, 100, 0.9),
      contextWindow: 1_000_000,
      usageTrusted: true,
      supportedReasoningEfforts: ["max"],
    };
    const base = {
      judge: {
        ...continuousTierProbabilities(0.5),
        difficultyScoreRaw: 50, difficultyIndex: 50, difficultyScore: 50, factorComposite: 50,
        difficultyMethodVersion: "acu-difficulty-index-v1" as const,
        factors: { reasoningDepth: 0, taskScope: 0, constraintDensity: 0, toolDependency: 0,
          verificationBurden: 0, contextBurden: 0 },
        signals: [], explanation: "fixture",
      },
      judgeCost: 0, inputTokens: 10_000, expectedOutputTokens: 1_000,
      effectiveQualityTarget: 70, profiles: [cheap, compatible],
      requirements: { protocol: "responses" as const, requireTools: true, requireThinking: false, contextTokens: 11_000 },
      includeExecutionPresets: true,
    };
    for (const formulaMode of ["legacy", "shadow", "active"] as const) {
      const preset = routeWithCurrentAcuFormula({
        ...base,
        utilityPolicy: {
          ...DEFAULT_ROUTING_UTILITY_POLICY,
          formulaMode,
          supplyWeights: { cost: 100, speed: 0, reliability: 0 },
          allowedCandidateIds: ["gpt-5.6-luna@max"],
        },
      });
      expect(preset.selectedProfile.executionProfileId).toBe("compatible");
      expect(preset.providerCandidateEstimates.map((candidate) => candidate.executionProfileId))
        .toEqual(["compatible"]);

      const standard = routeWithCurrentAcuFormula({
        ...base,
        utilityPolicy: {
          ...DEFAULT_ROUTING_UTILITY_POLICY,
          formulaMode,
          supplyWeights: { cost: 100, speed: 0, reliability: 0 },
          allowedCandidateIds: ["gpt-5.6-luna"],
        },
      });
      expect(standard.selectedProfile.executionProfileId).toBe("cheap");
    }
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
    for (const utility of result.utilities) {
      expect(Number.isFinite(utility.rawCostUtility)).toBe(true);
      expect(Number.isFinite(utility.rawSpeedUtility)).toBe(true);
      expect(Number.isFinite(utility.rawReliabilityUtility)).toBe(true);
      expect(utility.normalizationVersion).toBe("acu-benefit-range-v1");
      expect(utility.formulaVersion).toBe("acu-profile-utility-v2.1");
    }
  });

  it("does not apply candidate preferences to Profile ranking", () => {
    const neutral = scoreExecutionProfilesV2(profiles, 100_000, 4_000, {
      ...DEFAULT_ROUTING_UTILITY_POLICY,
      formulaMode: "active",
      candidatePreferenceScores: {},
    });
    const preferred = scoreExecutionProfilesV2(profiles, 100_000, 4_000, {
      ...DEFAULT_ROUTING_UTILITY_POLICY,
      formulaMode: "active",
      candidatePreferenceScores: { "gpt-5.6-luna": 200 },
    });
    expect(preferred).toEqual(neutral);
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
      result.utilities.find((value) => value.executionProfileId === "degraded")?.rawReliabilityUtility,
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
