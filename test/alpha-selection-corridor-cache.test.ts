import { describe, expect, it, vi } from "vitest";
import { AlphaRequestProcessor, codexSelectionCorridorRequirements } from "../src/alpha/processor.js";
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
    internal.effectiveProfiles = async () => ({ profiles: [lunaProfile], probeClaims: [] });

    const result = await internal.calculateSelectionCorridor(100_000, 4_000) as {
      executionPresetSeries: Array<{
        candidateId: string;
        modelId: string;
        displayName: string;
        executionPresetId: string;
        reasoningEffort: string;
        calibrationStatus: string;
        points: Array<{ difficulty: number; estimatedQuality: number; estimatedCallCost: number }>;
      }>;
    };

    expect(result.executionPresetSeries).toHaveLength(1);
    expect(result.executionPresetSeries[0]).toMatchObject({
      candidateId: "gpt-5.6-luna@max",
      modelId: "gpt-5.6-luna",
      displayName: "GPT-5.6 Luna · Max",
      executionPresetId: "gpt-5.6-luna:max",
      reasoningEffort: "max",
      calibrationStatus: "provisional",
    });
    expect(result.executionPresetSeries[0]?.points).toHaveLength(51);
    expect(result.executionPresetSeries[0]?.points.map((point) => point.difficulty)).toEqual(
      Array.from({ length: 51 }, (_, index) => index * 2),
    );
    expect(result.executionPresetSeries[0]?.points.every((point) => point.estimatedCallCost > 0)).toBe(true);
  });
});
