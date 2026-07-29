import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getAcuModel } from "../src/acu/catalog.js";
import { continuousTierProbabilities } from "../src/acu/math.js";
import type { AcuJudgeResult } from "../src/acu/types.js";
import { routeWithCurrentAcuFormula, type AlphaExecutionProfile } from "../src/alpha/routing.js";

type ConfiguredProfile = AlphaExecutionProfile & {
  baseUrlEnv: string;
  apiKeyEnv: string;
  authMode: string;
};

async function profiles(): Promise<ConfiguredProfile[]> {
  const text = await readFile(new URL("../deploy/alpha/execution-profiles.json", import.meta.url), "utf8");
  return JSON.parse(text) as ConfiguredProfile[];
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
  it("contains two preflighted catalog candidates for each native protocol", async () => {
    const configured = await profiles();
    for (const protocol of ["responses", "messages"] as const) {
      const candidates = configured.filter((profile) => profile.protocols.includes(protocol));
      expect(new Set(candidates.map((profile) => profile.modelId)).size).toBe(2);
      for (const profile of candidates) {
        const catalog = getAcuModel(profile.modelId);
        expect(catalog?.routingEligible).toBe(true);
        expect(catalog?.toolCallSupport).toBe(true);
        expect(catalog?.inputPricePerMillion).toBeTypeOf("number");
        expect(catalog?.outputPricePerMillion).toBeTypeOf("number");
        expect(profile.contextWindow).toBeLessThanOrEqual(catalog?.contextWindow ?? 0);
        expect(profile.baseUrlEnv).toMatch(/^CLOSEAI_/);
        expect(profile.apiKeyEnv).toBe("CLOSEAI_API_KEY");
      }
    }
  });

  it("selects different value profiles for simple and difficult tasks without treating 88 as a hard threshold", async () => {
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
          requireThinking: false,
          contextTokens: 1_000,
        },
      })
    );

    expect(route("responses", 5, 80).selectedProfile.modelId).toBe("gpt-5.4-mini");
    expect(route("responses", 80, 80).selectedProfile.modelId).toBe("gpt-5.5");
    expect(route("messages", 5, 80).selectedProfile.modelId).toBe("claude-sonnet-5");
    expect(route("messages", 80, 80).selectedProfile.modelId).toBe("claude-opus-4-8");

    const planning = route("responses", 5, 88);
    expect(planning.selectedProfile.modelId).toBe("gpt-5.4-mini");
    expect(planning.candidateEstimates.find((item) => item.modelId === "gpt-5.4-mini")?.meetsQualityTarget)
      .toBe(false);
  });
});
