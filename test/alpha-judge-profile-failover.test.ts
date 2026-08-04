import { describe, expect, it } from "vitest";
import { getEligibleLunaJudgeProfiles } from "../src/alpha/judge-profile-selector.js";
import type { AlphaExecutionProfile } from "../src/alpha/routing.js";
import { AcuJudgeClient, AcuJudgeClientCancelledError } from "../src/acu/judge.js";
import { readAcuRuntimeConfig } from "../src/acu/config.js";
import { createAcuJudgeRunner, judgeProfileAttemptDeadline } from "../src/alpha/judge-runner.js";
import { randomUUID } from "node:crypto";
import { hydrateExecutionProfileRuntime } from "../src/alpha/processor.js";
import { computeFirstModelEventDeadlineMs, hasRecoveryAttemptBudget, MINIMUM_RECOVERY_ATTEMPT_BUDGET_MS, recoveryBudgetMs } from "../src/alpha/execution-timing.js";

function profile(id: string, overrides: Partial<AlphaExecutionProfile> = {}): AlphaExecutionProfile {
  return {
    executionProfileId: id,
    modelId: "gpt-5.6-luna",
    providerModelId: "gpt-5.6-luna",
    provider: "lucen",
    channel: id,
    protocols: ["responses"],
    toolCallSupport: true,
    thinkingSupport: true,
    reasoningControlMode: "standard_effort",
    health: "healthy",
    enabled: true,
    administratorAllowed: true,
    autoRouteEnabled: true,
    usageTrusted: true,
    contextCapabilityStatus: "observed_floor",
    ...overrides,
  };
}

describe("Luna Judge Profile selector", () => {
  it("uses Router context defaults, recovery budgets and minimum attempt budget", () => {
    expect(computeFirstModelEventDeadlineMs({ estimatedInputTokens: 80_000, successfulLatenciesMs: [], recentErrorClasses: [] })).toBe(45_000);
    expect(computeFirstModelEventDeadlineMs({ estimatedInputTokens: 100_000, successfulLatenciesMs: [], recentErrorClasses: [] })).toBe(75_000);
    expect(recoveryBudgetMs(80_000)).toBe(180_000);
    expect(recoveryBudgetMs(100_000)).toBe(270_000);
    expect(MINIMUM_RECOVERY_ATTEMPT_BUDGET_MS).toBe(15_000);
    expect(hasRecoveryAttemptBudget(181_000, 166_000)).toBe(true);
    expect(hasRecoveryAttemptBudget(181_000, 166_001)).toBe(false);
  });

  it("uses the shared dynamic deadline and gives failover Profiles a normal window", () => {
    const dynamic = computeFirstModelEventDeadlineMs({
      estimatedInputTokens: 80_000,
      successfulLatenciesMs: Array.from({ length: 10 }, (_, index) => 20_000 + index * 100),
      recentErrorClasses: [], profileState: "healthy",
    });
    expect(dynamic).toBe(31_350);
    expect(judgeProfileAttemptDeadline({ now: 1_000, poolDeadlineAt: 181_000, profileDeadlineMs: dynamic })).toBe(32_350);
    expect(judgeProfileAttemptDeadline({ now: 46_000, poolDeadlineAt: 181_000, profileDeadlineMs: 45_000 })).toBe(91_000);
  });

  it("uses the shared score and only uses preferred Profile as a tie-breaker", () => {
    const selected = getEligibleLunaJudgeProfiles({
      preferredProfileId: "lucen-cx006-value-dynamic:gpt-5.6-luna:responses",
      profiles: [
        profile("blackai:gpt-5.6-luna:responses", { provider: "blackai", observedLatencyMs: 20 }),
        profile("lucen-cx006-value-dynamic:gpt-5.6-luna:responses", { observedLatencyMs: 600_000 }),
        profile("sol:gpt-5.6-luna:responses", { modelId: "gpt-5.6-luna", providerModelId: "gpt-5.6-luna" }),
        profile("rejected:gpt-5.6-luna:responses", { verificationStatus: "rejected" }),
        profile("inactive:gpt-5.6-luna:responses", { autoRouteEnabled: false }),
        profile("terra", { modelId: "gpt-5.6-terra", providerModelId: "gpt-5.6-terra" }),
      ],
      requiredContextTokens: 100,
      maxProfiles: 3,
    });
    expect(selected.map((item) => item.executionProfileId)).toEqual([
      "sol:gpt-5.6-luna:responses",
      "blackai:gpt-5.6-luna:responses",
      "lucen-cx006-value-dynamic:gpt-5.6-luna:responses",
    ]);
  });

  it("uses preferredProfileId only when shared scores are equal", () => {
    const selected = getEligibleLunaJudgeProfiles({
      profiles: [profile("a"), profile("b")],
      preferredProfileId: "b",
      requiredContextTokens: 100,
    });
    expect(selected.map((item) => item.executionProfileId)).toEqual(["b", "a"]);
  });

  it("slightly increases Judge reliability and latency weight without making it health-first", () => {
    const selected = getEligibleLunaJudgeProfiles({
      profiles: [
        profile("cheap-slower", {
          recentSuccessRate: 0.7, observedLatencyMs: 30_000,
          billingPrice: { inputPricePerMillion: 0.8, outputPricePerMillion: 0.8 },
        }),
        profile("reliable-faster", {
          recentSuccessRate: 0.9, observedLatencyMs: 2_000,
          billingPrice: { inputPricePerMillion: 0.8, outputPricePerMillion: 0.8 },
        }),
        profile("meaningfully-cheaper", {
          recentSuccessRate: 0.55, observedLatencyMs: 40_000,
          billingPrice: { inputPricePerMillion: 0.3, outputPricePerMillion: 0.3 },
        }),
      ],
      requiredContextTokens: 100,
      maxProfiles: 3,
    });
    expect(selected.map((item) => item.executionProfileId)).toEqual([
      "meaningfully-cheaper", "reliable-faster", "cheap-slower",
    ]);
  });

  it("keeps one healthy cross-provider Judge fallback", () => {
    const selected = getEligibleLunaJudgeProfiles({
      profiles: [
        profile("lucen-a", { billingPrice: { inputPricePerMillion: 1, outputPricePerMillion: 1 } }),
        profile("lucen-b", { billingPrice: { inputPricePerMillion: 1.1, outputPricePerMillion: 1.1 } }),
        profile("lucen-c", { billingPrice: { inputPricePerMillion: 1.2, outputPricePerMillion: 1.2 } }),
        profile("degraded-blackai", { provider: "blackai", health: "degraded",
          billingPrice: { inputPricePerMillion: 10, outputPricePerMillion: 10 } }),
        profile("closeai", { provider: "closeai", billingPrice: { inputPricePerMillion: 12, outputPricePerMillion: 12 } }),
      ],
      requiredContextTokens: 100,
      maxProfiles: 3,
    });
    expect(selected.map((item) => item.executionProfileId)).toEqual(["lucen-a", "lucen-b", "closeai"]);
  });

  it("hydrates shared runtime health before filtering and ranking Judge Profiles", () => {
    const now = new Date("2026-08-03T12:00:00.000Z");
    const open = hydrateExecutionProfileRuntime(profile("open"), {
      state: "open", consecutiveFailures: 3, recentSuccessRate: 0.1,
      cooldownUntil: new Date("2026-08-03T12:05:00.000Z"), usageTrusted: true,
    }, undefined, now.getTime());
    const degraded = hydrateExecutionProfileRuntime(profile("degraded"), {
      state: "degraded", consecutiveFailures: 1, recentSuccessRate: 0.65,
      totalLatencyMs: 4_000, usageTrusted: true,
    }, undefined, now.getTime());
    const fast = hydrateExecutionProfileRuntime(profile("fast"), {
      state: "healthy", consecutiveFailures: 0, recentSuccessRate: 0.99,
      totalLatencyMs: 100, usageTrusted: true,
    }, undefined, now.getTime());
    const slow = hydrateExecutionProfileRuntime(profile("slow"), {
      state: "healthy", consecutiveFailures: 0, recentSuccessRate: 0.8,
      totalLatencyMs: 20_000, usageTrusted: true,
    }, undefined, now.getTime());

    expect(open).toMatchObject({ health: "cooldown", recentSuccessRate: 0.1, usageTrusted: true });
    expect(degraded).toMatchObject({ health: "degraded", recentSuccessRate: 0.65, observedLatencyMs: 4_000 });
    expect(getEligibleLunaJudgeProfiles({
      profiles: [open, degraded, slow, fast], preferredProfileId: "slow", requiredContextTokens: 100,
    }).map((item) => item.executionProfileId)).toEqual(["fast", "slow", "degraded"]);
  });

  it("fails over from preferred Lucen to another Luna without cross-model backup", async () => {
    const preferred = profile("lucen-cx006-value-dynamic:gpt-5.6-luna:responses");
    const alternate = profile("blackai:gpt-5.6-luna:responses", { provider: "blackai" });
    const config = readAcuRuntimeConfig({
      enabled: true,
      allowMock: true,
      apiKey: "fixture",
      judgeModel: "gpt-5.6-luna",
      judgeProvider: "lucen",
      judgeBaseUrl: "https://lucen.invalid/v1",
      primaryProfileId: preferred.executionProfileId,
      maxProfileAttempts: 3,
      sameModelFailoverEnabled: true,
      syncBackupEnabled: false,
      cachePath: `/tmp/luna-failover-${randomUUID()}.json`,
    });
    const valid = {
      difficulty_score_raw: 42,
      factors: { reasoning_depth: 4, task_scope: 4, constraint_density: 4, tool_dependency: 4, verification_burden: 4, context_burden: 4 },
      p_low: 0.1, p_mid: 0.7, p_mid_high: 0.15, p_high: 0.05, confidence: 0.9,
      signals: [], explanation: "fixture", webIntent: "not_required", webIntentConfidence: 1,
      webIntentReason: "local", webIntentEvidence: [],
    };
    const clients = new Map([
      [preferred.executionProfileId, new AcuJudgeClient(config, async () => new Response("rate limited", { status: 429 }))],
      [alternate.executionProfileId, new AcuJudgeClient({ ...config, judgeProvider: "blackai", judgeBaseUrl: "https://blackai.invalid/v1" }, async () => new Response(JSON.stringify({
        id: "alternate", model: "gpt-5.6-luna", choices: [{ message: { content: JSON.stringify(valid) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }), { status: 200, headers: { "content-type": "application/json" } }))],
    ]);
    const runner = createAcuJudgeRunner({
      config,
      profiles: [preferred, alternate, profile("sol", { modelId: "gpt-5.6-sol", providerModelId: "gpt-5.6-sol" })],
      profileClients: clients,
      rulesDecision: { model: "rules", tier: "MEDIUM", confidence: 1, method: "rules", reasoning: "fixture", costEstimate: 0, baselineCost: 0, savings: 0 },
    });
    const result = await runner.run({
      messages: [], tools: [], trigger: "new_task", contextHash: "fixture",
      webIntentFallbackInput: { recentUserInputs: ["fixture"] },
      rawNative: { stateMetadata: {}, rawRequest: JSON.stringify({ model: "acu-auto", input: "fixture" }) },
    });
    expect(result.model).toBe("gpt-5.6-luna");
    expect(result.selectedProfileId).toBe(alternate.executionProfileId);
    expect(result.sameModelFailoverUsed).toBe(true);
    expect(result.sameModelFailoverChain).toEqual([preferred.executionProfileId, alternate.executionProfileId]);
    expect(result.attempts.map((attempt) => attempt.model)).toEqual(["gpt-5.6-luna", "gpt-5.6-luna"]);
  });

  it("records Judge context evidence and retries another Luna Profile", async () => {
    const first = profile("first", { observedSuccessfulInputTokens: 100 });
    const second = profile("second", { observedSuccessfulInputTokens: 100 });
    const config = readAcuRuntimeConfig({
      allowMock: true, apiKey: "fixture", judgeProtocol: "responses", maxProfileAttempts: 5,
      cachePath: `/tmp/judge-context-failover-${randomUUID()}.json`, syncBackupEnabled: false,
    });
    const valid = {
      difficulty_score_raw: 42,
      factors: { reasoning_depth: 4, task_scope: 4, constraint_density: 4, tool_dependency: 4, verification_burden: 4, context_burden: 4 },
      p_low: 0.1, p_mid: 0.7, p_mid_high: 0.15, p_high: 0.05, confidence: 0.9,
      signals: [], explanation: "fixture", webIntent: "not_required", webIntentConfidence: 1,
      webIntentReason: "local", webIntentEvidence: [],
    };
    const clients = new Map([
      [first.executionProfileId, new AcuJudgeClient(config, async () => new Response(JSON.stringify({
        error: { code: "context_length_exceeded", message: "Input exceeds the context window" },
      }), { status: 200, headers: { "content-type": "application/json" } }))],
      [second.executionProfileId, new AcuJudgeClient(config, async () => new Response(JSON.stringify({
        model: "gpt-5.6-luna", output: [{ content: [{ type: "output_text", text: JSON.stringify(valid) }] }],
        usage: { input_tokens: 120, output_tokens: 20 },
      }), { status: 200, headers: { "content-type": "application/json" } }))],
    ]);
    const evidence: Array<{ id: string; successInputTokens?: number; judgeFailureThresholdTokens?: number }> = [];
    const result = await createAcuJudgeRunner({
      config, profiles: [first, second], profileClients: clients,
      recordContextEvidence: async (selected, item) => { evidence.push({ id: selected.executionProfileId, ...item }); },
      rulesDecision: { model: "rules", tier: "MEDIUM", confidence: 1, method: "rules", reasoning: "fixture", costEstimate: 0, baselineCost: 0, savings: 0 },
    }).run({
      messages: [], tools: [], trigger: "new_task", contextHash: "fixture",
      webIntentFallbackInput: { recentUserInputs: ["fixture"] },
      rawNative: { stateMetadata: {}, rawRequest: JSON.stringify({ model: "acu-auto", input: "fixture" }) },
    });
    expect(result.selectedProfileId).toBe(second.executionProfileId);
    expect(result.attempts).toHaveLength(2);
    expect(evidence).toEqual([
      { id: first.executionProfileId, judgeFailureThresholdTokens: expect.any(Number) },
      { id: second.executionProfileId, successInputTokens: 120 },
    ]);
  });

  it.each([
    ["HTML", "<!doctype html><html></html>", "text/html", "provider_protocol_failure"],
    ["invalid provider envelope", "not-json", "application/json", "provider_protocol_failure"],
    ["invalid Judge JSON", JSON.stringify({ model: "gpt-5.6-luna", output: [{ content: [{ type: "output_text", text: "ordinary prose" }] }] }), "application/json", "judge_semantic_parse_failure"],
  ])("fails over immediately after %s", async (_name, body, contentType, expectedCategory) => {
    const first = profile("first");
    const second = profile("second");
    const config = readAcuRuntimeConfig({
      allowMock: true, apiKey: "fixture", judgeModel: "gpt-5.6-luna", judgeProtocol: "responses",
      primaryProfileId: first.executionProfileId, cachePath: `/tmp/judge-protocol-${randomUUID()}.json`, syncBackupEnabled: false,
    });
    const valid = {
      difficulty_score_raw: 42,
      factors: { reasoning_depth: 4, task_scope: 4, constraint_density: 4, tool_dependency: 4, verification_burden: 4, context_burden: 4 },
      p_low: 0.1, p_mid: 0.7, p_mid_high: 0.15, p_high: 0.05, confidence: 0.9,
      signals: [], explanation: "fixture", webIntent: "not_required", webIntentConfidence: 1,
      webIntentReason: "local", webIntentEvidence: [],
    };
    const clients = new Map([
      [first.executionProfileId, new AcuJudgeClient(config, async () => new Response(body, { status: 200, headers: { "content-type": contentType } }))],
      [second.executionProfileId, new AcuJudgeClient(config, async () => new Response(JSON.stringify({
        model: "gpt-5.6-luna", output: [{ content: [{ type: "output_text", text: JSON.stringify(valid) }] }],
        usage: { input_tokens: 100, output_tokens: 20 },
      }), { status: 200, headers: { "content-type": "application/json" } }))],
    ]);
    const result = await createAcuJudgeRunner({
      config, profiles: [first, second], profileClients: clients,
      rulesDecision: { model: "rules", tier: "MEDIUM", confidence: 1, method: "rules", reasoning: "fixture", costEstimate: 0, baselineCost: 0, savings: 0 },
    }).run({
      messages: [], tools: [], trigger: "accepted_response_limit", contextHash: "fixture",
      webIntentFallbackInput: { recentUserInputs: ["fixture"] }, rawNative: { stateMetadata: {}, rawRequest: "{}" },
    });
    expect(result.resultSource).toBe("upstream_live");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ status: "error", errorCategory: expectedCategory });
    expect(result.attempts[1]).toMatchObject({ status: "success" });
  });

  it("does not fail over after client cancellation", async () => {
    const first = profile("first");
    const second = profile("second");
    const controller = new AbortController();
    let calls = 0;
    const config = readAcuRuntimeConfig({
      allowMock: true, apiKey: "fixture", judgeModel: "gpt-5.6-luna", judgeProtocol: "responses",
      primaryProfileId: first.executionProfileId, cachePath: `/tmp/judge-cancel-${randomUUID()}.json`, syncBackupEnabled: false,
    });
    const cancellingClient = new AcuJudgeClient(config, async () => {
      calls += 1;
      controller.abort();
      throw new DOMException("cancelled", "AbortError");
    });
    const unusedClient = new AcuJudgeClient(config, async () => {
      calls += 1;
      throw new Error("must not run");
    });
    const runner = createAcuJudgeRunner({
      config, profiles: [first, second], profileClients: new Map([
        [first.executionProfileId, cancellingClient], [second.executionProfileId, unusedClient],
      ]),
      rulesDecision: { model: "rules", tier: "MEDIUM", confidence: 1, method: "rules", reasoning: "fixture", costEstimate: 0, baselineCost: 0, savings: 0 },
    });
    await expect(runner.run({
      messages: [], tools: [], trigger: "accepted_response_limit", contextHash: "fixture", signal: controller.signal,
      webIntentFallbackInput: { recentUserInputs: ["fixture"] }, rawNative: { stateMetadata: {}, rawRequest: "{}" },
    })).rejects.toBeInstanceOf(AcuJudgeClientCancelledError);
    expect(calls).toBe(1);
  });

  it("reuses a recent evaluation only after the Luna Profile pool is exhausted", async () => {
    const first = profile("first");
    const second = profile("second");
    const config = readAcuRuntimeConfig({
      allowMock: true, apiKey: "fixture", judgeModel: "gpt-5.6-luna", judgeProtocol: "responses",
      primaryProfileId: first.executionProfileId, cachePath: `/tmp/judge-exhaustion-${randomUUID()}.json`, syncBackupEnabled: false,
    });
    const valid = {
      difficulty_score_raw: 42,
      factors: { reasoning_depth: 4, task_scope: 4, constraint_density: 4, tool_dependency: 4, verification_burden: 4, context_burden: 4 },
      p_low: 0.1, p_mid: 0.7, p_mid_high: 0.15, p_high: 0.05, confidence: 0.9,
      signals: [], explanation: "fixture", webIntent: "not_required", webIntentConfidence: 1,
      webIntentReason: "local", webIntentEvidence: [],
    };
    const successfulClient = new AcuJudgeClient(config, async () => new Response(JSON.stringify({
      model: "gpt-5.6-luna", output: [{ content: [{ type: "output_text", text: JSON.stringify(valid) }] }],
      usage: { input_tokens: 100, output_tokens: 20 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const rulesDecision = { model: "rules", tier: "MEDIUM" as const, confidence: 1, method: "rules" as const, reasoning: "fixture", costEstimate: 0, baselineCost: 0, savings: 0 };
    const recentEvaluation = await createAcuJudgeRunner({
      config, profiles: [first], profileClients: new Map([[first.executionProfileId, successfulClient]]), rulesDecision,
    }).run({ messages: [], tools: [], trigger: "new_task", contextHash: "fixture", webIntentFallbackInput: { recentUserInputs: ["fixture"] }, rawNative: { stateMetadata: {}, rawRequest: "{}" } });
    let calls = 0;
    const failedClient = () => new AcuJudgeClient(config, async () => {
      calls += 1;
      return new Response("unavailable", { status: 503 });
    });
    const result = await createAcuJudgeRunner({
      config, profiles: [first, second], profileClients: new Map([
        [first.executionProfileId, failedClient()], [second.executionProfileId, failedClient()],
      ]), rulesDecision,
    }).run({
      messages: [], tools: [], trigger: "accepted_response_limit", contextHash: "fixture", recentEvaluation,
      webIntentFallbackInput: { recentUserInputs: ["fixture"] }, rawNative: { stateMetadata: {}, rawRequest: "different" },
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ status: "recent_evaluation", resultSource: "recent_evaluation" });
    expect(result.attempts).toHaveLength(2);
  });

  it.each([
    ["timeout", () => Promise.reject(new DOMException("timed out", "AbortError")), "transport_failure"],
    ["429", () => new Response("rate limited", { status: 429 }), "transport_failure"],
    ["503", () => new Response("unavailable", { status: 503 }), "transport_failure"],
    ["html", () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } }), "provider_protocol_failure"],
  ])("writes shared health for %s", async (_name, response, failureLayer) => {
    const selected = profile("selected");
    const config = readAcuRuntimeConfig({
      allowMock: true, apiKey: "fixture", judgeModel: selected.modelId,
      judgeBaseUrl: "https://example.invalid/v1", judgeProtocol: "responses",
      cachePath: `/tmp/judge-health-${randomUUID()}.json`, syncBackupEnabled: false,
    });
    const outcomes: Array<{ success: boolean; errorCode?: string; httpStatus?: number }> = [];
    const runner = createAcuJudgeRunner({
      config, profiles: [selected],
      profileClients: new Map([[selected.executionProfileId, new AcuJudgeClient(config, async () => response() as Awaited<ReturnType<typeof fetch>>)] ]),
      recordHealthOutcome: async (_profile, outcome) => {
        outcomes.push(outcome);
        return { errorClass: String(outcome.errorCode), scope: "profile" };
      },
      rulesDecision: { model: "rules", tier: "MEDIUM", confidence: 1, method: "rules", reasoning: "fixture", costEstimate: 0, baselineCost: 0, savings: 0 },
    });
    const result = await runner.run({
      messages: [], tools: [], trigger: "new_task", contextHash: "fixture",
      webIntentFallbackInput: { recentUserInputs: ["fixture"] },
      rawNative: { stateMetadata: {}, rawRequest: "{}" },
    });
    expect(outcomes).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ failureLayer, healthOutcomeApplied: true, healthOutcomeScope: "profile" });
  });

  it("excludes unhealthy, untrusted and context-ineligible Profiles", () => {
    const selected = getEligibleLunaJudgeProfiles({
      profiles: [
        profile("open", { health: "open" }),
        profile("untrusted", { usageTrusted: false }),
        profile("hard-capped", { providerHardContextCap: 65_536 }),
        profile("healthy"),
      ],
      requiredContextTokens: 66_000,
    });
    expect(selected.map((item) => item.executionProfileId)).toEqual(["healthy"]);
  });

  it("writes a successful Judge attempt to shared health", async () => {
    const selected = profile("selected");
    const config = readAcuRuntimeConfig({
      allowMock: true, apiKey: "fixture", judgeProtocol: "responses",
      cachePath: `/tmp/judge-success-${randomUUID()}.json`, syncBackupEnabled: false,
    });
    const valid = {
      difficulty_score_raw: 42,
      factors: { reasoning_depth: 4, task_scope: 4, constraint_density: 4, tool_dependency: 4, verification_burden: 4, context_burden: 4 },
      p_low: 0.1, p_mid: 0.7, p_mid_high: 0.15, p_high: 0.05, confidence: 0.9,
      signals: [], explanation: "fixture", webIntent: "not_required", webIntentConfidence: 1,
      webIntentReason: "local", webIntentEvidence: [],
    };
    const client = new AcuJudgeClient(config, async () => new Response(JSON.stringify({
      model: "gpt-5.6-luna", output: [{ content: [{ type: "output_text", text: JSON.stringify(valid) }] }],
      usage: { input_tokens: 100, output_tokens: 20 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const outcomes: Array<{ success: boolean }> = [];
    const result = await createAcuJudgeRunner({
      config, profiles: [selected], profileClients: new Map([[selected.executionProfileId, client]]),
      recordHealthOutcome: async (_profile, outcome) => {
        outcomes.push(outcome);
        return { errorClass: "none", scope: "none" };
      },
      rulesDecision: { model: "rules", tier: "MEDIUM", confidence: 1, method: "rules", reasoning: "fixture", costEstimate: 0, baselineCost: 0, savings: 0 },
    }).run({
      messages: [], tools: [], trigger: "new_task", contextHash: "fixture",
      webIntentFallbackInput: { recentUserInputs: ["fixture"] },
      rawNative: { stateMetadata: {}, rawRequest: "{}" },
    });
    expect(outcomes).toEqual([{ success: true, httpStatus: 200, usageTrusted: true, actualModelVerified: true, totalLatencyMs: expect.any(Number) }]);
    expect(result.attempts[0]).toMatchObject({ status: "success", healthOutcomeApplied: true, healthOutcomeScope: "none" });
  });
});
