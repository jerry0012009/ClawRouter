import { describe, expect, it, vi } from "vitest";
import { buildJudgeSystemPrompt, parseJudgeResult } from "../src/acu/judge.js";
import type { AcuJudgeClient } from "../src/acu/judge.js";
import { readAcuRuntimeConfig } from "../src/acu/config.js";
import { createAcuJudgeRunner } from "../src/alpha/judge-runner.js";
import { classifyWebIntentFallback } from "../src/alpha/web-intent.js";

describe("Routing Segment Web Intent", () => {
  it.each([
    ["修改 currentUser 函数", "not_required"],
    ["更新 latestVersion 变量", "not_required"],
    ["在本地文件中搜索 latestVersion", "not_required"],
    ["查看今天生成的本地日志", "not_required"],
    ["查询今天 BTC 价格", "required"],
    ["搜索最新 Codex 官方文档", "required"],
  ] as const)("uses a high-precision fallback for %s", (text, expected) => {
    expect(classifyWebIntentFallback({ recentUserInputs: [text] }).intent).toBe(expected);
  });

  it("does not make isolated time words a hard Web requirement", () => {
    expect(classifyWebIntentFallback({ recentUserInputs: ["latest"] }).intent).toBe("likely");
    expect(classifyWebIntentFallback({ recentUserInputs: ["今天"] }).intent).toBe("likely");
    expect(classifyWebIntentFallback({ recentUserInputs: ["current"] }).intent).toBe("likely");
  });

  it("asks the existing Judge for Web Intent in the same output", () => {
    const prompt = buildJudgeSystemPrompt();
    expect(prompt).toContain('"webIntent":"likely"');
    expect(prompt).toContain("修改 currentUser 函数");
    expect(prompt).toContain("查询今天 BTC 价格");
    expect(prompt).toContain("客户端声明 Web Tool 只表示能力可用");
  });

  it("parses the Web fields from the existing Judge JSON", () => {
    const result = parseJudgeResult(JSON.stringify({
      difficulty_score_raw: 25,
      factors: {
        reasoning_depth: 2.5,
        task_scope: 2.5,
        constraint_density: 2.5,
        tool_dependency: 2.5,
        verification_burden: 2.5,
        context_burden: 2.5,
      },
      p_low: 0.7,
      p_mid: 0.2,
      p_mid_high: 0.08,
      p_high: 0.02,
      confidence: 0.9,
      signals: ["local_change"],
      explanation: "本地修改。",
      webIntent: "not_required",
      webIntentConfidence: 0.98,
      webIntentReason: "The task only needs the local workspace.",
      webIntentEvidence: ["local_or_code_context"],
    }));
    expect(result).toMatchObject({
      webIntent: "not_required",
      webIntentConfidence: 0.98,
      webIntentReason: "The task only needs the local workspace.",
      webIntentEvidence: ["local_or_code_context"],
    });
  });

  it("uses heuristic_fallback only when the existing Judge fails", async () => {
    const client = { judge: vi.fn().mockRejectedValue(new Error("fixture timeout")) } as unknown as AcuJudgeClient;
    const runner = createAcuJudgeRunner({
      config: readAcuRuntimeConfig({ apiKey: "fixture", allowMock: true }),
      rulesDecision: {
        model: "fixture",
        tier: "SIMPLE",
        confidence: 0.8,
        method: "rules",
        reasoning: "fixture",
        costEstimate: 0,
        baselineCost: 0,
        savings: 0,
      },
      client,
    });
    const result = await runner.run({
      messages: [{ role: "user", content: "查询今天 BTC 价格" }],
      tools: [],
      trigger: "new_task",
      contextHash: "fixture",
      webIntentFallbackInput: { recentUserInputs: ["查询今天 BTC 价格"] },
    });
    expect(client.judge).toHaveBeenCalledTimes(1);
    expect(result.webIntentDecision).toMatchObject({
      intent: "required",
      source: "heuristic_fallback",
    });
  });

  it("does not let the Regex fallback override a valid Judge result", async () => {
    const judge = parseJudgeResult(JSON.stringify({
      difficulty_score_raw: 20,
      factors: {
        reasoning_depth: 2,
        task_scope: 2,
        constraint_density: 2,
        tool_dependency: 2,
        verification_burden: 2,
        context_burden: 2,
      },
      p_low: 0.8,
      p_mid: 0.15,
      p_mid_high: 0.04,
      p_high: 0.01,
      confidence: 0.9,
      signals: ["local_identifier"],
      explanation: "本地变量。",
      webIntent: "not_required",
      webIntentConfidence: 0.99,
      webIntentReason: "latestVersion is a local variable name.",
      webIntentEvidence: ["local_or_code_context"],
    }));
    const client = { judge: vi.fn().mockResolvedValue({
      result: judge,
      status: "live",
      resultSource: "upstream_live",
      provider: "fixture",
      endpointHost: "fixture",
      upstreamRequestId: "fixture",
      latencyMs: 1,
      cost: 0,
      promptTokens: 1,
      completionTokens: 1,
      usageStatus: "reported",
      contextSha256: "fixture",
      cacheKeySha256: "fixture",
      cacheCreatedAt: "2026-07-29T00:00:00.000Z",
      contextTokenEstimate: 1,
      contextTruncated: false,
    }) } as unknown as AcuJudgeClient;
    const runner = createAcuJudgeRunner({
      config: readAcuRuntimeConfig({ apiKey: "fixture", allowMock: true }),
      rulesDecision: {
        model: "fixture",
        tier: "SIMPLE",
        confidence: 0.8,
        method: "rules",
        reasoning: "fixture",
        costEstimate: 0,
        baselineCost: 0,
        savings: 0,
      },
      client,
    });
    const result = await runner.run({
      messages: [{ role: "user", content: "更新 latestVersion 变量" }],
      tools: [],
      trigger: "new_task",
      contextHash: "fixture",
      webIntentFallbackInput: { recentUserInputs: ["查询今天 BTC 价格"] },
    });
    expect(result.webIntentDecision).toEqual({
      intent: "not_required",
      confidence: 0.99,
      reason: "latestVersion is a local variable name.",
      evidence: ["local_or_code_context"],
      source: "judge",
    });
  });
});
