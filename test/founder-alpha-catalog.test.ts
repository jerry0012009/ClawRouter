import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Founder Alpha New API catalog export", () => {
  it("matches the versioned ACU catalog and verified Responses profiles", async () => {
    const [source, exported, profiles] = await Promise.all([
      readFile("src/acu/catalog/model-catalog.json", "utf8").then(JSON.parse),
      readFile("deploy/alpha/newapi-acu-catalog.json", "utf8").then(JSON.parse),
      readFile("deploy/alpha/execution-profiles.json", "utf8").then(JSON.parse),
    ]);
    expect(exported.sourceCatalogVersion).toBe(source.schemaVersion);
    expect(exported.responses).toHaveLength(5);
    for (const item of exported.responses) {
      const catalogModel = source.models.find((model: { modelId: string }) => model.modelId === item.modelId);
      expect(catalogModel).toMatchObject({
        routingEligible: true,
        inputPricePerMillion: item.inputPricePerMillion,
        outputPricePerMillion: item.outputPricePerMillion,
        cachedInputPricePerMillion: item.cachedInputPricePerMillion,
      });
      expect(profiles.some((profile: { modelId: string; protocols: string[] }) => (
        profile.modelId === item.modelId && profile.protocols.includes("responses")
      ))).toBe(true);
    }
    expect(new Set(exported.curveModelStatuses.map((item: { modelId: string }) => item.modelId)))
      .toEqual(new Set(source.models.map((item: { modelId: string }) => item.modelId)));
  });
});
