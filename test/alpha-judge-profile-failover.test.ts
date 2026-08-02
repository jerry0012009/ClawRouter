import { describe, expect, it } from "vitest";
import { getEligibleLunaJudgeProfiles } from "../src/alpha/judge-profile-selector.js";
import type { AlphaExecutionProfile } from "../src/alpha/routing.js";
import { AcuJudgeClient } from "../src/acu/judge.js";
import { readAcuRuntimeConfig } from "../src/acu/config.js";
import { createAcuJudgeRunner, judgeProfileAttemptDeadline } from "../src/alpha/judge-runner.js";
import { randomUUID } from "node:crypto";

function profile(id: string, overrides: Partial<AlphaExecutionProfile> = {}): AlphaExecutionProfile {
  return {
    executionProfileId: id,
    modelId: "gpt-5.6-luna",
    providerModelId: "gpt-5.6-luna",
    provider: "lucen",
    channel: id,
    protocols: ["responses"],
    toolCallSupport: true,
    thinkingSupport: false,
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
  it("reserves one viable failover window without extending the shared deadline", () => {
    expect(judgeProfileAttemptDeadline({ now: 1_000, globalDeadlineAt: 26_000, profilesRemaining: 2 })).toBe(18_000);
    expect(judgeProfileAttemptDeadline({ now: 18_000, globalDeadlineAt: 26_000, profilesRemaining: 1 })).toBe(26_000);
    expect(judgeProfileAttemptDeadline({ now: 20_000, globalDeadlineAt: 26_000, profilesRemaining: 0 })).toBe(26_000);
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
        profile("unverified", { contextCapabilityStatus: "unverified_long_context" }),
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
