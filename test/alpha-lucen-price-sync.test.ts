import { describe, expect, it } from "vitest";
import { getAcuModel } from "../src/acu/catalog.js";
import { selectValueRoute } from "../src/acu/decision.js";
import { calculateProviderCost } from "../src/alpha/usage.js";

describe("official catalog and execution-profile billing prices", () => {
  it("keeps the official GLM 5.2 rates in the shared catalog", () => {
    const glm = getAcuModel("glm-5.2");
    expect(glm?.inputPricePerMillion).toBe(1.4);
    expect(glm?.outputPricePerMillion).toBe(4.4);
    expect(glm?.cachedInputPricePerMillion).toBe(0.26);
  });

  it("uses a verified execution-profile ledger price without changing the catalog", () => {
    const cost = calculateProviderCost("glm-5.2", 1_000_000n, 250_000n, 100_000n, {
      inputPricePerMillion: 8,
      outputPricePerMillion: 28,
      cachedInputPricePerMillion: 2,
    });
    expect(cost).toBe("9.3000000000");
    expect(getAcuModel("glm-5.2")?.inputPricePerMillion).toBe(1.4);
  });

  it("prices Messages cache reads and writes separately without subtracting them from input", () => {
    const cost = calculateProviderCost("claude-sonnet-5", 1_000_000n, 5_000_000n, 1_000_000n, {
      inputPricePerMillion: 2,
      outputPricePerMillion: 10,
      cachedInputPricePerMillion: 0.2,
    }, {
      cacheCreationInputTokens: 3_000_000n,
      cachedInputTokensIncludesCreation: true,
      inputIncludesCachedTokens: false,
      cacheWritePricePerMillion: 2.5,
    });
    expect(cost).toBe("19.9000000000");
  });

  it.each([59.3, 65.4, 68.3])(
    "removes GLM from the Pareto frontier when Sol strictly dominates at difficulty %s",
    () => {
      const result = selectValueRoute([
        { modelId: "gpt-5.6-sol", displayName: "Sol", predictedScore: 80,
          conservativeScore: 70, riskAdjustedCost: 0.003 },
        { modelId: "glm-5.2", displayName: "GLM 5.2", predictedScore: 74,
          conservativeScore: 64, riskAdjustedCost: 0.004 },
      ], 74, 1.8);
      expect(result.selected.modelId).toBe("gpt-5.6-sol");
      expect(result.utilities.has("glm-5.2")).toBe(false);
    },
  );
});
