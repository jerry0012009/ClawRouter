import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { providerCostBreakdown, validateProviderEconomicsCatalog } from "../src/alpha/provider-economics.js";
import { routeWithCurrentAcuFormula, type AlphaExecutionProfile } from "../src/alpha/routing.js";
import type { AcuJudgeResult } from "../src/acu/types.js";

const catalog = validateProviderEconomicsCatalog(JSON.parse(readFileSync(
  new URL("../deploy/alpha/provider-economics.json", import.meta.url), "utf8",
)) as unknown);
const lucen = catalog.providers.find((item) => item.providerId === "lucen")!;
const healthyLucen = { ...lucen, health: "healthy" as const };
const cooldownLucen = { ...lucen, health: "cooldown" as const };
const closeai = catalog.providers.find((item) => item.providerId === "closeai")!;
const judge: AcuJudgeResult = {
  pLow: 0.7, pMid: 0.2, pMidHigh: 0.08, pHigh: 0.02, confidence: 0.9,
  difficultyScoreRaw: 8, factorComposite: 8, difficultyIndex: 8, difficultyScore: 8,
  difficultyMethodVersion: "acu-difficulty-index-v1",
  factors: { reasoningDepth: 1, taskScope: 1, constraintDensity: 1, toolDependency: 1, verificationBurden: 1, contextBurden: 1 },
  signals: [], explanation: "fixture",
};

function profile(provider: "lucen" | "closeai", economics: typeof lucen): AlphaExecutionProfile {
  return {
    executionProfileId: `${provider}-mini`, modelId: "gpt-5.4-mini", providerModelId: "gpt-5.4-mini",
    provider, channel: `${provider}-primary`, protocols: ["responses"], toolCallSupport: true,
    thinkingSupport: true, contextWindow: 32768, health: "healthy", enabled: true,
    administratorAllowed: true, usageTrusted: true, recentSuccessRate: 1, observedLatencyMs: 1000, economics,
  };
}

describe("Provider Economics and v0.3 Provider selection", () => {
  it("separates nominal, provider-balance, and cash costs", () => {
    expect(providerCostBreakdown(healthyLucen, 1)).toMatchObject({
      nominalProviderCostUsd: 1,
      providerBalanceChargeUsd: 0.07,
      effectiveCashCostCny: 0.07,
    });
  });

  it("deduplicates model quality and selects the lower healthy effective-cash Provider", () => {
    const decision = routeWithCurrentAcuFormula({
      judge, judgeCost: 0, inputTokens: 1000, expectedOutputTokens: 100,
      effectiveQualityTarget: 70, routingPreference: "economy",
      profiles: [profile("closeai", closeai), profile("lucen", healthyLucen)],
      requirements: { protocol: "responses", requireTools: true, requireThinking: false, contextTokens: 1000 },
    });
    expect(decision.candidateEstimates).toHaveLength(1);
    expect(decision.candidateEstimates[0].executionProfileIds).toHaveLength(2);
    expect(decision.selectedProfile.provider).toBe("lucen");
    expect(decision.providerSelectionReason).toContain("lucen/lucen-primary/gpt-5.4-mini");
  });

  it("does not select an untrusted cheaper Provider", () => {
    const untrusted = { ...profile("lucen", healthyLucen), usageTrusted: false };
    const decision = routeWithCurrentAcuFormula({
      judge, judgeCost: 0, inputTokens: 1000, expectedOutputTokens: 100,
      effectiveQualityTarget: 70, profiles: [untrusted, profile("closeai", closeai)],
      requirements: { protocol: "responses", requireTools: true, requireThinking: false, contextTokens: 1000 },
    });
    expect(decision.selectedProfile.provider).toBe("closeai");
    expect(decision.excludedProfiles).toContainEqual({ executionProfileId: "lucen-mini", reasons: ["usage_untrusted"] });
  });

  it("does not select a lower-cost Provider while its economics health is in cooldown", () => {
    const decision = routeWithCurrentAcuFormula({
      judge, judgeCost: 0, inputTokens: 1000, expectedOutputTokens: 100,
      effectiveQualityTarget: 70,
      profiles: [profile("lucen", cooldownLucen), profile("closeai", closeai)],
      requirements: { protocol: "responses", requireTools: true, requireThinking: false, contextTokens: 1000 },
    });
    expect(decision.selectedProfile.provider).toBe("closeai");
    expect(decision.excludedProfiles).toContainEqual({ executionProfileId: "lucen-mini", reasons: ["provider_cooldown"] });
  });
});
