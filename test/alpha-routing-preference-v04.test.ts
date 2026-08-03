import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { continuousTierProbabilities } from "../src/acu/math.js";
import type { AcuJudgeResult } from "../src/acu/types.js";
import {
  ROUTING_PREFERENCE_PARAMETERS,
  routeWithCurrentAcuFormula,
  type AlphaExecutionProfile,
  type RoutingPreference,
} from "../src/alpha/routing.js";
import type { ProviderEconomicsCatalog } from "../src/alpha/provider-economics.js";

type ConfiguredProfile = AlphaExecutionProfile & {
  apiKeyEnv: string;
  economicsProviderId?: string;
  observedBillingMultiplier?: number;
};

async function productionPricedProfiles(): Promise<ConfiguredProfile[]> {
  const profiles = JSON.parse(await readFile(
    new URL("../deploy/alpha/execution-profiles.json", import.meta.url),
    "utf8",
  )) as ConfiguredProfile[];
  const economics = JSON.parse(await readFile(
    new URL("../deploy/alpha/provider-economics.json", import.meta.url),
    "utf8",
  )) as ProviderEconomicsCatalog;
  return profiles.map((profile) => {
    const providerEconomics = economics.providers.find((item) => (
      item.providerId === (profile.economicsProviderId ?? profile.provider)
    ));
    return {
      ...profile,
      economics: providerEconomics && {
        ...providerEconomics,
        apiKeyEnv: profile.apiKeyEnv,
        observedBillingMultiplier: profile.observedBillingMultiplier
          ?? providerEconomics.observedBillingMultiplier,
        enabled: profile.effectiveCostStatus === "missing" ? false : providerEconomics.enabled,
        health: profile.channelId ? "healthy" : providerEconomics.health,
      },
    };
  });
}

function judgeAt(difficulty: number): AcuJudgeResult {
  return {
    ...continuousTierProbabilities(difficulty / 100),
    confidence: 1,
    difficultyScoreRaw: difficulty,
    factors: {
      reasoningDepth: difficulty / 10,
      taskScope: difficulty / 10,
      constraintDensity: difficulty / 10,
      toolDependency: difficulty / 10,
      verificationBurden: difficulty / 10,
      contextBurden: difficulty / 10,
    },
    factorComposite: difficulty,
    difficultyIndex: difficulty,
    difficultyMethodVersion: "acu-difficulty-index-v1",
    difficultyScore: difficulty,
    signals: [],
    explanation: "Preference v0.4 boundary fixture",
  };
}

describe("routing preference v0.4", () => {
  it("keeps one continuous Luna Max range, then switches to Sol without returning", async () => {
    const profiles = await productionPricedProfiles();
    for (const routingPreference of ["economy", "balanced", "quality"] as const) {
      const selected = Array.from({ length: 51 }, (_, index) => routeWithCurrentAcuFormula({
        judge: judgeAt(index * 2),
        judgeCost: 0,
        inputTokens: 100_000,
        expectedOutputTokens: 4_000,
        effectiveQualityTarget: 80,
        routingPreference,
        profiles,
        requirements: {
          protocol: "responses",
          requireTools: true,
          requiredToolTypes: ["function", "custom", "local_tool"],
          requireThinking: false,
          contextTokens: 104_000,
          webIntent: "not_required",
        },
      }).recommendation.recommended.candidateId);
      const maxIndexes = selected.flatMap((candidateId, index) => (
        candidateId === "gpt-5.6-luna@max" ? [index] : []
      ));
      expect(maxIndexes.length).toBeGreaterThan(1);
      expect(maxIndexes.at(-1)! - maxIndexes[0]! + 1).toBe(maxIndexes.length);
      expect(selected[maxIndexes.at(-1)! + 1]).toMatch(/^gpt-5\.6-sol(?:@(?:high|xhigh))?$/);
      expect(selected.slice(maxIndexes.at(-1)! + 1)).not.toContain("gpt-5.6-luna@max");
    }
  });

  it("trades a limited amount of difficult-task quality for materially lower cost", async () => {
    const profiles = await productionPricedProfiles();
    const route = (preference: RoutingPreference, difficulty: number) => routeWithCurrentAcuFormula({
      judge: judgeAt(difficulty),
      judgeCost: 0,
      inputTokens: 100_000,
      expectedOutputTokens: 4_000,
      effectiveQualityTarget: 80,
      routingPreference: preference,
      profiles,
      requirements: {
        protocol: "responses",
        requireTools: false,
        requireThinking: false,
        contextTokens: 104_000,
        webIntent: "not_required",
      },
    });

    const economyMidHard = route("economy", 40);
    const economyHard = route("economy", 54);
    const balancedExtreme = route("balanced", 100);
    const qualityExtreme = route("quality", 100);

    expect(ROUTING_PREFERENCE_PARAMETERS.quality).toEqual({
      qualityTargetOffset: 8,
      costSensitivity: 0.45,
      fallbackRiskScale: 1.25,
    });
    expect(economyMidHard.selectedProfile.modelId).toBe("gpt-5.6-sol");
    expect(economyHard.selectedProfile.modelId).toBe("gpt-5.6-sol");
    expect(balancedExtreme.selectedProfile.modelId).toBe("gpt-5.6-sol");
    expect(qualityExtreme.selectedProfile.modelId).toBe("kimi-k3");
    expect(balancedExtreme.recommendation.recommended.estimatedCallCost)
      .toBeLessThan(qualityExtreme.recommendation.recommended.estimatedCallCost);
    expect(qualityExtreme.recommendation.recommended.estimatedQuality)
      .toBeGreaterThan(balancedExtreme.recommendation.recommended.estimatedQuality);
  });
});
