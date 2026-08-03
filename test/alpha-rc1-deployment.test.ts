import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getAcuModel } from "../src/acu/catalog.js";
import { continuousTierProbabilities } from "../src/acu/math.js";
import type { AcuJudgeResult } from "../src/acu/types.js";
import { effectiveContextCeiling } from "../src/alpha/context-admission.js";
import { routeWithCurrentAcuFormula, type AlphaExecutionProfile } from "../src/alpha/routing.js";
import type { ProviderEconomicsCatalog } from "../src/alpha/provider-economics.js";

type ConfiguredProfile = AlphaExecutionProfile & {
  baseUrlEnv: string;
  apiKeyEnv: string;
  authMode: string;
};

async function profiles(): Promise<ConfiguredProfile[]> {
  const text = await readFile(new URL("../deploy/alpha/execution-profiles.json", import.meta.url), "utf8");
  const economics = JSON.parse(await readFile(
    new URL("../deploy/alpha/provider-economics.json", import.meta.url), "utf8",
  )) as ProviderEconomicsCatalog;
  return (JSON.parse(text) as ConfiguredProfile[]).filter((profile) => profile.autoRouteEnabled !== false).map((profile) => ({
    ...profile,
    economics: economics.providers.find((item) => item.providerId === profile.provider),
  }));
}

function judgeAt(difficulty: number): AcuJudgeResult {
  const probabilities = continuousTierProbabilities(difficulty / 100);
  return {
    ...probabilities,
    confidence: 0.9,
    difficultyScoreRaw: difficulty,
    factors: {
      reasoningDepth: difficulty / 10,
      taskScope: difficulty / 10,
      constraintDensity: difficulty / 10,
      toolDependency: difficulty / 10,
      verificationBurden: difficulty / 10,
      contextBurden: difficulty / 10,
    },
    factorComposite: difficulty,
    difficultyIndex: difficulty,
    difficultyMethodVersion: "acu-difficulty-index-v1",
    difficultyScore: difficulty,
    signals: [],
    explanation: "RC1 deterministic route boundary test",
  };
}

describe("Alpha RC1 deployment profiles", () => {
  it("contains the expanded preflighted catalog candidates for each native protocol", async () => {
    const configured = await profiles();
    expect(configured.length).toBeGreaterThanOrEqual(11);
    for (const protocol of ["responses", "messages"] as const) {
      const candidates = configured.filter((profile) => profile.protocols.includes(protocol));
      const uniqueModels = new Set(candidates.map((profile) => profile.modelId));
      expect(uniqueModels.size).toBeGreaterThanOrEqual(4);
      for (const profile of candidates) {
        const catalog = getAcuModel(profile.modelId);
        expect(catalog?.routingEligible).toBe(true);
        expect(catalog?.toolCallSupport).toBe(true);
        expect(profile.toolCallSupport).toBe(true);
        expect(profile.thinkingSupport).toBe(true);
        expect(catalog?.inputPricePerMillion).toBeTypeOf("number");
        expect(catalog?.outputPricePerMillion).toBeTypeOf("number");
        expect(catalog?.cachedInputPricePerMillion).toBeTypeOf("number");
        expect(effectiveContextCeiling(profile)).toBe(
          profile.providerHardContextCap ?? Number.MAX_SAFE_INTEGER,
        );
        expect(profile.baseUrlEnv).toMatch(/^(?:ACU_CHANNEL_)?(?:CLOSEAI|LUCEN|BLACKAI)_/);
        expect(profile.apiKeyEnv).toMatch(/^(?:ACU_CHANNEL_)?(?:CLOSEAI|LUCEN|BLACKAI).+API_KEY$/);
      }
    }
  });

  it("routes over every legal model, persists rich estimates, and does not treat 88 as a hard threshold", async () => {
    const configured = await profiles();
    const route = (protocol: "responses" | "messages", difficulty: number, target: number) => (
      routeWithCurrentAcuFormula({
        judge: judgeAt(difficulty),
        judgeCost: 0.0003,
        inputTokens: 1_000,
        expectedOutputTokens: 800,
        effectiveQualityTarget: target,
        profiles: configured,
        requirements: {
          protocol,
          requireTools: true,
          requireThinking: true,
          contextTokens: 1_000,
        },
      })
    );

    const simpleResponses = route("responses", 5, 80);
    const hardResponses = route("responses", 80, 80);
    const simpleMessages = route("messages", 5, 80);
    const hardMessages = route("messages", 80, 80);
    for (const decision of [simpleResponses, hardResponses, simpleMessages, hardMessages]) {
      expect(decision.candidateEstimates.map((item) => item.modelId))
        .toContain(decision.selectedProfile.modelId);
      expect(new Set(decision.candidateEstimates.map((item) => item.candidateId)).size)
        .toBe(decision.candidateEstimates.length);
    }
    expect(simpleResponses.candidateEstimates.length).toBeGreaterThanOrEqual(8);
    expect(simpleMessages.candidateEstimates.length).toBeGreaterThanOrEqual(8);
    expect(simpleResponses.excludedProfiles.some((item) => item.reasons.includes("native_protocol"))).toBe(true);
    const unavailableEconomicsProfiles = configured.filter((profile) => (
      profile.economics && (!profile.economics.enabled || profile.economics.health !== "healthy")
    ));
    expect(simpleResponses.excludedProfiles.filter((item) => item.reasons.includes("provider_cooldown")))
      .toHaveLength(unavailableEconomicsProfiles.length);
    for (const estimate of [...simpleResponses.candidateEstimates, ...simpleMessages.candidateEstimates]) {
      expect(estimate.predictedScore).toBeTypeOf("number");
      expect(estimate.conservativeScore).toBeTypeOf("number");
      expect(estimate.estimatedCallCost).toBeTypeOf("number");
      expect(estimate.expectedFallbackCost).toBeTypeOf("number");
      expect(estimate.expectedTotalCost).toBeTypeOf("number");
      expect(estimate.paretoEfficient).toBeTypeOf("boolean");
      expect(estimate.valueUtility).toBeTypeOf("number");
      expect(estimate.executionProfileIds.length).toBeGreaterThanOrEqual(1);
    }

    const planning = route("responses", 5, 88);
    expect(planning.candidateEstimates).toHaveLength(simpleResponses.candidateEstimates.length);
    expect(planning.candidateEstimates.map((item) => item.modelId)).toContain(planning.selectedProfile.modelId);
    expect([...planning.eligibleProfileIds].sort()).toEqual([...simpleResponses.eligibleProfileIds].sort());
  });

  it("deduplicates same-model profiles in the formula while retaining profile provenance", async () => {
    const configured = await profiles();
    const responseProfiles = configured.filter((profile) => profile.protocols.includes("responses"));
    const baseProfile = responseProfiles.find((profile) => profile.provider === "closeai")!;
    const duplicate = {
      ...baseProfile,
      executionProfileId: `${baseProfile.executionProfileId}-secondary`,
      channel: "closeai-openai-secondary",
    };
    const decision = routeWithCurrentAcuFormula({
      judge: judgeAt(5),
      judgeCost: 0.0003,
      inputTokens: 1_000,
      expectedOutputTokens: 800,
      effectiveQualityTarget: 80,
      profiles: [...responseProfiles, duplicate],
      requirements: {
        protocol: "responses",
        requireTools: true,
        requireThinking: true,
        contextTokens: 1_000,
      },
    });

    const presetCount = decision.candidateEstimates.filter((item) => item.executionPresetId).length;
    expect(decision.candidateEstimates).toHaveLength(new Set(responseProfiles.map((profile) => profile.modelId)).size + presetCount);
    const existingProfileCount = responseProfiles.filter((profile) => profile.modelId === duplicate.modelId).length;
    expect(decision.candidateEstimates.find((item) => item.modelId === duplicate.modelId)?.executionProfileIds)
      .toHaveLength(existingProfileCount + 1);
  });

  it("applies a custom user allowlist as a hard policy filter without changing the routing formula", async () => {
    const configured = await profiles();
    const decision = routeWithCurrentAcuFormula({
      judge: judgeAt(80),
      judgeCost: 0.0003,
      inputTokens: 1_000,
      expectedOutputTokens: 800,
      effectiveQualityTarget: 80,
      profiles: configured,
      requirements: {
        protocol: "responses",
        requireTools: true,
        requireThinking: true,
        contextTokens: 1_000,
        allowedModelIds: ["gpt-5.6-luna", "gpt-5.6-sol"],
      },
    });

    expect(decision.candidateEstimates.map((estimate) => estimate.candidateId).sort())
      .toEqual(["gpt-5.6-luna", "gpt-5.6-luna@max", "gpt-5.6-sol", "gpt-5.6-sol@high", "gpt-5.6-sol@xhigh"]);
    expect(decision.excludedProfiles.filter((profile) => profile.reasons.includes("model_policy")).length)
      .toBeGreaterThanOrEqual(8);
  });
});
