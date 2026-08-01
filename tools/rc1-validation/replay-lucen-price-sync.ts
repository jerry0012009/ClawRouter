#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import type { AcuJudgeResult } from "../../src/acu/types.js";
import { readProviderEconomicsCatalog } from "../../src/alpha/provider-economics.js";
import { routeWithCurrentAcuFormula, type AlphaExecutionProfile } from "../../src/alpha/routing.js";
import { economicsForExecutionProfile } from "../../src/alpha/server.js";

type Replay = {
  segmentId: string;
  inputTokens: number;
  expectedOutputTokens: number;
  baseQualityTarget: number;
  judgeCost: number;
  judge: AcuJudgeResult;
};

const replays: Replay[] = [
  {
    segmentId: "seg_8c6d8602e1e24e47b09100facb2a4361",
    inputTokens: 437,
    expectedOutputTokens: 800,
    baseQualityTarget: 88,
    judgeCost: 0.0011169,
    judge: {
      pLow: 0.02, pMid: 0.2, pMidHigh: 0.7, pHigh: 0.08,
      confidence: 0.86, difficultyScoreRaw: 64.8, difficultyIndex: 59.3,
      difficultyScore: 59.3, difficultyMethodVersion: "acu-difficulty-index-v1",
      factors: { reasoningDepth: 5.8, taskScope: 6.6, constraintDensity: 4.9,
        toolDependency: 6.7, verificationBurden: 5.8, contextBurden: 4.1 },
      factorComposite: 58, signals: [], explanation: "Production replay",
    },
  },
  {
    segmentId: "seg_3447e5ac24664a479af2b5233279635f",
    inputTokens: 1_197,
    expectedOutputTokens: 800,
    baseQualityTarget: 80,
    judgeCost: 0.0011398,
    judge: {
      pLow: 0.01, pMid: 0.08, pMidHigh: 0.69, pHigh: 0.22,
      confidence: 0.86, difficultyScoreRaw: 73.4, difficultyIndex: 68.3,
      difficultyScore: 68.3, difficultyMethodVersion: "acu-difficulty-index-v1",
      factors: { reasoningDepth: 6.1, taskScope: 7.2, constraintDensity: 4.8,
        toolDependency: 8.6, verificationBurden: 7.1, contextBurden: 5.9 },
      factorComposite: 67, signals: [], explanation: "Production replay",
    },
  },
  {
    segmentId: "seg_f49ce6d1e57e49a69867f73649dec532",
    inputTokens: 1_484,
    expectedOutputTokens: 800,
    baseQualityTarget: 80,
    judgeCost: 0.0011603,
    judge: {
      pLow: 0.01, pMid: 0.12, pMidHigh: 0.7, pHigh: 0.17,
      confidence: 0.86, difficultyScoreRaw: 69.4, difficultyIndex: 65.4,
      difficultyScore: 65.4, difficultyMethodVersion: "acu-difficulty-index-v1",
      factors: { reasoningDepth: 5.8, taskScope: 7.1, constraintDensity: 5.2,
        toolDependency: 8.4, verificationBurden: 6.7, contextBurden: 4.6 },
      factorComposite: 64.4, signals: [], explanation: "Production replay",
    },
  },
];

const configured = JSON.parse(await readFile("deploy/alpha/execution-profiles.json", "utf8")) as Array<
  AlphaExecutionProfile & { economicsProviderId?: string; apiKeyEnv: string; observedBillingMultiplier?: number }
>;
const economics = await readProviderEconomicsCatalog("deploy/alpha/provider-economics.json");
const excludedAtSnapshot = new Set([
  // This reference-price Profile was channel half-open in all three persisted Route Decisions.
  "lucen-cx006-plus:gpt-5.6-sol:responses",
  // The dedicated 0.08x channel was in channel cooldown in the same snapshots.
  "lucen-cx008-plus-dedicated:gpt-5.6-sol:responses",
]);
const profiles = configured.filter((profile) => !excludedAtSnapshot.has(profile.executionProfileId)).map((profile) => {
  const provider = economics.providers.find((item) => item.providerId === (profile.economicsProviderId ?? profile.provider));
  if (!provider) throw new Error(`Missing economics for ${profile.executionProfileId}`);
  return { ...profile, economics: economicsForExecutionProfile(provider, profile) };
});

for (const replay of replays) {
  const route = routeWithCurrentAcuFormula({
    judge: replay.judge,
    judgeCost: replay.judgeCost,
    inputTokens: replay.inputTokens,
    expectedOutputTokens: replay.expectedOutputTokens,
    effectiveQualityTarget: replay.baseQualityTarget,
    routingPreference: "economy",
    profiles,
    requirements: {
      protocol: "responses",
      requireTools: true,
      requiredToolTypes: ["function"],
      requireThinking: false,
      contextTokens: replay.inputTokens + replay.expectedOutputTokens + 256,
    },
  });
  const candidates = route.candidateEstimates
    .filter((candidate) => candidate.modelId === "glm-5.2" || candidate.modelId === "gpt-5.6-sol")
    .map((candidate) => ({
      segmentId: replay.segmentId,
      difficulty: replay.judge.difficultyIndex,
      modelId: candidate.modelId,
      predictedScore: candidate.predictedScore,
      conservativeScore: candidate.conservativeScore,
      estimatedCallCost: candidate.estimatedCallCost,
      expectedFallbackCost: candidate.expectedFallbackCost,
      riskAdjustedCost: candidate.riskAdjustedCost,
      paretoEfficient: candidate.paretoEfficient,
      valueUtility: candidate.valueUtility,
      selected: route.selectedProfile.modelId === candidate.modelId,
      bestExecutionProfileId: candidate.bestExecutionProfileId,
    }));
  console.log(JSON.stringify(candidates));
}
