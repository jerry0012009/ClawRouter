import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcuRoutingStore, type AcuEvaluation } from "../src/acu/index.js";

const temporaryDirectories: string[] = [];

function evaluation(requestId: string): AcuEvaluation {
  const estimate = {
    modelId: "qwen3.6-plus", displayName: "Qwen 3.6 Plus", provider: "Qwen",
    estimatedQuality: 0.8, conservativeQuality: 0.75, qualityLower: 0.75, qualityUpper: 0.85,
    estimatedCallCost: 0.001, expectedFallbackCost: 0, expectedTotalCost: 0.001,
    predictedScore: 80, conservativeScore: 75, riskAdjustedCost: 0.001, riskAdjustedScore: 75,
    qualityUtility: 0.8, costUtility: 0.9, valueUtility: 0.85, scoreGapVsBest: 0,
    costSavingsVsBest: 0, paretoEfficient: true, selectionReason: "test",
    savingsVsFlagship: 0, savingsPercentVsFlagship: 0, meetsQualityTarget: true,
  };
  return {
    estimateLabel: "public-benchmark constrained estimate", promptVersion: "test", judgeModel: "test",
    judgeMode: "non-thinking", judge: { difficultyScore: 40, pLow: 0.1, pMid: 0.7, pMidHigh: 0.15, pHigh: 0.05, confidence: 0.8, signals: [], explanation: "test" },
    judgeStatus: "live", judgeResultSource: "upstream_live", judgeProvider: "test", judgeEndpointHost: "test",
    upstreamRequestId: null, contextSha256: requestId.padEnd(64, "0"), cacheKeySha256: requestId.padEnd(64, "1"),
    cacheCreatedAt: new Date().toISOString(), judgeLatencyMs: 1, judgePromptTokens: 1, judgeCompletionTokens: 1,
    judgeCost: 0, usageStatus: "reported", routingModelVersion: "test", difficultyScore: 40,
    qualityTarget: 0.8, judgeEntropy: 0.4, shadowMode: false, requestId,
    contextTokenEstimate: 10, contextTruncated: false, disclaimer: "test",
    recommendation: { recommended: estimate, valueAlternative: null, flagshipAlternative: estimate, fallbackModel: estimate, estimates: [estimate], reason: "test" },
  };
}

afterEach(async () => {
  while (temporaryDirectories.length) await rm(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("passive execution profile health", () => {
  it("places a profile in a 60 second cooldown after two consecutive timeouts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acu-health-"));
    temporaryDirectories.push(directory);
    const store = new AcuRoutingStore(join(directory, "routing.db"));
    for (const requestId of ["timeout-1", "timeout-2"]) {
      store.recordEvaluation(evaluation(requestId));
      store.finalizeRequest(requestId, {
        executionProfileId: "qwen3.6-plus:non-thinking", thinkingMode: "disabled",
        requestParameterApplied: true, upstreamModel: "qwen3.6-plus",
      });
      store.recordAttempts(requestId, [{
        model: "qwen3.6-plus", upstream: "proxy", status: "timeout", error_category: "timeout", latency_ms: 15_000,
        attempt_type: "initial", execution_profile_id: "qwen3.6-plus:non-thinking", thinking_mode: "disabled",
        request_parameter_applied: true, upstream_model: "qwen3.6-plus", reasoning_tokens: 0,
      }]);
    }
    const health = store.getExecutionProfileHealth("qwen3.6-plus:non-thinking");
    expect(health.availability).toBe("cooldown");
    expect(health.consecutiveTimeouts).toBe(2);
    expect(Date.parse(health.cooldownUntil!)).toBeGreaterThan(Date.now());
    const summary = store.summary() as { executionProfileSummaries: Array<{ requestCount: number; independentCurveEligible: boolean; curveNotice: string }> };
    expect(summary.executionProfileSummaries[0]).toMatchObject({ requestCount: 2, independentCurveEligible: false });
    expect(summary.executionProfileSummaries[0].curveNotice).toContain("少于30条");
    store.close();
  });
});
