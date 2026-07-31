import { describe, expect, it, vi } from "vitest";
import { AlphaRequestProcessor } from "../src/alpha/processor.js";

describe("selection corridor cache", () => {
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
});
