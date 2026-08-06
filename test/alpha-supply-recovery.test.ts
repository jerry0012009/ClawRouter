import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { continuousTierProbabilities } from "../src/acu/math.js";
import {
  deriveProbeValidation,
  probeResponseMetadata,
  recoveryCooldownDue,
} from "../src/alpha/adaptive-probe.js";
import { deriveRuntimeEligibility } from "../src/alpha/channel-health.js";
import {
  assertSupplyProfileConservation,
  type ProviderModelProfileRegistry,
} from "../src/alpha/channel-registry.js";
import { routeWithCurrentAcuFormula, type AlphaExecutionProfile } from "../src/alpha/routing.js";

function profile(
  id: string,
  health: AlphaExecutionProfile["health"] = "healthy",
  modelId = "gpt-5.6-terra",
): AlphaExecutionProfile {
  return {
    executionProfileId: id,
    modelId,
    providerModelId: modelId,
    provider: "lucen",
    channel: id.split(":")[0]!,
    channelId: id.split(":")[0]!,
    protocols: ["responses"],
    toolCallSupport: true,
    supportedToolTypes: ["function"],
    thinkingSupport: true,
    supportedReasoningEfforts: ["high"],
    reasoningControlMode: "standard_effort",
    health,
    enabled: true,
    administratorAllowed: true,
    usageTrusted: true,
  };
}

describe("Supply Profile recovery", () => {
  it.each([
    [
      { responseOk: true, validStream: true, usageTrusted: true, actualModel: undefined },
      false,
      "actual_model_missing",
    ],
    [
      { responseOk: true, validStream: true, usageTrusted: true, actualModel: "other-model" },
      false,
      "actual_model_mismatch",
    ],
    [
      { responseOk: true, validStream: true, usageTrusted: false, actualModel: "gpt-5.6-terra" },
      false,
      "usage_untrusted",
    ],
    [
      { responseOk: true, validStream: true, usageTrusted: true, actualModel: "gpt-5.6-terra" },
      true,
      undefined,
    ],
  ] as const)("requires verified actual model and usage (%o)", (input, validProbe, errorCode) => {
    const result = deriveProbeValidation({ ...input, acceptedModels: new Set(["gpt-5.6-terra"]) });
    expect(result.validProbe).toBe(validProbe);
    expect(result.errorCode).toBe(errorCode);
  });

  it("prioritizes protocol validation before model and usage diagnostics", () => {
    expect(
      deriveProbeValidation({
        responseOk: true,
        validStream: false,
        usageTrusted: false,
        acceptedModels: new Set(),
      }).errorCode,
    ).toBe("protocol_incompatible");
    expect(
      deriveProbeValidation({
        responseOk: true,
        validStream: true,
        usageTrusted: true,
        acceptedModels: new Set(),
      }).errorCode,
    ).toBe("actual_model_missing");
    expect(
      deriveProbeValidation({
        responseOk: true,
        validStream: true,
        usageTrusted: false,
        actualModel: "gpt-5.6-terra",
        acceptedModels: new Set(["gpt-5.6-terra"]),
      }).errorCode,
    ).toBe("usage_untrusted");
  });

  it("records bounded, redacted diagnostics for failed probe responses", () => {
    const metadata = probeResponseMetadata(
      "messages",
      new Response("bad", { headers: { "content-type": "text/html" } }),
      Buffer.from(
        'authorization: Bearer secret\nx-api-key=secret2\ncookie: session=secret3\nevent: message_start\ndata: {"type":"message_start"}',
      ),
      undefined,
      false,
      "protocol_incompatible",
    );
    expect(String(metadata.responsePreview)).not.toContain("secret");
    expect(metadata.responsePreview).toContain("[redacted]");
    expect(metadata.observedEventTypes).toEqual(["message_start"]);
    expect(metadata.primaryErrorCode).toBe("protocol_incompatible");
  });
  it("keeps all five discovered cx012 Profiles classified and out of the Active Pool", async () => {
    const registry = JSON.parse(
      await readFile(
        new URL("../deploy/alpha/provider-model-profiles.json", import.meta.url),
        "utf8",
      ),
    ) as ProviderModelProfileRegistry;
    const cx012 = registry.profiles.filter((item) => item.channelId === "lucen-cx012-pro");
    expect(cx012.map((item) => item.canonicalModelId).sort()).toEqual([
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    expect(
      cx012.every(
        (item) =>
          item.status === "temporarily_unavailable" &&
          item.activeInRouting === false &&
          item.statusReason === "timeout",
      ),
    ).toBe(true);
    expect(() =>
      assertSupplyProfileConservation(
        cx012.map((item) => item.executionProfileId),
        cx012,
      ),
    ).not.toThrow();
  });

  it("uses health cooldown as the only targeted recovery deadline", () => {
    const now = Date.parse("2026-08-01T00:00:00Z");
    expect(recoveryCooldownDue({ state: "open", cooldownUntil: new Date(now - 1) }, now)).toBe(
      true,
    );
    expect(recoveryCooldownDue({ state: "open", cooldownUntil: new Date(now + 1) }, now)).toBe(
      false,
    );
  });
});

describe("Runtime health and Router conservation", () => {
  it.each([
    [{ profileState: "open" }, "profile"],
    [{ channelState: "open" }, "channel"],
    [{ providerState: "blocked" }, "provider"],
    [{ profileState: "half_open" }, "profile"],
    [{ probeState: "stale" }, "probe"],
  ] as const)("preserves the blocking scope for %o", (states, scope) => {
    expect(
      deriveRuntimeEligibility({ enabled: true, administratorAllowed: true, ...states })
        .blockingScope,
    ).toBe(scope);
  });

  it("evaluates every input exactly once and keeps a model available through another channel", () => {
    const profiles = [
      profile("lucen-terra-a:gpt-5.6-terra:responses", "cooldown"),
      profile("lucen-terra-b:gpt-5.6-terra:responses"),
    ];
    const difficulty = 54;
    const route = routeWithCurrentAcuFormula({
      judge: {
        ...continuousTierProbabilities(difficulty / 100),
        confidence: 1,
        difficultyScoreRaw: difficulty,
        factorComposite: difficulty,
        difficultyIndex: difficulty,
        difficultyMethodVersion: "test",
        difficultyScore: difficulty,
        signals: [],
        explanation: "test",
        factors: {
          reasoningDepth: 5,
          taskScope: 5,
          constraintDensity: 5,
          toolDependency: 5,
          verificationBurden: 5,
          contextBurden: 5,
        },
      },
      judgeCost: 0,
      inputTokens: 1_000,
      expectedOutputTokens: 100,
      effectiveQualityTarget: 70,
      profiles,
      requirements: {
        protocol: "responses",
        requireTools: false,
        requireThinking: false,
        webIntent: "not_required",
      },
    });
    const inputIds = profiles.map((item) => item.executionProfileId).sort();
    const evaluatedIds = route.profileEvaluations.map((item) => item.executionProfileId).sort();
    expect(evaluatedIds).toEqual(inputIds);
    expect(
      new Set([
        ...route.eligibleProfileIds,
        ...route.excludedProfiles.map((item) => item.executionProfileId),
      ]).size,
    ).toBe(inputIds.length);
    expect(route.modelAvailability).toEqual([
      {
        canonicalModelId: "gpt-5.6-terra",
        available: true,
        eligibleProfileCount: 1,
        excludedProfileCount: 1,
      },
    ]);
  });

  it("keeps Terra eligible when a Sol Profile on the same Channel is open", () => {
    const profiles = [
      profile("shared-channel:gpt-5.6-sol:responses", "cooldown", "gpt-5.6-sol"),
      profile("shared-channel:gpt-5.6-terra:responses", "healthy", "gpt-5.6-terra"),
    ];
    const route = routeWithCurrentAcuFormula({
      judge: {
        ...continuousTierProbabilities(0.7),
        confidence: 1,
        difficultyScoreRaw: 70,
        factorComposite: 70,
        difficultyIndex: 70,
        difficultyMethodVersion: "test",
        difficultyScore: 70,
        signals: [],
        explanation: "test",
        factors: {
          reasoningDepth: 7,
          taskScope: 7,
          constraintDensity: 7,
          toolDependency: 7,
          verificationBurden: 7,
          contextBurden: 7,
        },
      },
      judgeCost: 0,
      inputTokens: 1_000,
      expectedOutputTokens: 100,
      effectiveQualityTarget: 70,
      profiles,
      requirements: {
        protocol: "responses",
        requireTools: false,
        requireThinking: false,
        webIntent: "not_required",
      },
    });
    expect(route.eligibleProfileIds).toContain("shared-channel:gpt-5.6-terra:responses");
    expect(route.excludedProfiles).toContainEqual({
      executionProfileId: "shared-channel:gpt-5.6-sol:responses",
      reasons: ["health_cooldown"],
    });
  });

  it("keeps Sol available while at least one compatible Sol Profile is healthy", () => {
    const profiles = [
      profile("sol-a:gpt-5.6-sol:responses", "cooldown", "gpt-5.6-sol"),
      profile("sol-b:gpt-5.6-sol:responses", "healthy", "gpt-5.6-sol"),
    ];
    const route = routeWithCurrentAcuFormula({
      judge: {
        ...continuousTierProbabilities(0.8),
        confidence: 1,
        difficultyScoreRaw: 80,
        factorComposite: 80,
        difficultyIndex: 80,
        difficultyMethodVersion: "test",
        difficultyScore: 80,
        signals: [],
        explanation: "test",
        factors: {
          reasoningDepth: 8,
          taskScope: 8,
          constraintDensity: 8,
          toolDependency: 8,
          verificationBurden: 8,
          contextBurden: 8,
        },
      },
      judgeCost: 0,
      inputTokens: 1_000,
      expectedOutputTokens: 100,
      effectiveQualityTarget: 75,
      profiles,
      requirements: {
        protocol: "responses",
        requireTools: false,
        requireThinking: false,
        webIntent: "not_required",
      },
    });
    expect(route.modelAvailability).toEqual([
      {
        canonicalModelId: "gpt-5.6-sol",
        available: true,
        eligibleProfileCount: 1,
        excludedProfileCount: 1,
      },
    ]);
  });
});
