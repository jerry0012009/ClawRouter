import { describe, expect, it } from "vitest";
import {
  combinedMonitorState,
  mergeSupplyInventory,
  monitorRangeSpec,
  monitorReasoningMetadata,
  monitorRoutingStatus,
} from "../src/alpha/channel-monitor.js";
import { routingCandidatesForModel, type ConfiguredExecutionProfile } from "../src/alpha/server.js";

function profile(overrides: Partial<ConfiguredExecutionProfile> = {}): ConfiguredExecutionProfile {
  return {
    executionProfileId: "lucen-cx014-pro-stable:gpt-5.6-luna:responses",
    modelId: "gpt-5.6-luna",
    provider: "lucen",
    channel: "lucen-cx014-pro-stable",
    channelId: "lucen-cx014-pro-stable",
    protocols: ["responses"],
    enabled: true,
    administratorAllowed: true,
    usageTrusted: true,
    health: "healthy",
    apiKeyEnv: "TEST_KEY",
    baseUrl: "https://example.invalid/v1",
    authMode: "bearer",
    ...overrides,
  } as ConfiguredExecutionProfile;
}

describe("Supply observability semantics", () => {
  it("publishes configured reasoning capability metadata", () => {
    expect(monitorReasoningMetadata(profile({
      supportedReasoningEfforts: ["xhigh", "high", "high"],
      reasoningControlMode: "standard_effort",
    }))).toEqual({
      supportedReasoningEfforts: ["high", "xhigh"],
      reasoningControlMode: "standard_effort",
    });
    expect(monitorReasoningMetadata(profile())).toEqual({
      supportedReasoningEfforts: [],
      reasoningControlMode: "none",
    });
  });

  it("merges discovery, preflight rejection, and active Profiles", () => {
    const profiles = [
      profile(),
      profile({
        executionProfileId: "lucen-cx025-pro-premium:gpt-5.6-luna:responses",
        channel: "lucen-cx025-pro-premium",
        channelId: "lucen-cx025-pro-premium",
      }),
    ];
    const channels = [
      "lucen-cx004-low-dedicated",
      "lucen-cx014-pro-stable",
      "lucen-cx025-pro-premium",
    ].map((channelId) => ({
      channelId,
      providerId: "lucen",
      status: "success",
      httpStatus: 200,
      exactCanonicalMatches: ["gpt-5.6-luna"],
      responsesCandidates: ["gpt-5.6-luna"],
      messagesCandidates: [],
    }));
    const observations = [
      {
        channelId: "lucen-cx004-low-dedicated",
        model: "gpt-5.6-luna",
        executionProfileId: "lucen-cx004-low-dedicated:gpt-5.6-luna:responses",
        status: "failed",
        errorClass: "provider_http_503",
      },
      {
        channelId: "lucen-cx014-pro-stable",
        model: "gpt-5.6-luna",
        executionProfileId: profiles[0].executionProfileId,
        status: "passed",
        activated: true,
      },
      {
        channelId: "lucen-cx025-pro-premium",
        model: "gpt-5.6-luna",
        executionProfileId: profiles[1].executionProfileId,
        status: "passed",
        activated: true,
      },
    ];
    const inventory = mergeSupplyInventory(channels, profiles, observations);
    expect(inventory.find((row) => row.channelId === "lucen-cx014-pro-stable")).toMatchObject({
      verificationState: "routing_active",
      routingActive: true,
      protocolVerified: true,
    });
    expect(inventory.find((row) => row.channelId === "lucen-cx025-pro-premium")).toMatchObject({
      verificationState: "routing_active",
      routingActive: true,
      protocolVerified: true,
    });
    expect(inventory.find((row) => row.channelId === "lucen-cx004-low-dedicated")).toMatchObject({
      verificationState: "rejected_http_503",
      routingActive: false,
      rejectionReason: "rejected_http_503",
    });
  });

  it("does not present Profile or Channel half-open state as generally eligible", () => {
    const candidate = profile();
    expect(
      monitorRoutingStatus(
        candidate,
        { circuit_state: "healthy" },
        { circuit_state: "half_open", usage_trusted: true },
      ),
    ).toBe("half_open_probe_only");
    expect(
      combinedMonitorState(candidate, { circuit_state: "healthy" }, { circuit_state: "half_open" }),
    ).toBe("half_open");
    expect(
      monitorRoutingStatus(
        candidate,
        { circuit_state: "open" },
        { circuit_state: "healthy", usage_trusted: true },
      ),
    ).toBe("cooldown");
    expect(
      monitorRoutingStatus(
        candidate,
        { circuit_state: "healthy" },
        { circuit_state: "healthy", usage_trusted: false },
      ),
    ).toBe("usage_untrusted");
  });

  it("uses bounded aggregation buckets for every supported range", () => {
    expect(monitorRangeSpec("1h")).toEqual({ interval: "1 hour", bucket: "1 minute" });
    expect(monitorRangeSpec("6h")).toEqual({ interval: "6 hours", bucket: "5 minutes" });
    expect(monitorRangeSpec("24h")).toEqual({ interval: "24 hours", bucket: "15 minutes" });
    expect(monitorRangeSpec("7d")).toEqual({ interval: "7 days", bucket: "1 hour" });
  });

  it("publishes presets only when an administrator-enabled Profile supports their effort", () => {
    const incompatible = profile({
      reasoningOverride: { rejectedEfforts: ["max"] },
      health: "cooldown",
    });
    expect(routingCandidatesForModel("gpt-5.6-luna", [incompatible])
      .map((candidate) => candidate.candidateId)).toEqual(["gpt-5.6-luna"]);

    const compatible = profile({
      executionProfileId: "compatible:gpt-5.6-luna:responses",
      supportedReasoningEfforts: ["max"],
      health: "open",
    });
    expect(routingCandidatesForModel("gpt-5.6-luna", [incompatible, compatible])
      .map((candidate) => candidate.candidateId))
      .toEqual(["gpt-5.6-luna", "gpt-5.6-luna@max"]);
    expect(routingCandidatesForModel("gpt-5.6-luna", [compatible])
      .map((candidate) => candidate.candidateId)).toContain("gpt-5.6-luna@max");
  });
});
