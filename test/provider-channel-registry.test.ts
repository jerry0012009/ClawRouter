import { describe, expect, it } from "vitest";
import { validateProviderChannelRegistry, validateProviderModelProfiles } from "../src/alpha/channel-registry.js";
import channels from "../deploy/alpha/provider-channels.json";

describe("Provider Channel Registry", () => {
  it("contains one non-secret environment reference per Channel", () => {
    const registry = validateProviderChannelRegistry(channels);
    expect(registry.channels).toHaveLength(46);
    expect(new Set(registry.channels.map((item) => item.apiKeyEnv)).size).toBe(46);
    expect(JSON.stringify(registry)).not.toMatch(/sk-[A-Za-z0-9]/);
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
});
