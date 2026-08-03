import { afterEach, describe, expect, it } from "vitest";
import { getAcuCatalog, getAcuModel, interpolateModelCurve } from "../src/acu/catalog.js";
import { recommendModel } from "../src/acu/decision.js";
import { applyLogitShift } from "../src/acu/math.js";
import { calculateProviderCost, parseProviderUsage } from "../src/alpha/usage.js";
import { ACU_EXECUTION_PRESETS, enabledExecutionPresets } from "../src/acu/execution-presets.js";

const input = {
  probabilities: { pLow: 0.1, pMid: 0.2, pMidHigh: 0.5, pHigh: 0.2, confidence: 0.8 },
  difficultyScore: 67.2, inputTokens: 10_000, expectedOutputTokens: 1_000, judgeCost: 0,
  eligibleModelIds: ["gpt-5.6-luna"], effectivePrices: { "gpt-5.6-luna": { inputPricePerMillion: 2, outputPricePerMillion: 10 } },
};

const presetFlags = ACU_EXECUTION_PRESETS.map((preset) => preset.featureFlagEnv);

afterEach(() => presetFlags.forEach((flag) => delete process.env[flag]));

describe("execution presets", () => {
  it("has unique candidate IDs and defaults every flag to enabled", () => {
    expect(new Set(ACU_EXECUTION_PRESETS.map((preset) => preset.candidateId)).size).toBe(4);
    expect(enabledExecutionPresets()).toEqual(ACU_EXECUTION_PRESETS);
  });

  it.each(ACU_EXECUTION_PRESETS)("switches $candidateId independently", (disabled) => {
    process.env[disabled.featureFlagEnv] = "FaLsE";
    expect(enabledExecutionPresets().map((preset) => preset.candidateId)).toEqual(
      ACU_EXECUTION_PRESETS.filter((preset) => preset !== disabled).map((preset) => preset.candidateId),
    );
  });

  it("adds candidates without adding canonical models", () => {
    const catalogModelIds = getAcuCatalog().models.map((model) => model.modelId);
    expect(catalogModelIds).toHaveLength(25);
    expect(catalogModelIds.some((modelId) => modelId.includes("@"))).toBe(false);
    expect(catalogModelIds.some((modelId) => ACU_EXECUTION_PRESETS.some((preset) => preset.candidateId === modelId))).toBe(false);
    const estimates = recommendModel({ ...input, eligibleModelIds: ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] }).estimates;
    expect(estimates.filter((item) => item.executionPresetId).map((item) => item.candidateId).sort()).toEqual(
      ACU_EXECUTION_PRESETS.map((preset) => preset.candidateId).sort(),
    );
    expect(new Set(estimates.map((item) => item.modelId))).toEqual(
      new Set(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]),
    );
  });

  it.each(ACU_EXECUTION_PRESETS)("applies $candidateId quality and output calibration", (preset) => {
    const model = getAcuModel(preset.modelId)!;
    const baseQuality = interpolateModelCurve(model, input.difficultyScore).estimatedQuality;
    const result = recommendModel({ ...input, eligibleModelIds: [preset.modelId],
      effectivePrices: { [preset.modelId]: { inputPricePerMillion: 2, outputPricePerMillion: 10 } } });
    const base = result.estimates.find((item) => item.candidateId === preset.modelId)!;
    const candidate = result.estimates.find((item) => item.candidateId === preset.candidateId)!;
    const extraOutput = Math.round(input.expectedOutputTokens * preset.expectedOutputTokenMultiplier) - input.expectedOutputTokens;
    expect(candidate.estimatedQuality).toBeCloseTo(applyLogitShift(baseQuality, preset.qualityLogitShift), 12);
    expect(candidate.estimatedCallCost - base.estimatedCallCost).toBeCloseTo(extraOutput * 10 / 1_000_000, 12);
    expect(candidate.executionPresetId).toBe(preset.presetId);
    expect(candidate.reasoningEffort).toBe(preset.canonicalReasoningEffort);
  });

  it.each(ACU_EXECUTION_PRESETS)("produces a finite, smooth, monotone $candidateId curve without a 100-point plateau", (preset) => {
    const points = Array.from({ length: 101 }, (_, difficultyScore) => recommendModel({ ...input, difficultyScore,
      eligibleModelIds: [preset.modelId] }).estimates.find((item) => item.candidateId === preset.candidateId)!.estimatedQuality);
    expect(points.every((quality) => Number.isFinite(quality) && quality > 0 && quality < 1)).toBe(true);
    expect(points.every((quality, index) => index === 0 || quality <= points[index - 1]!)).toBe(true);
    expect(points.every((quality, index) => index === 0 || Math.abs(quality - points[index - 1]!) < 0.1)).toBe(true);
    expect(Number((points[0]! * 100).toFixed(1))).toBeLessThan(100);
    expect(points.filter((quality) => quality === 1)).toHaveLength(0);
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
