import { describe, expect, it } from "vitest";
import {
  buildPayablePricing,
  buildReferencePricing,
  parsePricingDisplayMode,
  selectPayableProfile,
  selectPublicReferenceSource,
} from "../src/alpha/pricing-view.js";

describe("public Pricing view", () => {
  it("defaults display mode to comparison without affecting price calculation", () => {
    expect(parsePricingDisplayMode(undefined)).toBe("comparison");
    expect(["payable_only", "reference_only", "comparison"].map(parsePricingDisplayMode))
      .toEqual(["payable_only", "reference_only", "comparison"]);
  });

  it("builds payable from route cash cost and retail markup", () => {
    const base = {
      billingPrice: { inputPricePerMillion: 2, outputPricePerMillion: 10,
        cachedInputPricePerMillion: 0.2, status: "verified" as const },
      cashCnyPerNominalUsd: 0.06,
      effectiveCostStatus: "verified",
      pricingPolicyVersion: "retail-v2",
    };
    expect(buildPayablePricing({ ...base, retailMarkupMultiplier: 1 })).toMatchObject({
      inputCnyPerMillion: 0.12, outputCnyPerMillion: 0.6, cachedInputCnyPerMillion: 0.012,
      status: "verified",
    });
    const markedUp = buildPayablePricing({ ...base, retailMarkupMultiplier: 1.5 });
    expect(markedUp.inputCnyPerMillion).toBeCloseTo(0.18);
    expect(markedUp.outputCnyPerMillion).toBeCloseTo(0.9);
    expect(markedUp.cachedInputCnyPerMillion).toBeCloseTo(0.018);
  });

  it("uses independent FX for USD references and no FX for native CNY", () => {
    const official = { vendor: "Anthropic", models: ["sonnet"] };
    expect(buildReferencePricing({
      price: { inputPricePerMillion: 2, outputPricePerMillion: 10, currency: "USD" },
      source: official, observedAt: "2026-08-02", fxCnyPerUsd: 7.2,
    })).toMatchObject({ inputCnyPerMillion: 14.4, outputCnyPerMillion: 72, fxCnyPerUsd: 7.2 });
    expect(buildReferencePricing({
      price: { inputPricePerMillion: 4, outputPricePerMillion: 16, currency: "CNY" },
      source: { vendor: "Moonshot AI", models: ["kimi"] }, observedAt: "2026-08-02", fxCnyPerUsd: 7.2,
    })).toMatchObject({ inputCnyPerMillion: 4, outputCnyPerMillion: 16, originalCurrency: "CNY" });
  });

  it("prefers first-party sources, labels OpenRouter as public, and omits missing references", () => {
    const sources = [
      { vendor: "OpenRouter", models: ["model-a", "model-b"] },
      { vendor: "Vendor A", models: ["model-a"] },
    ];
    expect(selectPublicReferenceSource("model-a", sources)?.vendor).toBe("Vendor A");
    expect(buildReferencePricing({
      price: { inputPricePerMillion: 1, outputPricePerMillion: 2, currency: "USD" },
      source: selectPublicReferenceSource("model-b", sources), observedAt: "2026-08-02", fxCnyPerUsd: 7.2,
    })).toMatchObject({ sourceType: "openrouter", sourceName: "OpenRouter public pricing" });
    expect(buildReferencePricing({
      price: { inputPricePerMillion: 1, outputPricePerMillion: 2, currency: "USD" },
      source: undefined, observedAt: "2026-08-02", fxCnyPerUsd: 7.2,
    })).toBeUndefined();
  });

  it("does not select disabled, cooldown, unhealthy, or untrusted profiles", () => {
    const candidates = [
      { id: "disabled", enabled: false, administratorAllowed: true, health: "healthy", score: 1 },
      { id: "cooldown", enabled: true, administratorAllowed: true, health: "healthy", cooldownUntil: 200, score: 2 },
      { id: "unhealthy", enabled: true, administratorAllowed: true, health: "degraded", score: 3 },
      { id: "untrusted", enabled: true, administratorAllowed: true, health: "healthy", usageTrusted: false, score: 4 },
      { id: "eligible", enabled: true, administratorAllowed: true, health: "healthy", score: 5 },
    ];
    expect(selectPayableProfile(candidates, (profile) => profile.score, 100)?.id).toBe("eligible");
  });
});
