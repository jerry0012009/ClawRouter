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
    const routingModels = new Set(exported.curveModelStatuses.map((item: { modelId: string }) => item.modelId));
    const configuredRoutingModels = new Set(profiles.filter((profile: {
      enabled?: boolean; administratorAllowed?: boolean; autoRouteEnabled?: boolean;
    }) => profile.enabled === true && profile.administratorAllowed === true
      && profile.autoRouteEnabled !== false).map((profile: { modelId: string }) => profile.modelId));
    expect(new Set(exported.responses.map((item: { modelId: string }) => item.modelId))).toEqual(routingModels);
    for (const modelId of routingModels) expect(configuredRoutingModels).toContain(modelId);
    const unavailable = exported.responses.filter((item: { currentlyEligible: boolean }) => !item.currentlyEligible);
    expect(unavailable.length).toBeGreaterThan(0);
    for (const item of unavailable) {
      expect(item.status).toBe("temporarily_unavailable");
      expect(item.activeInAcuAuto).toBe(false);
      expect(item.healthyChannelCount).toBe(0);
      expect(item.temporarilyUnavailableReason).toMatch(/temporarily unavailable/);
      expect(routingModels).toContain(item.modelId);
    }
    for (const item of exported.responses) {
      const catalogModel = source.models.find((model: { modelId: string }) => model.modelId === item.modelId);
      expect(catalogModel).toMatchObject({
        routingEligible: true,
        inputPricePerMillion: item.inputPricePerMillion,
        outputPricePerMillion: item.outputPricePerMillion,
        cachedInputPricePerMillion: item.cachedInputPricePerMillion,
      });
      expect(item.costCurrency).toBe("CNY");
      expect(item.costSemantics).toBe("estimated_user_payable_price");
      expect(item.payable).toMatchObject({
        inputCnyPerMillion: item.effectiveInputPriceCnyPerMillion,
        outputCnyPerMillion: item.effectiveOutputPriceCnyPerMillion,
        pricingPolicyVersion: "acu-retail-v1",
      });
      expect(Object.keys(item.payableByProtocol).length).toBeGreaterThan(0);
      for (const price of Object.values(item.payableByProtocol) as Array<{
        inputCnyPerMillion: number; outputCnyPerMillion: number; pricingPolicyVersion: string;
      }>) {
        expect(price.inputCnyPerMillion).toBeGreaterThan(0);
        expect(price.outputCnyPerMillion).toBeGreaterThan(0);
        expect(price.pricingPolicyVersion).toBe("acu-retail-v1");
      }
      const cheapestProtocol = Object.values(item.payableByProtocol).reduce((left: any, right: any) =>
        left.inputCnyPerMillion + left.outputCnyPerMillion
          <= right.inputCnyPerMillion + right.outputCnyPerMillion ? left : right);
      expect(item.payable.inputCnyPerMillion).toBe(cheapestProtocol.inputCnyPerMillion);
      expect(item.payable.outputCnyPerMillion).toBe(cheapestProtocol.outputCnyPerMillion);
      for (const privateKey of ["costProvider", "costChannel", "costExecutionProfileId",
        "costObservedBillingMultiplier"]) {
        expect(item).not.toHaveProperty(privateKey);
      }
      expect(item).toHaveProperty("currentlyEligible");
      expect(item.effectiveInputPriceCnyPerMillion).toBeGreaterThan(0);
      expect(item.effectiveOutputPriceCnyPerMillion).toBeGreaterThan(0);
      expect(item.payable.pricingPolicyVersion).toBe("acu-retail-v1");
      expect(item.curve).toHaveLength(101);
      expect(item.curve[0].difficultyScore).toBe(0);
      expect(item.curve[100].difficultyScore).toBe(100);
      const protocols = new Set(profiles.filter((profile: { modelId: string; autoRouteEnabled?: boolean }) =>
        profile.modelId === item.modelId && profile.autoRouteEnabled !== false)
        .flatMap((profile: { protocols: string[] }) => profile.protocols));
      for (const protocol of item.protocol.split(" + ")) {
        expect(protocols).toContain(protocol === "Responses" ? "responses" : "messages");
      }
    }
    expect(routingModels.size).toBeLessThanOrEqual(source.models.length);
    const luna = exported.responses.find((item: { modelId: string }) => item.modelId === "gpt-5.6-luna");
    expect(luna).toMatchObject({
      costCurrency: "CNY",
      reference: {
        outputCnyPerMillion: 8.64,
        sourceType: "official",
        sourceName: "OpenAI official pricing",
        originalCurrency: "USD",
        fxCnyPerUsd: 7.2,
      },
    });
    expect(luna.effectiveInputPriceCnyPerMillion).toBeCloseTo(0.05, 10);
    expect(luna.effectiveOutputPriceCnyPerMillion).toBeCloseTo(0.3, 10);
    expect(luna.payableByProtocol.messages.inputCnyPerMillion).toBeCloseTo(2.7, 10);
    expect(luna.payableByProtocol.responses.inputCnyPerMillion).toBeCloseTo(0.05, 10);
    expect(luna.payable.status).toBe("estimated");
    const pricedSol = exported.responses.find((item: { modelId: string }) => item.modelId === "gpt-5.6-sol");
    expect(pricedSol.effectiveInputPriceCnyPerMillion).toBeCloseTo(0.5, 10);
    expect(pricedSol.effectiveOutputPriceCnyPerMillion).toBeCloseTo(3, 10);
    expect(pricedSol.payable.status).toBe("estimated");
    const profileModels = new Map(source.models.map((item: { modelId: string; inputPricePerMillion: number;
      outputPricePerMillion: number }) => [item.modelId, item]));
    for (const profile of profiles.filter((item: { provider: string; billingPrice?: unknown }) =>
      ["code28", "wawazz"].includes(item.provider) && item.billingPrice)) {
      const base = profileModels.get(profile.modelId)!;
      expect(profile.billingPrice).toMatchObject({
        inputPricePerMillion: base.inputPricePerMillion,
        outputPricePerMillion: base.outputPricePerMillion,
        status: "estimated",
      });
      expect(profile.effectiveCostStatus).toBe("estimated");
    }
    expect(luna.reference.inputCnyPerMillion).toBeCloseTo(1.44);
    const fable = exported.responses.find((item: { modelId: string }) => item.modelId === "claude-fable-5");
    expect(fable).toMatchObject({
      effectiveInputPriceCnyPerMillion: 3.75,
      effectiveOutputPriceCnyPerMillion: 18.75,
      protocol: "Messages",
    });
    expect(fable.payableByProtocol.messages.cachedInputCnyPerMillion).toBeCloseTo(0.375, 10);
    expect(fable.payableByProtocol.messages.cacheWriteCnyPerMillion).toBeCloseTo(4.6875, 10);
    const kimiK3 = exported.responses.find((item: { modelId: string }) => item.modelId === "kimi-k3");
    expect(kimiK3.effectiveInputPriceCnyPerMillion).toBeCloseTo(10);
    expect(kimiK3.effectiveOutputPriceCnyPerMillion).toBeCloseTo(50);
    expect(kimiK3).toMatchObject({ protocol: "Responses" });
    expect(kimiK3.reference).toBeUndefined();
    expect(kimiK3).toMatchObject({ curveProfile: "frontier_resilient", profileConfidence: "medium" });
    const kimiK3Source = source.models.find((item: { modelId: string }) => item.modelId === "kimi-k3");
    expect(kimiK3Source.evidenceConfidence).toBe("medium");
    expect(kimiK3Source.abilityAnchor).toBeCloseTo(0.9305169312, 8);
    expect(kimiK3.curve[75].estimatedQuality).toBeGreaterThan(0.8);
    expect(fable.curve[75].estimatedQuality - kimiK3.curve[75].estimatedQuality).toBeLessThan(0.1);
    const solSource = source.models.find((item: { modelId: string }) => item.modelId === "gpt-5.6-sol");
    expect(solSource).toMatchObject({
      curveProfile: "frontier_resilient",
      evidenceConfidence: "medium",
      uncertaintyWidth: 0.1,
    });
    expect(solSource.abilityAnchor).toBeCloseTo(0.8952818863, 8);
    expect(solSource.benchmarkEvidence[0]).toMatchObject({
      sourceModelName: "GPT-5.6 Sol (medium)",
      evaluationMode: "independent composite; explicit medium reasoning effort",
    });
    const sol = exported.responses.find((item: { modelId: string }) => item.modelId === "gpt-5.6-sol");
    expect(sol.curve[50].estimatedQuality).toBeCloseTo(0.8920271189, 8);
    const glm52Source = source.models.find((item: { modelId: string }) => item.modelId === "glm-5.2");
    expect(glm52Source).toMatchObject({ evidenceConfidence: "medium", uncertaintyWidth: 0.1 });
    expect(glm52Source.abilityAnchor).toBeCloseTo(0.8702515368, 8);
    const glm52 = exported.responses.find((item: { modelId: string }) => item.modelId === "glm-5.2");
    expect(glm52.curve[50].estimatedQuality).toBeCloseTo(0.8696127004, 8);
  });

  it("keeps all six Founder catalog surfaces aligned", async () => {
    const [exported, syncSql, compose] = await Promise.all([
      readFile("deploy/alpha/newapi-acu-catalog.json", "utf8").then(JSON.parse),
      readFile("deploy/alpha/sync-newapi-codex-pool.sql", "utf8"),
      readFile("deploy/alpha/docker-compose.yml", "utf8"),
    ]);
    const expected = [
      "acu-auto", "claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "deepseek-v4-flash",
      "gemini-2.5-flash", "glm-5.1", "glm-5.2", "gpt-5.4-mini", "gpt-5.5",
      "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "kimi-k2.6", "kimi-k2.7-code", "kimi-k3",
    ];
    expect(exported.auto.modelId).toBe("acu-auto");
    for (const modelId of exported.responses.map((item: { modelId: string }) => item.modelId)) {
      expect(expected).toContain(modelId);
    }
    for (const modelId of expected) expect(syncSql).toContain(modelId);
    expect(syncSql).toContain("INSERT INTO models");
    expect(syncSql).toContain(`model_limits = '${expected.join(",")}'`);
    expect(compose).toContain("0004_rc2_context_ledger.sql");
    expect(compose).toContain("0005_rc2_judge_reconciliation.sql");
    expect(compose).toContain("ACU_JUDGE_ECONOMICS_PROVIDER_ID: lucen");
  });
});
