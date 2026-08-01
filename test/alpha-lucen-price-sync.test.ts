import { describe, expect, it } from "vitest";
import { getAcuModel } from "../src/acu/catalog.js";
import { selectValueRoute } from "../src/acu/decision.js";

describe("Lucen nominal price synchronization", () => {
  it("uses the directly billed GLM 5.2 nominal rates", () => {
    const glm = getAcuModel("glm-5.2");
    expect(glm?.inputPricePerMillion).toBe(8);
    expect(glm?.outputPricePerMillion).toBe(28);
    expect(glm?.cachedInputPricePerMillion).toBe(2);
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
