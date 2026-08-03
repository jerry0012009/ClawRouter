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

describe("routing preference v0.5", () => {
  it("keeps one continuous Luna Max range, then switches to Sol without returning", async () => {
    const profiles = await productionPricedProfiles();
    for (const routingPreference of ["economy", "balanced", "quality"] as const) {
      const selected = Array.from({ length: 101 }, (_, difficulty) => routeWithCurrentAcuFormula({
        judge: judgeAt(difficulty),
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

  it("favors base Sol before deeper reasoning without route re-entry", async () => {
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

    expect(ROUTING_PREFERENCE_PARAMETERS).toEqual({
      economy: { qualityTargetOffset: -6, costSensitivity: 2.8, fallbackRiskScale: 0.22 },
      balanced: { qualityTargetOffset: -1, costSensitivity: 1.6, fallbackRiskScale: 0.30 },
      quality: { qualityTargetOffset: 6, costSensitivity: 1.0, fallbackRiskScale: 0.70 },
    });
    const series = Object.fromEntries((["economy", "balanced", "quality"] as const).map((preference) => [
      preference,
      Array.from({ length: 101 }, (_, difficulty) => route(preference, difficulty).recommendation.recommended),
    ]));
    expect(series.economy[72]?.candidateId).toBe("gpt-5.6-sol");
    expect(series.balanced[72]?.candidateId).toBe("gpt-5.6-sol@high");
    expect(series.economy.some((candidate) => candidate.modelId === "kimi-k3")).toBe(false);
    expect(series.balanced.some((candidate) => candidate.modelId === "kimi-k3")).toBe(false);
    expect(series.quality[100]?.candidateId).toMatch(/^(?:gpt-5\.6-sol@xhigh|kimi-k3)$/);
    expect(series.quality.some((candidate) => candidate.candidateId === "gpt-5.6-sol@xhigh")).toBe(true);
    expect([...series.balanced, ...series.quality]
      .some((candidate) => candidate.candidateId === "gpt-5.6-sol@high")).toBe(true);

    const expectedRanges = {
      economy: [["gpt-5.6-luna", 0, 2], ["gpt-5.6-luna@max", 3, 45], ["gpt-5.6-sol", 46, 81], ["gpt-5.6-sol@high", 82, 100]],
      balanced: [["gpt-5.6-luna", 0, 0], ["gpt-5.6-luna@max", 1, 39], ["gpt-5.6-sol", 40, 64], ["gpt-5.6-sol@high", 65, 77], ["gpt-5.6-sol@xhigh", 78, 100]],
      quality: [["gpt-5.6-luna@max", 0, 28], ["gpt-5.6-sol", 29, 42], ["gpt-5.6-sol@high", 43, 52], ["gpt-5.6-sol@xhigh", 53, 80], ["kimi-k3", 81, 100]],
    } as const;
    const candidateRuns = (candidates: typeof series.economy) => {
      const runs: Array<{ candidateId: string; length: number }> = [];
      for (const candidate of candidates) {
        const last = runs.at(-1);
        if (last?.candidateId === candidate.candidateId) last.length += 1;
        else runs.push({ candidateId: candidate.candidateId, length: 1 });
      }
      return runs;
    };
    for (const preference of ["economy", "balanced", "quality"] as const) {
      const candidates = series[preference];
      const runs = candidateRuns(candidates);
      expect(new Set(runs.map((run) => run.candidateId)).size).toBe(runs.length);
      expect(runs.filter((run) => /@(?:high|xhigh)$|kimi-k3/.test(run.candidateId))
        .every((run) => run.length > 1)).toBe(true);
      let start = 0;
      expect(runs.map((run) => {
        const result = [run.candidateId, start, start + run.length - 1] as const;
        start += run.length;
        return result;
      })).toEqual(expectedRanges[preference]);
    }

    const abilityRank: Record<string, number> = {
      "gpt-5.6-luna": 0, "gpt-5.6-luna@max": 1, "gpt-5.6-sol": 2,
      "gpt-5.6-sol@high": 3, "gpt-5.6-sol@xhigh": 4, "kimi-k3": 5,
    };
    const differentPoints = series.economy.filter((candidate, difficulty) => (
      candidate.candidateId !== series.balanced[difficulty]?.candidateId
    )).length;
    const balancedHigherPoints = series.balanced.filter((candidate, difficulty) => (
      abilityRank[candidate.candidateId]! > abilityRank[series.economy[difficulty]!.candidateId]!
    )).length;
    expect(differentPoints).toBe(44);
    expect(balancedHigherPoints).toBe(44);
    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const economyCost = average(series.economy.map((candidate) => candidate.estimatedCallCost));
    const balancedCost = average(series.balanced.map((candidate) => candidate.estimatedCallCost));
    const economyQuality = average(series.economy.map((candidate) => candidate.estimatedQuality));
    const balancedQuality = average(series.balanced.map((candidate) => candidate.estimatedQuality));
    expect(balancedQuality).toBeGreaterThan(economyQuality);
    expect(balancedCost / economyCost - 1).toBeGreaterThan(0.22);
    expect(balancedCost / economyCost - 1).toBeLessThan(0.25);
  });
});
