import { describe, expect, it, vi } from "vitest";
import { AlphaRequestProcessor, codexSelectionCorridorRequirements, selectionCorridorJudge } from "../src/alpha/processor.js";
import { ACU_CURVE_DIFFICULTIES, getAcuModel, interpolateModelCurve } from "../src/acu/catalog.js";
import { applyLogitShift, continuousTierProbabilities } from "../src/acu/math.js";
import type { AlphaExecutionProfile } from "../src/alpha/routing.js";

const lunaProfile: AlphaExecutionProfile = {
  executionProfileId: "verified:gpt-5.6-luna:responses",
  modelId: "gpt-5.6-luna",
  provider: "verified",
  channel: "openai",
  protocols: ["responses"],
  toolCallSupport: true,
  supportedToolTypes: ["function", "custom", "local_tool"],
  thinkingSupport: true,
  contextWindow: 1_048_576,
  health: "healthy",
  enabled: true,
  administratorAllowed: true,
  usageTrusted: true,
};

describe("selection corridor cache", () => {
  it("derives corridor tier probabilities from the continuous difficulty distribution", () => {
    for (const difficulty of ACU_CURVE_DIFFICULTIES) {
      const result = selectionCorridorJudge(difficulty);
      const expected = continuousTierProbabilities(difficulty / 100);
      expect(result.pLow).toBe(expected.pLow);
      expect(result.pMid).toBe(expected.pMid);
      expect(result.pMidHigh).toBe(expected.pMidHigh);
      expect(result.pHigh).toBe(expected.pHigh);
      expect([result.pLow, result.pMid, result.pMidHigh, result.pHigh]
        .every((probability) => Number.isFinite(probability) && probability >= 0 && probability <= 1)).toBe(true);
      expect(result.pLow + result.pMid + result.pMidHigh + result.pHigh).toBeCloseTo(1, 12);
      expect(result.difficultyIndex).toBe(difficulty);
      expect(result.difficultyScore).toBe(difficulty);
    }
    expect(selectionCorridorJudge(0).pLow).toBeGreaterThan(selectionCorridorJudge(0).pHigh);
    expect(selectionCorridorJudge(50).pMid + selectionCorridorJudge(50).pMidHigh).toBeGreaterThan(
      selectionCorridorJudge(50).pLow + selectionCorridorJudge(50).pHigh,
    );
    expect(selectionCorridorJudge(100).pHigh).toBeGreaterThan(selectionCorridorJudge(100).pLow);
    expect(selectionCorridorJudge(0).pLow).toBeGreaterThan(selectionCorridorJudge(100).pLow);
    expect(selectionCorridorJudge(0).pHigh).toBeLessThan(selectionCorridorJudge(100).pHigh);
  });

  it("uses ordinary Codex Agent tool requirements", () => {
    expect(codexSelectionCorridorRequirements(10_000, 1_000)).toEqual({
      protocol: "responses",
      requireTools: true,
      requiredToolTypes: ["function", "custom", "local_tool"],
      requireThinking: false,
      contextTokens: 11_000,
      expectedOutputTokens: 1_000,
      webIntent: "not_required",
    });
  });

  it("coalesces identical work and keeps token assumptions as part of the key", async () => {
    const processor = new AlphaRequestProcessor({} as never);
    const calculate = vi.fn(async (inputTokens: number, expectedOutputTokens: number) => ({
      inputTokens,
      expectedOutputTokens,
    }));
    const internal = processor as unknown as {
      calculateSelectionCorridor: typeof calculate;
    };
    internal.calculateSelectionCorridor = calculate;

    const [first, second] = await Promise.all([
      processor.selectionCorridor(10_000, 1_000),
      processor.selectionCorridor(10_000, 1_000),
    ]);
    const repeated = await processor.selectionCorridor(10_000, 1_000);
    const different = await processor.selectionCorridor(10_001, 1_000);

    expect(first).toEqual(second);
    expect(repeated).toEqual(first);
    expect(different).not.toEqual(first);
    expect(calculate).toHaveBeenCalledTimes(2);
  });

  it("does not retain a failed calculation", async () => {
    const processor = new AlphaRequestProcessor({} as never);
    const calculate = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockRejectedValueOnce(new Error("health read failed"))
      .mockResolvedValueOnce({ ok: true });
    const internal = processor as unknown as {
      calculateSelectionCorridor: typeof calculate;
    };
    internal.calculateSelectionCorridor = calculate;

    await expect(processor.selectionCorridor(20_000, 2_000)).rejects.toThrow(
      "health read failed"
    );
    await expect(processor.selectionCorridor(20_000, 2_000)).resolves.toEqual({ ok: true });
    expect(calculate).toHaveBeenCalledTimes(2);
  });

  it("publishes enabled execution presets as candidate-identity series", async () => {
    const processor = new AlphaRequestProcessor({} as never);
    const internal = processor as unknown as {
      effectiveProfiles: () => Promise<{ profiles: AlphaExecutionProfile[]; probeClaims: [] }>;
      calculateSelectionCorridor: (inputTokens: number, outputTokens: number) => Promise<Record<string, unknown>>;
    };
    internal.effectiveProfiles = async () => ({ profiles: [
      lunaProfile,
      { ...lunaProfile, executionProfileId: "verified:gpt-5.6-sol:responses", modelId: "gpt-5.6-sol" },
      { ...lunaProfile, executionProfileId: "verified:gpt-5.6-terra:responses", modelId: "gpt-5.6-terra" },
    ], probeClaims: [] });

    const result = await internal.calculateSelectionCorridor(100_000, 4_000) as {
      series: Record<string, Array<{ difficulty: number }>>;
      executionPresetSeries: Array<{
        candidateId: string;
        modelId: string;
        displayName: string;
        executionPresetId: string;
        reasoningEffort: string;
        calibrationStatus: string;
        expectedOutputTokenMultiplier: number;
        estimatedOutputTokens: number;
        points: Array<{ difficulty: number; estimatedQuality: number; estimatedCallCost: number }>;
      }>;
    };

    expect(result.executionPresetSeries).toHaveLength(4);
    expect(result.executionPresetSeries[0]).toMatchObject({
      candidateId: "gpt-5.6-luna@max",
      modelId: "gpt-5.6-luna",
      displayName: "GPT-5.6 Luna · Max",
      executionPresetId: "gpt-5.6-luna:max",
      reasoningEffort: "max",
      calibrationStatus: "provisional",
      expectedOutputTokenMultiplier: 1.6,
      estimatedOutputTokens: 6_400,
    });
    const luna = getAcuModel("gpt-5.6-luna")!;
    for (const preference of ["economy", "balanced", "quality"]) {
      expect(result.series[preference]).toHaveLength(101);
      expect(result.series[preference]?.map((point) => point.difficulty)).toEqual(ACU_CURVE_DIFFICULTIES);
    }
    expect(result.executionPresetSeries[0]?.points).toHaveLength(101);
    expect(result.executionPresetSeries[0]?.points.map((point) => point.difficulty)).toEqual(
      ACU_CURVE_DIFFICULTIES,
    );
    expect(result.executionPresetSeries[0]?.points.every((point) => point.estimatedCallCost > 0)).toBe(true);
    expect(result.executionPresetSeries[0]?.points.every((point) => (
      Math.abs(
        point.estimatedQuality / 100
          - applyLogitShift(interpolateModelCurve(luna, point.difficulty).estimatedQuality, 0.22),
      ) < 1e-12
    ))).toBe(true);
    expect(result.executionPresetSeries[0]?.points.every((point) => point.estimatedQuality < 99.95)).toBe(true);
    expect(result.executionPresetSeries.map((series) => series.candidateId)).toEqual([
      "gpt-5.6-luna@max", "gpt-5.6-sol@high", "gpt-5.6-sol@xhigh", "gpt-5.6-terra@max",
    ]);
    expect(result.executionPresetSeries.map((series) => [series.candidateId, series.points.length])).toEqual([
      ["gpt-5.6-luna@max", 101], ["gpt-5.6-sol@high", 101], ["gpt-5.6-sol@xhigh", 101], ["gpt-5.6-terra@max", 101],
    ]);
    for (const difficulty of [84, 85, 86]) {
      expect(result.executionPresetSeries.every((series) => (
        series.points.some((point) => point.difficulty === difficulty)
      ))).toBe(true);
    }
    expect(result.executionPresetSeries.find((series) => series.candidateId === "gpt-5.6-sol@high")).toMatchObject({
      estimatedOutputTokens: 7_000, reasoningEffort: "high", expectedOutputTokenMultiplier: 1.75,
    });
    expect(result.executionPresetSeries.find((series) => series.candidateId === "gpt-5.6-sol@xhigh")).toMatchObject({
      estimatedOutputTokens: 11_667, reasoningEffort: "xhigh", expectedOutputTokenMultiplier: 35 / 12,
    });
    expect(result.executionPresetSeries.find((series) => series.candidateId === "gpt-5.6-terra@max")).toMatchObject({
      estimatedOutputTokens: 38_400, reasoningEffort: "max", expectedOutputTokenMultiplier: 9.6,
    });
  });

  it("recomputes the corridor from the supplied policy and cache key", async () => {
    const processor = new AlphaRequestProcessor({} as never);
    const internal = processor as unknown as {
      effectiveProfiles: () => Promise<{ profiles: AlphaExecutionProfile[]; probeClaims: [] }>;
      calculateSelectionCorridor: (inputTokens: number, outputTokens: number, policy?: { allowedModelIds?: string[]; allowedProfileIds?: string[]; routingPreference?: "economy" | "balanced" | "quality" }) => Promise<Record<string, unknown>>;
    };
    internal.effectiveProfiles = async () => ({ profiles: [lunaProfile, { ...lunaProfile, executionProfileId: "verified:gpt-5.6-sol:responses", modelId: "gpt-5.6-sol" }], probeClaims: [] });
    const result = await internal.calculateSelectionCorridor(100_000, 4_000, { allowedModelIds: ["gpt-5.6-sol"], routingPreference: "economy" }) as { series: Record<string, Array<{ candidates: Array<{ modelId: string }> }>>; defaultPreference: string };
    expect(result.defaultPreference).toBe("economy");
    expect(result.series.economy?.flatMap((point) => point.candidates).every((candidate) => candidate.modelId === "gpt-5.6-sol")).toBe(true);
  });
});
