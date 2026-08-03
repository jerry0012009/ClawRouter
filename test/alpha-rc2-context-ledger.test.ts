import { describe, expect, it } from "vitest";
import { normalizeResponsesRequest } from "../src/alpha/protocol/responses.js";
import {
  canonicalAdvertisedContextWindow,
  effectiveContextCeiling,
  estimateContextAdmission,
} from "../src/alpha/context-admission.js";
import { AlphaAdmissionError, routeWithCurrentAcuFormula, type AlphaExecutionProfile } from "../src/alpha/routing.js";
import type { AcuJudgeResult } from "../src/acu/types.js";

const judge: AcuJudgeResult = {
  pLow: 0.1, pMid: 0.2, pMidHigh: 0.5, pHigh: 0.2, confidence: 0.9,
  difficultyScoreRaw: 60, factorComposite: 60, difficultyIndex: 60, difficultyScore: 60,
  difficultyMethodVersion: "acu-difficulty-index-v1", signals: [], explanation: "fixture",
  factors: {
    reasoningDepth: 6, taskScope: 6, constraintDensity: 6,
    toolDependency: 6, verificationBurden: 6, contextBurden: 6,
  },
};

function profile(overrides: Partial<AlphaExecutionProfile> = {}): AlphaExecutionProfile {
  return {
    executionProfileId: "lucen-luna", modelId: "gpt-5.6-luna", provider: "lucen",
    channel: "cx006", protocols: ["responses"], toolCallSupport: true,
    supportedToolTypes: ["function", "local_tool"], thinkingSupport: true, health: "healthy",
    enabled: true, administratorAllowed: true, canonicalAdvertisedContextWindow: 1_050_000,
    observedSuccessfulInputTokens: 229_541, providerHardContextCap: null,
    contextCapabilityStatus: "observed_floor", ...overrides,
  };
}

function route(profiles: AlphaExecutionProfile[], requiredTotalContextTokens: number) {
  return routeWithCurrentAcuFormula({
    judge, judgeCost: 0, inputTokens: requiredTotalContextTokens, expectedOutputTokens: 0,
    effectiveQualityTarget: 80, profiles,
    requirements: {
      protocol: "responses", requireTools: false, requireThinking: false,
      context: {
        estimatedInputTokens: requiredTotalContextTokens, estimationMethod: "structured_conservative_v2",
        requestedMaxOutputTokens: 0, reservedOutputTokens: 0, safetyMarginTokens: 0,
        requiredTotalContextTokens,
      },
    },
  });
}

describe("Alpha RC2 context admission and ledger contract", () => {
  it("keeps canonical context metadata without using it as an admission ceiling", () => {
    expect(canonicalAdvertisedContextWindow("gpt-5.4-mini")).toBe(400_000);
    expect(canonicalAdvertisedContextWindow("gpt-5.6-luna")).toBe(1_050_000);
    expect(effectiveContextCeiling(profile())).toBe(Number.MAX_SAFE_INTEGER);
    expect(route([profile()], 32_222).selectedProfile.modelId).toBe("gpt-5.6-luna");
    expect(route([profile()], 229_815).selectedProfile.modelId).toBe("gpt-5.6-luna");
  });

  it("honors only an explicit Provider hard cap", () => {
    expect(effectiveContextCeiling(profile({ providerHardContextCap: 200_000 }))).toBe(200_000);
  });

  it("excludes only requests at or above a Profile's observed context failure threshold", () => {
    const cappedByEvidence = profile({ observedContextFailureThresholdTokens: 380_000 });
    expect(route([cappedByEvidence], 379_999).selectedProfile.executionProfileId).toBe("lucen-luna");
    expect(() => route([cappedByEvidence], 380_000)).toThrowError(
      expect.objectContaining<Partial<AlphaAdmissionError>>({ errorType: "context_length_exceeded" }),
    );
  });

  it("counts cached history because admission estimates the full structured request", () => {
    const small = normalizeResponsesRequest({ model: "acu-auto", input: "next" });
    const cached = normalizeResponsesRequest({
      model: "acu-auto",
      input: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(400_000) }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    });
    expect(estimateContextAdmission(cached, 800).estimatedInputTokens)
      .toBeGreaterThan(estimateContextAdmission(small, 800).estimatedInputTokens + 90_000);
  });

  it("forwards the synthetic long-context fixture when Profiles have no verified hard cap", () => {
    const envelope = normalizeResponsesRequest({
      model: "acu-auto",
      input: "Reply with exactly OK.\n" + "alpha ".repeat(229_000),
      max_output_tokens: 16,
    });
    const estimate = estimateContextAdmission(envelope, 800);
    expect(estimate.estimationMethod).toBe("structured_conservative_v2");
    expect(estimate.estimatedInputTokens).toBeGreaterThan(411_967);
    const selected = route([
      profile({
        executionProfileId: "lucen-mini", modelId: "gpt-5.4-mini",
        canonicalAdvertisedContextWindow: 400_000, observedSuccessfulInputTokens: 0,
        contextCapabilityStatus: "unverified_long_context",
      }),
      profile(),
    ], estimate.requiredTotalContextTokens);
    expect(["gpt-5.4-mini", "gpt-5.6-luna"]).toContain(selected.selectedProfile.modelId);
  });

  it("returns a typed HTTP 400 only for a verified Provider hard cap", () => {
    expect(() => route([profile({ canonicalAdvertisedContextWindow: 32_768, providerHardContextCap: 32_768 })], 40_000)).toThrowError(
      expect.objectContaining<Partial<AlphaAdmissionError>>({
        errorType: "context_length_exceeded", statusCode: 400,
        details: expect.objectContaining({
          estimated_input_tokens: 40_000, required_total_context_tokens: 40_000,
          maximum_available_context_tokens: 32_768,
          exclusion_counts: expect.objectContaining({ context_window: 1 }),
        }),
      }),
    );
  });

  it("preserves the tool-capability error when context is sufficient", () => {
    expect(() => routeWithCurrentAcuFormula({
      judge, judgeCost: 0, inputTokens: 1_000, expectedOutputTokens: 0, effectiveQualityTarget: 80,
      profiles: [profile({ toolCallSupport: false, supportedToolTypes: [] })],
      requirements: {
        protocol: "responses", requireTools: true, requiredToolTypes: ["function"],
        requireThinking: false, contextTokens: 1_000,
      },
    })).toThrowError(expect.objectContaining<Partial<AlphaAdmissionError>>({
      errorType: "tool_capability_unavailable", statusCode: 400,
    }));
  });
});
