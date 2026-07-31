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
    const routingModels = new Set(profiles.filter((profile: {
      enabled?: boolean; administratorAllowed?: boolean; autoRouteEnabled?: boolean;
    }) => profile.enabled === true && profile.administratorAllowed === true
      && profile.autoRouteEnabled !== false).map((profile: { modelId: string }) => profile.modelId));
    expect(new Set(exported.responses.map((item: { modelId: string }) => item.modelId))).toEqual(routingModels);
    for (const item of exported.responses) {
      const catalogModel = source.models.find((model: { modelId: string }) => model.modelId === item.modelId);
      expect(catalogModel).toMatchObject({
        routingEligible: true,
        inputPricePerMillion: item.inputPricePerMillion,
        outputPricePerMillion: item.outputPricePerMillion,
        cachedInputPricePerMillion: item.cachedInputPricePerMillion,
      });
      const protocols = new Set(profiles.filter((profile: { modelId: string }) => profile.modelId === item.modelId)
        .flatMap((profile: { protocols: string[] }) => profile.protocols));
      expect(item.protocol).toBe([...protocols].sort()
        .map((protocol) => protocol === "responses" ? "Responses" : "Messages").join(" + "));
    }
    expect(new Set(exported.curveModelStatuses.map((item: { modelId: string }) => item.modelId)))
      .toEqual(new Set(source.models.map((item: { modelId: string }) => item.modelId)));
  });

  it("keeps all six Founder catalog surfaces aligned", async () => {
    const [exported, syncSql, compose] = await Promise.all([
      readFile("deploy/alpha/newapi-acu-catalog.json", "utf8").then(JSON.parse),
      readFile("deploy/alpha/sync-newapi-codex-pool.sql", "utf8"),
      readFile("deploy/alpha/docker-compose.yml", "utf8"),
    ]);
    const expected = [
      "acu-auto", "claude-opus-4-8", "claude-sonnet-5", "deepseek-v4-flash",
      "gemini-2.5-flash", "glm-5.1", "glm-5.2", "gpt-5.4-mini", "gpt-5.5",
      "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "kimi-k2.6", "kimi-k2.7-code",
    ];
    expect([exported.auto.modelId, ...exported.responses.map((item: { modelId: string }) => item.modelId)])
      .toEqual(expected);
    for (const modelId of expected) expect(syncSql).toContain(modelId);
    expect(syncSql).toContain("INSERT INTO models");
    expect(syncSql).toContain(`model_limits = '${expected.join(",")}'`);
    expect(compose).toContain("0004_rc2_context_ledger.sql");
    expect(compose).toContain("0005_rc2_judge_reconciliation.sql");
    expect(compose).toContain("ACU_JUDGE_ECONOMICS_PROVIDER_ID: closeai");
  });
});
