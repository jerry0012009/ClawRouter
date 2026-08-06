import { describe, expect, it } from "vitest";
import { validateProviderChannelRegistry, validateProviderModelProfiles } from "../src/alpha/channel-registry.js";
import { economicsForExecutionProfile } from "../src/alpha/server.js";
import { getAcuModel } from "../src/acu/catalog.js";
import channels from "../deploy/alpha/provider-channels.json";
import executionProfiles from "../deploy/alpha/execution-profiles.json";

describe("Provider Channel Registry", () => {
  it("contains one non-secret environment reference per Channel", () => {
    const registry = validateProviderChannelRegistry(channels);
    expect(registry.channels).toHaveLength(56);
    expect(new Set(registry.channels.map((item) => item.apiKeyEnv)).size).toBe(56);
    expect(JSON.stringify(registry)).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it("profiles every verified canonical Messages model on the new Channels", () => {
    const expectedModels = ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5"];
    for (const channel of ["code28-claude", "code28-claude-deal", "wawazz-claude-max", "wawazz-kiro"]) {
      const models = executionProfiles
        .filter((profile) => profile.channel === channel && profile.protocols.includes("messages"))
        .map((profile) => profile.modelId)
        .sort();
      expect(models).toEqual(expectedModels);
    }
  });

  it("does not advertise auto-route Profiles outside the canonical routing catalog", () => {
    for (const profile of executionProfiles.filter((item) => item.autoRouteEnabled !== false)) {
      expect(getAcuModel(profile.modelId)?.routingEligible, profile.executionProfileId).toBe(true);
    }
  });

  it("rejects active profiles without verified billing evidence", () => {
    expect(() => validateProviderModelProfiles({
      schemaVersion: "acu-provider-model-profile-registry-v1",
      generatedAt: new Date().toISOString(),
      profiles: [{ executionProfileId: "bad", channelId: "c", providerId: "p", canonicalModelId: "m",
        providerModelId: "m", protocol: "responses", toolCallSupport: true, supportedToolTypes: [],
        thinkingSupport: true, supportedReasoningEfforts: [], contextWindow: 1, actualModelVerified: false,
        usageTrusted: true, effectivePriceAvailable: true, effectiveCostStatus: "verified", health: "healthy",
        healthReason: "", lastVerifiedAt: null, activeInAcuAuto: true }],
    })).toThrow(/active Profile lacks verified/);
  });

  it("does not inherit legacy provider cooldown for an independently monitored Channel", () => {
    const economics = economicsForExecutionProfile({
      providerId: "lucen",
      displayName: "Lucen",
      protocol: "openai_responses",
      baseUrlEnv: "LUCEN_BASE_URL",
      apiKeyEnv: "LUCEN_API_KEY",
      balanceCurrency: "USD-denominated credits",
      rechargeCashCny: 500,
      creditsReceivedUsd: 500,
      observedBillingMultiplier: 0.07,
      priceSource: "test",
      priceObservedAt: "2026-07-29T00:00:00Z",
      health: "cooldown",
      priority: 10,
      enabled: true,
      effectiveCostSource: "test",
      effectiveCostVersion: "test-v1",
    }, {
      apiKeyEnv: "ACU_CHANNEL_LUCEN_CX006_VALUE_DYNAMIC_API_KEY",
      channelId: "lucen-cx006-value-dynamic",
      effectiveCostStatus: "estimated",
      observedBillingMultiplier: 0.07,
    });

    expect(economics.health).toBe("healthy");
    expect(economics.apiKeyEnv).toBe("ACU_CHANNEL_LUCEN_CX006_VALUE_DYNAMIC_API_KEY");
  });
});
