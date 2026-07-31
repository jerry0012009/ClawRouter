import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { continuousTierProbabilities } from "../src/acu/math.js";
import { probeBackoffMinutes } from "../src/alpha/adaptive-probe.js";
import { deriveRuntimeEligibility } from "../src/alpha/channel-health.js";
import { assertSupplyProfileConservation, type ProviderModelProfileRegistry } from "../src/alpha/channel-registry.js";
import { routeWithCurrentAcuFormula, type AlphaExecutionProfile } from "../src/alpha/routing.js";

function profile(id: string, health: AlphaExecutionProfile["health"] = "healthy"): AlphaExecutionProfile {
  return {
    executionProfileId: id,
    modelId: "gpt-5.6-terra",
    providerModelId: "gpt-5.6-terra",
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
  it("keeps all five discovered cx012 Profiles classified and out of the Active Pool", async () => {
    const registry = JSON.parse(await readFile(
      new URL("../deploy/alpha/provider-model-profiles.json", import.meta.url), "utf8",
    )) as ProviderModelProfileRegistry;
    const cx012 = registry.profiles.filter((item) => item.channelId === "lucen-cx012-pro");
    expect(cx012.map((item) => item.canonicalModelId).sort()).toEqual([
      "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
    ]);
    expect(cx012.every((item) => item.status === "temporarily_unavailable"
      && item.activeInRouting === false && item.statusReason === "timeout")).toBe(true);
    expect(() => assertSupplyProfileConservation(cx012.map((item) => item.executionProfileId), cx012)).not.toThrow();
  });

  it("uses bounded retry backoff without permanently stopping", () => {
    expect([0, 1, 2, 3, 4, 20].map(probeBackoffMinutes)).toEqual([0, 5, 15, 60, 360, 360]);
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
    expect(deriveRuntimeEligibility({ enabled: true, administratorAllowed: true, ...states }).blockingScope).toBe(scope);
  });

  it("evaluates every input exactly once and keeps a model available through another channel", () => {
    const profiles = [
      profile("lucen-terra-a:gpt-5.6-terra:responses", "cooldown"),
      profile("lucen-terra-b:gpt-5.6-terra:responses"),
    ];
    const difficulty = 54;
    const route = routeWithCurrentAcuFormula({
      judge: {
        ...continuousTierProbabilities(difficulty / 100), confidence: 1,
        difficultyScoreRaw: difficulty, factorComposite: difficulty, difficultyIndex: difficulty,
        difficultyMethodVersion: "test", difficultyScore: difficulty, signals: [], explanation: "test",
        factors: { reasoningDepth: 5, taskScope: 5, constraintDensity: 5, toolDependency: 5,
          verificationBurden: 5, contextBurden: 5 },
      },
      judgeCost: 0, inputTokens: 1_000, expectedOutputTokens: 100, effectiveQualityTarget: 70,
      profiles,
      requirements: { protocol: "responses", requireTools: false, requireThinking: false, webIntent: "not_required" },
    });
    const inputIds = profiles.map((item) => item.executionProfileId).sort();
    const evaluatedIds = route.profileEvaluations.map((item) => item.executionProfileId).sort();
    expect(evaluatedIds).toEqual(inputIds);
    expect(new Set([...route.eligibleProfileIds, ...route.excludedProfiles.map((item) => item.executionProfileId)]).size)
      .toBe(inputIds.length);
    expect(route.modelAvailability).toEqual([{
      canonicalModelId: "gpt-5.6-terra", available: true, eligibleProfileCount: 1, excludedProfileCount: 1,
    }]);
  });
});
