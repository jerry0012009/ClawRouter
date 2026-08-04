import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyLogitShift,
  AcuJudgeClient,
  computeDifficultyIndex,
  buildModelCurve,
  continuousTierProbabilities,
  difficultyScore,
  estimatedQuality,
  getAcuCatalog,
  hasSevereTierConflict,
  interpolateModelCurve,
  normalizeProbabilities,
  normalizeBenefitUtilities,
  piecewiseLinearSatisfaction,
  parseJudgeResult,
  buildJudgeSystemPrompt,
  recommendModel,
  serializeVisibleContext,
  selectValueRoute,
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
  it("interpolates absolute quality satisfaction with validated diminishing slopes", () => {
    const anchors = [
      { quality: 0, satisfaction: 0 },
      { quality: 0.5, satisfaction: 0.65 },
      { quality: 0.8, satisfaction: 0.9 },
      { quality: 0.95, satisfaction: 0.985 },
      { quality: 1, satisfaction: 1 },
    ] as const;
    for (const anchor of anchors) {
      expect(piecewiseLinearSatisfaction(anchor.quality, anchors)).toBeCloseTo(anchor.satisfaction, 12);
    }
    expect(piecewiseLinearSatisfaction(0.25, anchors)).toBeCloseTo(0.325, 12);
    expect(piecewiseLinearSatisfaction(0.65, anchors)).toBeCloseTo(0.775, 12);
    expect(piecewiseLinearSatisfaction(-1, anchors)).toBe(0);
    expect(piecewiseLinearSatisfaction(2, anchors)).toBe(1);
    expect(piecewiseLinearSatisfaction(Number.NEGATIVE_INFINITY, anchors)).toBe(0);
    expect(piecewiseLinearSatisfaction(Number.POSITIVE_INFINITY, anchors)).toBe(1);
    expect(piecewiseLinearSatisfaction(Number.NaN, anchors)).toBe(0);

    const slopes = anchors.slice(1).map((right, index) => {
      const left = anchors[index];
      return (right.satisfaction - left.satisfaction) / (right.quality - left.quality);
    });
    expect(slopes).toEqual([
      1.3,
      expect.closeTo(5 / 6, 12),
      expect.closeTo(17 / 30, 12),
      expect.closeTo(0.3, 12),
    ]);
    expect(slopes.every((slope, index) => index === 0 || slope < slopes[index - 1])).toBe(true);
  });

  it("rejects malformed quality satisfaction anchors", () => {
    expect(() => piecewiseLinearSatisfaction(0.5, [{ quality: 0, satisfaction: 0 }])).toThrow(
      "at least two",
    );
    expect(() => piecewiseLinearSatisfaction(0.5, [
      { quality: 0, satisfaction: 0 },
      { quality: 0, satisfaction: 1 },
      { quality: 1, satisfaction: 1 },
    ])).toThrow("strictly increasing");
    expect(() => piecewiseLinearSatisfaction(0.5, [
      { quality: 0, satisfaction: 0.5 },
      { quality: 0.5, satisfaction: 0.4 },
      { quality: 1, satisfaction: 1 },
    ])).toThrow("non-decreasing");
    expect(() => piecewiseLinearSatisfaction(0.5, [
      { quality: 0.1, satisfaction: 0 },
      { quality: 1, satisfaction: 1 },
    ])).toThrow("cover quality 0 through 1");
    expect(() => piecewiseLinearSatisfaction(0.5, [
      { quality: 0, satisfaction: 0 },
      { quality: 1, satisfaction: Number.POSITIVE_INFINITY },
    ])).toThrow("finite values");
  });

  it("soft-normalizes benefit utilities without amplifying noise or invalid values", () => {
    expect(normalizeBenefitUtilities([0.7], 0.2)).toEqual([0.5]);
    expect(normalizeBenefitUtilities([0.7, 0.7], 0.2)).toEqual([0.5, 0.5]);
    expect(normalizeBenefitUtilities([0.2, 0.6, 1], 0.2)[1]).toBeCloseTo(0.5, 12);
    expect(normalizeBenefitUtilities([0.7, 0.75], 0.2)[0]).toBe(0);
    expect(normalizeBenefitUtilities([0.7, 0.75], 0.2)[1]).toBeCloseTo(0.25, 12);
    expect(normalizeBenefitUtilities([0.7, Number.NaN, 0.9], 0.2)).toEqual([0, 0, 1]);
    expect(normalizeBenefitUtilities([Number.NaN, Number.POSITIVE_INFINITY], 0.2)).toEqual([0, 0]);
  });

  it("applies a bounded logit shift with diminishing gains near saturation", () => {
    expect(applyLogitShift(0.42, 0)).toBeCloseTo(0.42, 15);
    expect(applyLogitShift(0.42, 0.22)).toBeGreaterThan(0.42);
    expect(applyLogitShift(-1, 0.22)).toBe(0);
    expect(applyLogitShift(2, 0.22)).toBe(1);

    const middleGain = applyLogitShift(0.5, 0.22) - 0.5;
    const saturatedGain = applyLogitShift(0.95, 0.22) - 0.95;
    expect(middleGain).toBeGreaterThan(saturatedGain);
    expect(applyLogitShift(0.99, 0.22) - 0.99).toBeLessThan(saturatedGain);
  });

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
      difficulty_score_raw: 40,
      factors: { reasoning_depth: 4.1, task_scope: 3.8, constraint_density: 4.2, tool_dependency: 3.5, verification_burden: 4.0, context_burden: 3.7 },
      p_low: 0.4,
      p_mid: 0.3,
      p_mid_high: 0.2,
      p_high: 0.1,
      confidence: 0.8,
      signals: ["valid", 42],
      explanation: "non-string signal",
      webIntent: "not_required",
      webIntentConfidence: 0.9,
      webIntentReason: "No web evidence is needed.",
      webIntentEvidence: [],
    }))).toThrow(/signals/);
    expect(() => parseJudgeResult("not-json")).toThrow(/JSON object/);
  });

  it("computes the deterministic v1 difficulty index without noise", () => {
    const factors = {
      reasoningDepth: 2.8, taskScope: 2.1, constraintDensity: 3.4,
      toolDependency: 0, verificationBurden: 2.6, contextBurden: 1.3,
    };
    const first = computeDifficultyIndex(25, factors);
    const second = computeDifficultyIndex(25, factors);
    expect(first).toEqual({ factorComposite: 20.5, difficultyIndex: 21.4 });
    expect(second).toEqual(first);
    expect(computeDifficultyIndex.toString()).not.toContain("Math.random");
  });

  it("freezes six continuous-factor few-shots in the v4 prompt", () => {
    const prompt = buildJudgeSystemPrompt();
    expect(prompt).toContain("ACU");
    expect(prompt).toContain("difficulty_score_raw");
    expect(prompt).toContain("reasoning_depth");
    expect(prompt).toContain("不要为了简洁默认使用5的倍数");
    expect((prompt.match(/期望输出：/g) || [])).toHaveLength(6);
  });

  it("retries only when index, raw score, or dominant probability span at least two tiers", () => {
    const base = {
      difficultyScoreRaw: 25, factors: { reasoningDepth: 2.8, taskScope: 2.1, constraintDensity: 3.4, toolDependency: 0, verificationBurden: 2.6, contextBurden: 1.3 },
      factorComposite: 20.5, difficultyIndex: 25.8, difficultyMethodVersion: "acu-difficulty-index-v1" as const,
      difficultyScore: 25.8, pLow: 0.76, pMid: 0.22, pMidHigh: 0.02, pHigh: 0, confidence: 0.87, signals: [], explanation: "",
    };
    expect(hasSevereTierConflict(base)).toBe(false);
    expect(hasSevereTierConflict({ ...base, difficultyScoreRaw: 85 })).toBe(true);
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

  it("uses the identical interpolated curve point for recommendation scores", () => {
    const difficulty = 47.35;
    const recommendation = recommendModel({
      probabilities: { pLow: 0.1, pMid: 0.6, pMidHigh: 0.25, pHigh: 0.05, confidence: 0.8 },
      difficultyScore: difficulty,
      inputTokens: 500,
      expectedOutputTokens: 300,
      judgeCost: 0,
    });
    for (const estimate of recommendation.estimates.filter((item) => !item.executionPresetId)) {
      const model = getAcuCatalog().models.find((item) => item.modelId === estimate.modelId)!;
      expect(estimate.predictedScore).toBeCloseTo(interpolateModelCurve(model, difficulty).estimatedQuality * 100, 12);
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

  it("selects the highest continuous value utility on the score-cost frontier", () => {
    const easy = {
      pLow: 1,
      pMid: 0,
      pMidHigh: 0,
      pHigh: 0,
      confidence: 0.9,
    };
    const economical = recommendModel({
      probabilities: easy,
      difficultyScore: 12.5,
      inputTokens: 1_000,
      expectedOutputTokens: 500,
      judgeCost: 0.001,
      qualityTarget: 0.65,
    });
    expect(economical.recommended.paretoEfficient).toBe(true);
    expect(economical.recommended.predictedScore).toBeGreaterThanOrEqual(65);
    expect(economical.recommended.qualityLower).toBeGreaterThanOrEqual(0);
    expect(economical.recommended.qualityUpper).toBeLessThanOrEqual(1);
    expect(economical.recommended.expectedTotalCost).toBeGreaterThan(0.001);

    const impossible = recommendModel({
      probabilities: { pLow: 0, pMid: 0, pMidHigh: 0, pHigh: 1, confidence: 1 },
      difficultyScore: 96,
      inputTokens: 1_000,
      expectedOutputTokens: 500,
      judgeCost: 0,
      qualityTarget: 1,
    });
    expect(impossible.recommended.paretoEfficient).toBe(true);
    expect(impossible.recommended.valueUtility)
      .toBe(Math.max(...impossible.estimates.map((item) => item.valueUtility)));
    expect(impossible.flagshipAlternative.savingsVsFlagship).toBeCloseTo(0, 12);
    expect(impossible.reason).toMatch(/风险调整得分/);
  });

  it("integrates a small score difference and an 80% cost reduction continuously", () => {
    const result = selectValueRoute([
      { modelId: "a", displayName: "A", predictedScore: 87.8, riskAdjustedCost: 0.05 },
      { modelId: "b", displayName: "B", predictedScore: 87.7, riskAdjustedCost: 0.01 },
    ], 80);
    expect(result.selected.modelId).toBe("b");
    expect(result.reason).toContain("对数成本效用");
    expect(result.reason).toContain("降低80%");
  });

  it("keeps every Phase 2B profile and final tier sufficiency within constraints", () => {
    const defaults = getAcuCatalog().models.filter((model) => model.defaultDisplay);
    expect(defaults).toHaveLength(8);
    for (const model of getAcuCatalog().models) {
      expect(model.curveTemperature).toBeGreaterThanOrEqual(0.09);
      expect(model.curveTemperature).toBeLessThanOrEqual(0.17);
      expect(Math.max(...Object.values(model.tierAdjustments).map((value) => Math.abs(value)))).toBeLessThanOrEqual(0.08);
      expect(model.sufficientLow).toBeGreaterThanOrEqual(model.sufficientMid);
      expect(model.sufficientMid).toBeGreaterThanOrEqual(model.sufficientMidHigh);
      expect(model.sufficientMidHigh).toBeGreaterThanOrEqual(model.sufficientHigh);
    }
  });

  it("never exposes the non-callable MiniMax evidence row as a route", () => {
    const minimax = getAcuCatalog().models.find((model) => model.modelId === "minimax-m3");
    expect(minimax).toMatchObject({
      routingEligible: false,
      availability: "benchmark_only_not_configured",
    });
    const decision = recommendModel({
      probabilities: { pLow: 1, pMid: 0, pMidHigh: 0, pHigh: 0, confidence: 1 },
      difficultyScore: 5,
      inputTokens: 100,
      expectedOutputTokens: 100,
      judgeCost: 0,
    });
    expect(decision.estimates.some((item) => item.modelId === "minimax-m3")).toBe(false);
  });
});

describe("Phase 2A Judge transport", () => {
  it("rejects injected Judge providers outside tests unless explicitly allowed", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const config = readAcuRuntimeConfig({ enabled: true, apiKey: "secret", allowMock: false });
      expect(() => new AcuJudgeClient(config, vi.fn<typeof fetch>())).toThrow(/Mock ACU Judge providers are forbidden/);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it("sends a non-thinking JSON-only request and reuses the hash cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acu-judge-test-"));
    temporaryDirectories.push(directory);
    const legacyCachePath = join(directory, "acu-judge-cache-v2.json");
    const cachePath = join(directory, "acu-judge-cache-v4.json");
    const legacyContents = '{"schemaVersion":"acu-judge-cache-v2","entries":{"audit":"preserved"}}\n';
    await writeFile(legacyCachePath, legacyContents);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        difficulty_score_raw: 68.4,
        factors: { reasoning_depth: 6.8, task_scope: 6.2, constraint_density: 6.5, tool_dependency: 7.4, verification_burden: 6.9, context_burden: 5.7 },
        p_low: 0.1,
        p_mid: 0.2,
        p_mid_high: 0.6,
        p_high: 0.1,
        confidence: 0.82,
        signals: ["tool_state", "multi_step"],
        explanation: "需整合工具状态并继续多步执行。",
        webIntent: "not_required",
        webIntentConfidence: 0.96,
        webIntentReason: "The task is local code repair.",
        webIntentEvidence: ["local_or_code_context"],
      }) } }],
      usage: { prompt_tokens: 1_000, completion_tokens: 90 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const config = readAcuRuntimeConfig({ enabled: true, apiKey: "secret", cachePath: legacyCachePath });
    const client = new AcuJudgeClient(config, fetchMock);
    const messages = [{ role: "user", content: "Inspect the failing tests and repair them." }];

    const first = await client.judge(messages);
    const second = await client.judge(messages);
    expect(first.status).toBe("live");
    expect(second.status).toBe("cache_hit");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      max_tokens: 300,
      stream: false,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
    });
    expect(JSON.stringify(body)).not.toContain("recommend");
    const cache = await readFile(cachePath, "utf8");
    expect(JSON.parse(cache)).toMatchObject({ schemaVersion: "acu-judge-cache-v4" });
    expect(cache).not.toContain("Inspect the failing tests");
    expect(cache).not.toContain("secret");
    expect(await readFile(legacyCachePath, "utf8")).toBe(legacyContents);
  });

  it("omits reasoning controls for the default Sol Judge", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: "judge-max",
      model: "gpt-5.6-sol",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
        difficulty_score_raw: 20, factors: { reasoning_depth: 2, task_scope: 2, constraint_density: 2, tool_dependency: 2, verification_burden: 2, context_burden: 2 },
        p_low: 0.9, p_mid: 0.05, p_mid_high: 0.03, p_high: 0.02, confidence: 0.9, signals: [], explanation: "simple",
        webIntent: "not_required", webIntentConfidence: 0.99, webIntentReason: "simple", webIntentEvidence: [],
      }) }] }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const config = readAcuRuntimeConfig({ enabled: true, apiKey: "secret", judgeProtocol: "responses", cachePath: join(tmpdir(), `acu-judge-max-${Date.now()}.json`) });
    const client = new AcuJudgeClient(config, fetchMock);
    await client.judge([{ role: "user", content: "Reply OK" }]);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body).not.toHaveProperty("reasoning");
  });

  it("serializes tool calls, tool results, structured content, and tools deterministically", () => {
    const messages = [
      { role: "assistant", content: null, tool_calls: [{ id: "call_123", type: "function", function: { name: "run_shell", arguments: '{"command":"npm test"}' } }] },
      { role: "tool", tool_call_id: "call_123", name: "run_shell", content: "FAIL duplicate rows after retry", error: { code: "TEST_FAILURE" } },
    ];
    const tools = [{ type: "function", function: { parameters: { required: ["command"], type: "object" }, name: "run_shell" } }];
    const first = serializeVisibleContext(messages, tools);
    const second = serializeVisibleContext(messages, tools);
    expect(first).toBe(second);
    expect(first).toContain("[ASSISTANT_TOOL_CALL id=call_123]");
    expect(first).toContain('arguments={"command":"npm test"}');
    expect(first).toContain("[TOOL_RESULT id=call_123 name=run_shell]");
    expect(first).toContain("TEST_FAILURE");
  });
});
