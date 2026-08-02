import { afterEach, describe, expect, it } from "vitest";
import { getAcuModel, interpolateModelCurve } from "../src/acu/catalog.js";
import { recommendModel } from "../src/acu/decision.js";
import { calculateProviderCost, parseProviderUsage } from "../src/alpha/usage.js";

const input = {
  probabilities: { pLow: 0.1, pMid: 0.2, pMidHigh: 0.5, pHigh: 0.2, confidence: 0.8 },
  difficultyScore: 67.2, inputTokens: 10_000, expectedOutputTokens: 1_000, judgeCost: 0,
  eligibleModelIds: ["gpt-5.6-luna"], effectivePrices: { "gpt-5.6-luna": { inputPricePerMillion: 2, outputPricePerMillion: 10 } },
};

afterEach(() => delete process.env.ACU_LUNA_MAX_PRESET_ENABLED);

describe("Luna Max execution preset", () => {
  it("adds one candidate without adding a canonical model", () => {
    process.env.ACU_LUNA_MAX_PRESET_ENABLED = "false";
    expect(recommendModel(input).estimates.map((item) => item.candidateId)).toEqual(["gpt-5.6-luna"]);
    process.env.ACU_LUNA_MAX_PRESET_ENABLED = "true";
    const estimates = recommendModel(input).estimates;
    expect(estimates.map((item) => item.candidateId).sort()).toEqual(["gpt-5.6-luna", "gpt-5.6-luna@max"]);
    expect(new Set(estimates.map((item) => item.modelId))).toEqual(new Set(["gpt-5.6-luna"]));
  });

  it("uses +3.5 score points and 1.6x output prediction only", () => {
    const luna = getAcuModel("gpt-5.6-luna")!;
    const baseQuality = interpolateModelCurve(luna, input.difficultyScore).estimatedQuality;
    const estimates = recommendModel(input);
    const base = estimates.estimates.find((item) => item.candidateId === "gpt-5.6-luna")!;
    const max = estimates.estimates.find((item) => item.candidateId === "gpt-5.6-luna@max")!;
    expect(max.estimatedQuality).toBeCloseTo(Math.min(1, baseQuality + 0.035), 12);
    expect(max.estimatedCallCost - base.estimatedCallCost).toBeCloseTo(600 * 10 / 1_000_000, 12);
    expect(max.executionPresetId).toBe("gpt-5.6-luna:max");
    expect(max.reasoningEffort).toBe("max");
  });

  it("does not apply the multiplier or reasoning detail to actual billing", () => {
    const usage = parseProviderUsage({ protocol: "responses", requestedModel: "gpt-5.6-luna", requestBytes: 100,
      contentType: "application/json", body: Buffer.from(JSON.stringify({ model: "gpt-5.6-luna", usage: { input_tokens: 100, output_tokens: 1000,
        output_tokens_details: { reasoning_tokens: 600 } } })), billingPrice: { inputPricePerMillion: 2, outputPricePerMillion: 10,
        currency: "USD_CREDIT", source: "test", observedAt: "2026-08-03", status: "verified" } });
    expect(usage.reasoningTokens).toBe(600n);
    expect(usage.providerCostUsd).toBe(((100 * 2 + 1000 * 10) / 1_000_000).toFixed(10));
    expect(calculateProviderCost("gpt-5.6-luna", 0n, 0n, 1000n, { inputPricePerMillion: 2, outputPricePerMillion: 10 })).toBe("0.0100000000");
  });

  it("parses Messages thinking detail before legacy reasoning_tokens", () => {
    const usage = parseProviderUsage({ protocol: "messages", requestedModel: "gpt-5.6-luna", requestBytes: 100,
      contentType: "application/json", body: Buffer.from(JSON.stringify({ model: "gpt-5.6-luna", usage: { input_tokens: 100,
        output_tokens: 1000, reasoning_tokens: 500, output_tokens_details: { thinking_tokens: 600 } } })) });
    expect(usage.reasoningTokens).toBe(600n);
    const legacy = parseProviderUsage({ protocol: "messages", requestedModel: "gpt-5.6-luna", requestBytes: 100,
      contentType: "application/json", body: Buffer.from(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 1000, reasoning_tokens: 500 } })) });
    expect(legacy.reasoningTokens).toBe(500n);
  });
});
