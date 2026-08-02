import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cashCnyPerNominalUsd, providerCostBreakdown, providerCreditCashCostCny, validateProviderEconomicsCatalog } from "../src/alpha/provider-economics.js";
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
  it("separates nominal USD, Provider Credits, and cash CNY", () => {
    const lucenCost = providerCostBreakdown(healthyLucen, 0.139364);
    expect(lucenCost).toMatchObject({
      nominalProviderCostUsd: 0.139364,
      providerBalanceCurrency: "USD-denominated credits",
      providerCreditCashCostCny: 1,
    });
    expect(lucenCost.providerBalanceCharge).toBeCloseTo(0.00836184, 10);
    expect(lucenCost.effectiveCashCostCny).toBeCloseTo(0.00836184, 10);
    expect(providerCreditCashCostCny(catalog.providers.find((item) => item.providerId === "blackai")!)).toBe(0.14);
    expect(providerCreditCashCostCny(closeai)).toBe(7.2);
  });

  it("reproduces the founder-confirmed cx025 Lucen charge", () => {
    const nominalCost = (4_473 * 1 + 6 * 6) / 1_000_000;
    const cost = providerCostBreakdown({ ...healthyLucen, observedBillingMultiplier: 0.25 }, nominalCost);
    expect(cost.providerCreditCashCostCny).toBe(1);
    expect(cost.providerBalanceCharge).toBeCloseTo(0.00112725, 10);
    expect(cost.effectiveCashCostCny).toBeCloseTo(0.00112725, 10);
  });

  it("converts Judge nominal USD with the configured CloseAI cash settlement", () => {
    expect(cashCnyPerNominalUsd(closeai)).toBe(10.8);
    expect(0.00124605 * cashCnyPerNominalUsd(closeai)).toBeCloseTo(0.01345734, 10);
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
