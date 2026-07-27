import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcuJudgeClient,
  buildModelCurve,
  continuousTierProbabilities,
  difficultyScore,
  estimatedQuality,
  getAcuCatalog,
  normalizeProbabilities,
  parseJudgeResult,
  recommendModel,
  solveAbilityParameter,
  tierSufficiency,
} from "../src/acu/index.js";
import { readAcuRuntimeConfig } from "../src/acu/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("Phase 2A constrained tier model", () => {
  it("normalizes Judge probabilities and computes the documented difficulty", () => {
    const probabilities = normalizeProbabilities({
      pLow: 0.8,
      pMid: 0.4,
      pMidHigh: 0.4,
      pHigh: 0,
      confidence: 0.8,
    });
    expect(probabilities).toEqual({
      pLow: 0.5,
      pMid: 0.25,
      pMidHigh: 0.25,
      pHigh: 0,
      confidence: 0.8,
    });
    expect(difficultyScore(probabilities)).toBeCloseTo(25, 12);
  });

  it("rejects malformed strict Judge JSON", () => {
    expect(() => parseJudgeResult(JSON.stringify({
      p_low: 0.4,
      p_mid: 0.3,
      p_mid_high: 0.2,
      p_high: 0.1,
      confidence: 0.8,
      signals: ["one", "two", "three", "four", "five", "six"],
      explanation: "too many signals",
    }))).toThrow(/signals/);
    expect(() => parseJudgeResult("not-json")).toThrow(/JSON object/);
  });

  it("solves the aggregate anchor and preserves tier monotonicity", () => {
    const distribution = {
      pLow: 689 / 970,
      pMid: 62 / 970,
      pMidHigh: 49 / 970,
      pHigh: 170 / 970,
      confidence: 1,
    };
    const solved = solveAbilityParameter(0.75, distribution);
    const values = tierSufficiency(solved.abilityParameter);
    const aggregate = estimatedQuality(distribution, values);
    expect(aggregate).toBeCloseTo(0.75, 10);
    expect(Math.abs(solved.fittingError)).toBeLessThan(1e-10);
    expect(values.sufficientLow).toBeGreaterThanOrEqual(values.sufficientMid);
    expect(values.sufficientMid).toBeGreaterThanOrEqual(values.sufficientMidHigh);
    expect(values.sufficientMidHigh).toBeGreaterThanOrEqual(values.sufficientHigh);
  });

  it("produces legal ordered probabilities and monotone model curves", () => {
    let previousHigh = 0;
    for (let index = 0; index <= 100; index += 1) {
      const probabilities = continuousTierProbabilities(index / 100);
      const values = [
        probabilities.pLow,
        probabilities.pMid,
        probabilities.pMidHigh,
        probabilities.pHigh,
      ];
      expect(values.every((value) => value >= 0 && value <= 1)).toBe(true);
      expect(values.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
      expect(probabilities.pHigh).toBeGreaterThanOrEqual(previousHigh);
      previousHigh = probabilities.pHigh;
    }
    for (const model of getAcuCatalog().models) {
      const curve = buildModelCurve(model);
      expect(curve).toHaveLength(101);
      for (let index = 1; index < curve.length; index += 1) {
        expect(curve[index].estimatedQuality)
          .toBeLessThanOrEqual(curve[index - 1].estimatedQuality + 1e-12);
      }
    }
  });

  it("uses all four Judge probabilities rather than the scalar difficulty", () => {
    const model = getAcuCatalog().models[0];
    const quality = estimatedQuality({
      pLow: 0.1,
      pMid: 0.2,
      pMidHigh: 0.3,
      pHigh: 0.4,
      confidence: 0.7,
    }, model);
    expect(quality).toBeCloseTo(
      0.1 * model.sufficientLow
      + 0.2 * model.sufficientMid
      + 0.3 * model.sufficientMidHigh
      + 0.4 * model.sufficientHigh,
      12,
    );
  });

  it("selects the cheapest qualifying model and falls back to highest quality", () => {
    const easy = {
      pLow: 1,
      pMid: 0,
      pMidHigh: 0,
      pHigh: 0,
      confidence: 0.9,
    };
    const economical = recommendModel({
      probabilities: easy,
      inputTokens: 1_000,
      expectedOutputTokens: 500,
      judgeCost: 0.001,
      qualityTarget: 0.65,
    });
    const qualified = economical.estimates.filter((item) => item.meetsQualityTarget);
    expect(economical.recommended.expectedTotalCost)
      .toBe(Math.min(...qualified.map((item) => item.expectedTotalCost)));
    expect(economical.recommended.qualityLower).toBeGreaterThanOrEqual(0);
    expect(economical.recommended.qualityUpper).toBeLessThanOrEqual(1);
    expect(economical.recommended.expectedTotalCost).toBeGreaterThan(0.001);

    const impossible = recommendModel({
      probabilities: easy,
      inputTokens: 1_000,
      expectedOutputTokens: 500,
      judgeCost: 0,
      qualityTarget: 1,
    });
    expect(impossible.recommended.estimatedQuality)
      .toBe(Math.max(...impossible.estimates.map((item) => item.estimatedQuality)));
    expect(impossible.flagshipAlternative.savingsVsFlagship).toBeCloseTo(0, 12);
    expect(impossible.reason).toMatch(/没有候选/);
  });

  it("never exposes the non-callable MiniMax evidence row as a route", () => {
    const minimax = getAcuCatalog().models.find((model) => model.modelId === "minimax-m3");
    expect(minimax).toMatchObject({
      routingEligible: false,
      availability: "benchmark_only_not_configured",
    });
    const decision = recommendModel({
      probabilities: { pLow: 1, pMid: 0, pMidHigh: 0, pHigh: 0, confidence: 1 },
      inputTokens: 100,
      expectedOutputTokens: 100,
      judgeCost: 0,
    });
    expect(decision.estimates.some((item) => item.modelId === "minimax-m3")).toBe(false);
  });
});

describe("Phase 2A Judge transport", () => {
  it("sends a non-thinking JSON-only request and reuses the hash cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acu-judge-test-"));
    temporaryDirectories.push(directory);
    const cachePath = join(directory, "cache.json");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        p_low: 0.1,
        p_mid: 0.2,
        p_mid_high: 0.6,
        p_high: 0.1,
        confidence: 0.82,
        signals: ["tool_state", "multi_step"],
        explanation: "需整合工具状态并继续多步执行。",
      }) } }],
      usage: { prompt_tokens: 1_000, completion_tokens: 90 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const config = readAcuRuntimeConfig({ enabled: true, apiKey: "secret", cachePath });
    const client = new AcuJudgeClient(config, fetchMock);
    const messages = [{ role: "user", content: "Inspect the failing tests and repair them." }];

    const first = await client.judge(messages);
    const second = await client.judge(messages);
    expect(first.status).toBe("success");
    expect(second.status).toBe("cache_hit");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      max_tokens: 300,
      stream: false,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
    });
    expect(JSON.stringify(body)).not.toContain("recommend");
    const cache = await readFile(cachePath, "utf8");
    expect(cache).not.toContain("Inspect the failing tests");
    expect(cache).not.toContain("secret");
  });
});
