import { describe, expect, it } from "vitest";
import { classifyProviderContextOverflow, contextOverflowRecoveryEligible, createRecoveringProviderAdapter, type ProviderAttemptHandle } from "../src/alpha/execution.js";
import { effectiveContextCeiling } from "../src/alpha/context-admission.js";
import { contextModelRerouteReason } from "../src/alpha/processor.js";
import type { NativeProviderRequest } from "../src/alpha/provider.js";
import { routeWithCurrentAcuFormula, type AlphaExecutionProfile } from "../src/alpha/routing.js";
import type { AcuJudgeResult } from "../src/acu/types.js";

const profile = (id: string, modelId: string): AlphaExecutionProfile => ({
  executionProfileId: id, modelId, provider: id, channel: id, protocols: ["responses"],
  toolCallSupport: true, supportedToolTypes: ["function"], thinkingSupport: true,
  contextWindow: 200_000, health: "healthy", enabled: true, administratorAllowed: true, usageTrusted: true,
});
const request = (): NativeProviderRequest => ({ protocol: "responses", path: "/v1/responses", query: "", headers: {}, body: Buffer.from("{}"), signal: new AbortController().signal });
const judge: AcuJudgeResult = {
  difficultyScoreRaw: 70, difficultyScore: 70, difficultyIndex: 70,
  factors: { reasoningDepth: 70, taskScope: 70, constraintDensity: 70, toolDependency: 70, verificationBurden: 70, contextBurden: 70 },
  factorComposite: 70, pLow: 0, pMid: 0.1, pMidHigh: 0.8, pHigh: 0.1,
  confidence: 0.9, entropy: 0.2, signals: [], explanation: "test", webIntent: "not_required",
};

describe("context overflow recovery", () => {
  it("recognizes explicit overflow but not an ordinary invalid request", () => {
    expect(classifyProviderContextOverflow(JSON.stringify({ error: { code: "context_length_exceeded", message: "Maximum context length is 128,000 tokens" } })))
      .toEqual({ isContextOverflow: true, reportedContextLimit: 128000 });
    expect(classifyProviderContextOverflow(JSON.stringify({ error: { type: "invalid_request_error", message: "unsupported parameter" } })))
      .toEqual({ isContextOverflow: false });
  });

  it("does not infer a reported limit from request data echoed by an SSE response", () => {
    const stream = [
      `data: ${JSON.stringify({ type: "response.created", response: { instructions: "budget 3,600,000 tokens" } })}`,
      `data: ${JSON.stringify({ type: "error", error: { code: "context_length_exceeded", message: "Input exceeds the context window" } })}`,
      "",
    ].join("\n");
    expect(classifyProviderContextOverflow(stream)).toEqual({ isContextOverflow: true, reportedContextLimit: undefined });
  });

  it("requires automatic routing, zero output, and a connected client", () => {
    expect(contextOverflowRecoveryEligible({ isContextOverflow: true, modelVisibleOutputBytes: 0, clientDisconnected: false, automaticRouting: true })).toBe(true);
    expect(contextOverflowRecoveryEligible({ isContextOverflow: true, modelVisibleOutputBytes: 1, clientDisconnected: false, automaticRouting: true })).toBe(false);
    expect(contextOverflowRecoveryEligible({ isContextOverflow: true, modelVisibleOutputBytes: 0, clientDisconnected: false, automaticRouting: false })).toBe(false);
  });

  it("does not retry an ordinary HTTP 400", async () => {
    const selected = profile("glm", "glm-5.2");
    let calls = 0;
    const handle: ProviderAttemptHandle = { attemptId: "attempt-1", attemptIndex: 1, profile: selected,
      adapter: { async execute() { calls += 1; return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "unsupported parameter" } }), { status: 400 }); } } };
    const adapter = createRecoveringProviderAdapter({ initial: handle, maxAttempts: 3,
      isRecoverableFailure: (failure) => classifyProviderContextOverflow(failure).isContextOverflow,
      selectRecoveryTarget: () => ({ profile: profile("sol", "gpt-5.6-sol"), reason: "context_model_reroute" }),
      startRetry: async () => { throw new Error("must not retry"); }, recordFailedAttempt: async () => {} });
    expect((await adapter.execute(request())).status).toBe(400);
    expect(calls).toBe(1);
  });

  it("reroutes within one adapter execution without exposing the overflow", async () => {
    const first = profile("glm-a", "glm-5.2");
    const second = profile("sol", "gpt-5.6-sol");
    const calls: string[] = [];
    const handle = (attemptIndex: number, selected: AlphaExecutionProfile): ProviderAttemptHandle => ({
      attemptId: `attempt-${attemptIndex}`, attemptIndex, profile: selected,
      adapter: { async execute() { calls.push(selected.modelId); return selected === first
        ? new Response(JSON.stringify({ error: { code: "context_length_exceeded" } }), { status: 400 })
        : new Response("success", { status: 200 }); } },
    });
    const adapter = createRecoveringProviderAdapter({ initial: handle(1, first), maxAttempts: 3,
      isRecoverableFailure: (failure) => classifyProviderContextOverflow(failure).isContextOverflow,
      selectRecoveryTarget: () => ({ profile: second, reason: "context_model_reroute" }),
      startRetry: async (selected, index) => handle(index, selected), recordFailedAttempt: async () => {} });
    expect(await (await adapter.execute(request())).text()).toBe("success");
    expect(calls).toEqual(["glm-5.2", "gpt-5.6-sol"]);
  });

  it("classifies a context overflow carried by an HTTP 500 before recovering", async () => {
    const first = profile("glm", "glm-5.2");
    const second = profile("sol", "gpt-5.6-sol");
    let classified = false;
    const handle = (index: number, selected: AlphaExecutionProfile): ProviderAttemptHandle => ({ attemptId: `a-${index}`, attemptIndex: index, profile: selected,
      adapter: { async execute() { return selected === first
        ? new Response(JSON.stringify({ error: { code: "context_length_exceeded" } }), { status: 500 })
        : new Response("recovered"); } } });
    const adapter = createRecoveringProviderAdapter({ initial: handle(1, first), maxAttempts: 3,
      isRecoverableFailure: (failure) => { classified = classifyProviderContextOverflow(failure).isContextOverflow; return classified; },
      selectRecoveryTarget: () => classified ? { profile: second, reason: "context_model_reroute" } : undefined,
      startRetry: async (selected, index) => handle(index, selected), recordFailedAttempt: async () => {} });
    expect(await (await adapter.execute(request())).text()).toBe("recovered");
    expect(classified).toBe(true);
  });

  it("records the context reroute from the previous model to the next model", () => {
    expect(contextModelRerouteReason("glm-5.2", "gpt-5.6-sol"))
      .toBe("context_model_reroute:glm-5.2->gpt-5.6-sol");
  });

  it("does not impose an admission ceiling without a verified Provider hard cap", () => {
    expect(effectiveContextCeiling({ modelId: "gpt-5.6-sol", canonicalAdvertisedContextWindow: 1_000 }))
      .toBe(Number.MAX_SAFE_INTEGER);
    expect(effectiveContextCeiling({ modelId: "gpt-5.6-sol", canonicalAdvertisedContextWindow: 1_000,
      providerHardContextCap: 800_000 })).toBe(800_000);
  });

  it("uses route direction any so recovery may select a lower-tier model", () => {
    const high = { ...profile("sol", "gpt-5.6-sol"), inputPricePerMillion: 100, outputPricePerMillion: 100 };
    const lower = { ...profile("luna", "gpt-5.6-luna"), inputPricePerMillion: 0.01, outputPricePerMillion: 0.01 };
    const result = routeWithCurrentAcuFormula({ judge, judgeCost: 0, inputTokens: 1_000, expectedOutputTokens: 100,
      effectiveQualityTarget: 50, routingPreference: "economy", profiles: [high, lower], routeDirection: "any",
      requirements: { protocol: "responses", requireTools: false, requiredToolTypes: [], requireThinking: false,
        context: { estimatedInputTokens: 1_000, requiredTotalContextTokens: 2_000, contextWindowSource: "estimate" }, expectedOutputTokens: 100 } });
    expect(result.selectedProfile.modelId).toBe("gpt-5.6-luna");
  });

  it("keeps the final selected Profile metadata on the successful attempt", async () => {
    const first = profile("glm", "glm-5.2");
    const second = profile("luna", "gpt-5.6-luna");
    let finalProfile = first;
    const handle = (index: number, selected: AlphaExecutionProfile): ProviderAttemptHandle => ({ attemptId: `a-${index}`, attemptIndex: index, profile: selected,
      adapter: { async execute() { return selected === first ? new Response("prompt is too long", { status: 400 }) : new Response("ok"); } } });
    const adapter = createRecoveringProviderAdapter({ initial: handle(1, first), maxAttempts: 3,
      isRecoverableFailure: (failure) => classifyProviderContextOverflow(failure).isContextOverflow,
      selectRecoveryTarget: () => ({ profile: second, reason: "context_model_reroute" }),
      startRetry: async (selected, index) => handle(index, selected), recordFailedAttempt: async () => {},
      onSelected: (attempt) => { finalProfile = attempt.profile; } });
    expect(await (await adapter.execute(request())).text()).toBe("ok");
    expect(finalProfile.executionProfileId).toBe("luna");
  });

  it("limits consecutive overflow attempts to three", async () => {
    const profiles = [profile("a", "a"), profile("b", "b"), profile("c", "c")];
    let calls = 0;
    const handle = (index: number, selected: AlphaExecutionProfile): ProviderAttemptHandle => ({ attemptId: `a-${index}`, attemptIndex: index, profile: selected,
      adapter: { async execute() { calls += 1; return new Response("context window exceeded", { status: 400 }); } } });
    const adapter = createRecoveringProviderAdapter({ initial: handle(1, profiles[0]!), maxAttempts: 3,
      isRecoverableFailure: (failure) => classifyProviderContextOverflow(failure).isContextOverflow,
      selectRecoveryTarget: (current) => profiles[current.attemptIndex] ? { profile: profiles[current.attemptIndex]!, reason: "context_model_reroute" } : undefined,
      startRetry: async (selected, index) => handle(index, selected), recordFailedAttempt: async () => {} });
    expect((await adapter.execute(request())).status).toBe(400);
    expect(calls).toBe(3);
  });
});
