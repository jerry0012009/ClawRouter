import { describe, expect, it } from "vitest";
import {
  combinedMonitorState,
  mergeSupplyInventory,
  monitorRangeSpec,
  monitorProbeMode,
  monitorReasoningMetadata,
  monitorRoutingStatus,
  normalizeMonitorQuery,
  scoreMonitorProfiles,
} from "../src/alpha/channel-monitor.js";
import { routingCandidatesForModel, type ConfiguredExecutionProfile } from "../src/alpha/server.js";
import { DEFAULT_ROUTING_UTILITY_POLICY } from "../src/alpha/routing-utility-v2.js";

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

  it("defaults Monitor scoring to balanced and standard", () => {
    expect(normalizeMonitorQuery({})).toEqual({ range: "24h", supplyStrategy: "balanced", scenario: "standard" });
    expect(normalizeMonitorQuery({ range: "7d", supplyStrategy: "lowest_cost", scenario: "long" }))
      .toEqual({ range: "7d", supplyStrategy: "lowest_cost", scenario: "long" });
  });

  it("classifies only explicit full-pool metadata as full-pool Probe evidence", () => {
    expect(monitorProbeMode({ probeMode: "full_pool", trigger: "scheduled_activity" })).toBe("full_pool");
    expect(monitorProbeMode({ trigger: "recovery_queue" })).toBe("recovery");
    expect(monitorProbeMode(null)).toBe("recovery");
  });

  it("returns production Profile V2 ranks, contributions, metrics, and scenario costs", () => {
    const cheap = profile({ executionProfileId: "cheap:gpt-5.6-luna:responses", billingPrice: { inputPricePerMillion: 1, outputPricePerMillion: 2 } });
    const fast = profile({ executionProfileId: "fast:gpt-5.6-luna:responses", billingPrice: { inputPricePerMillion: 3, outputPricePerMillion: 6 } });
    const aggregates = new Map([
      [cheap.executionProfileId, { requestCount: 20, successCount: 19, firstEventSampleCount: 20, firstEventP50Ms: 900 }],
      [fast.executionProfileId, { requestCount: 10, successCount: 10, firstEventSampleCount: 10, firstEventP50Ms: 100 }],
    ]);
    const balanced = scoreMonitorProfiles([cheap, fast], aggregates, { supplyStrategy: "balanced", scenario: "standard" });
    const lowLatency = scoreMonitorProfiles([cheap, fast], aggregates, { supplyStrategy: "low_latency", scenario: "standard" });
    const long = scoreMonitorProfiles([cheap, fast], aggregates, { supplyStrategy: "balanced", scenario: "long" });

    expect(balanced.size).toBe(2);
    expect(balanced.get(cheap.executionProfileId)).toMatchObject({ formulaVersion: "acu-profile-utility-v2.1", metricSource: "first_event_p50" });
    expect(lowLatency.get(fast.executionProfileId)?.rank).toBe(1);
    expect(balanced.get(cheap.executionProfileId)?.costContribution).toBeGreaterThan(0);
    expect(long.get(cheap.executionProfileId)?.profileCost).toBeGreaterThan(balanced.get(cheap.executionProfileId)?.profileCost ?? 0);
  });

  it("scores Profiles only against the same model and protocol", () => {
    const responses = profile({ executionProfileId: "responses:gpt-5.6-luna:responses", protocols: ["responses"] });
    const messages = profile({ executionProfileId: "messages:gpt-5.6-luna:messages", protocols: ["messages"] });
    const scores = scoreMonitorProfiles(
      [responses, messages], new Map(), { supplyStrategy: "balanced", scenario: "standard" },
    );
    expect(scores.get(responses.executionProfileId)?.rank).toBe(1);
    expect(scores.get(messages.executionProfileId)?.rank).toBe(1);
  });

  it("uses the supplied production Utility policy", () => {
    const candidate = profile();
    const aggregates = new Map([[candidate.executionProfileId, {
      requestCount: 20, successCount: 19, firstEventSampleCount: 20, firstEventP50Ms: 250,
    }]]);
    const scores = scoreMonitorProfiles(
      [candidate], aggregates, { supplyStrategy: "balanced", scenario: "standard" },
      { ...DEFAULT_ROUTING_UTILITY_POLICY,
        latency: { ...DEFAULT_ROUTING_UTILITY_POLICY.latency, minimumSamples: 50 } },
    );
    expect(scores.get(candidate.executionProfileId)?.metricSource).toBe("all_unknown");
  });

  it("uses current-range Probe evidence when production samples are absent", () => {
    const candidate = profile({ executionProfileId: "probe:gpt-5.6-luna:responses" });
    const scores = scoreMonitorProfiles([candidate], new Map([[candidate.executionProfileId, {
      requestCount: 0,
      successCount: 0,
      firstEventSampleCount: 0,
      probeCount: 10,
      probeSuccessCount: 10,
      probeLatencyP50Ms: 420,
    }]]), { supplyStrategy: "balanced", scenario: "standard" });
    expect(scores.get(candidate.executionProfileId)).toMatchObject({
      metricSource: "total_latency_p50",
      profileLatencyMs: 420,
    });
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
    expect(routingCandidatesForModel("gpt-5.6-luna", [compatible])[0]).toMatchObject({
      protocols: ["responses"], responsesProfileCount: 1, messagesProfileCount: 0,
    });
    const messages = profile({ executionProfileId: "compatible:gpt-5.6-luna:messages",
      protocols: ["messages"], supportedReasoningEfforts: ["max"] });
    expect(routingCandidatesForModel("gpt-5.6-luna", [compatible, messages])[0]).toMatchObject({
      protocols: ["responses", "messages"], responsesProfileCount: 1, messagesProfileCount: 1,
    });
    expect(routingCandidatesForModel("gpt-5.6-luna", [compatible, messages])
      .find((candidate) => candidate.candidateId === "gpt-5.6-luna@max")).toMatchObject({
        responsesProfileCount: 1, messagesProfileCount: 1,
      });
  });
});
