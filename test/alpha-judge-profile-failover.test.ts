import { describe, expect, it } from "vitest";
import { getEligibleLunaJudgeProfiles } from "../src/alpha/judge-profile-selector.js";
import type { AlphaExecutionProfile } from "../src/alpha/routing.js";

function profile(id: string, overrides: Partial<AlphaExecutionProfile> = {}): AlphaExecutionProfile {
  return {
    executionProfileId: id,
    modelId: "gpt-5.6-luna",
    providerModelId: "gpt-5.6-luna",
    provider: "lucen",
    channel: id,
    protocols: ["responses"],
    toolCallSupport: true,
    thinkingSupport: false,
    health: "healthy",
    enabled: true,
    administratorAllowed: true,
    usageTrusted: true,
    contextCapabilityStatus: "observed_floor",
    ...overrides,
  };
}

describe("Luna Judge Profile selector", () => {
  it("prefers Lucen and never includes other models", () => {
    const selected = getEligibleLunaJudgeProfiles({
      preferredProfileId: "lucen-cx006-value-dynamic:gpt-5.6-luna:responses",
      profiles: [
        profile("blackai:gpt-5.6-luna:responses", { provider: "blackai" }),
        profile("lucen-cx006-value-dynamic:gpt-5.6-luna:responses"),
        profile("sol:gpt-5.6-luna:responses", { modelId: "gpt-5.6-luna", providerModelId: "gpt-5.6-luna" }),
        profile("rejected:gpt-5.6-luna:responses", { verificationStatus: "rejected" }),
        profile("terra", { modelId: "gpt-5.6-terra", providerModelId: "gpt-5.6-terra" }),
      ],
      requiredContextTokens: 100,
      maxProfiles: 3,
    });
    expect(selected.map((item) => item.executionProfileId)).toEqual([
      "lucen-cx006-value-dynamic:gpt-5.6-luna:responses",
      "blackai:gpt-5.6-luna:responses",
      "sol:gpt-5.6-luna:responses",
    ]);
  });

  it("excludes unhealthy, untrusted and context-ineligible Profiles", () => {
    const selected = getEligibleLunaJudgeProfiles({
      profiles: [
        profile("open", { health: "open" }),
        profile("untrusted", { usageTrusted: false }),
        profile("unverified", { contextCapabilityStatus: "unverified_long_context" }),
        profile("healthy"),
      ],
      requiredContextTokens: 66_000,
    });
    expect(selected.map((item) => item.executionProfileId)).toEqual(["healthy"]);
  });
});
