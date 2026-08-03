import { describe, expect, it } from "vitest";
import { applyAttemptOutcome, classifyAttemptOutcome, refreshExpiredCircuit, type HealthSnapshot } from "../src/alpha/channel-health.js";

const healthy = (): HealthSnapshot => ({ state: "healthy", consecutiveFailures: 0, recentSuccessRate: 1 });

describe("Provider Channel circuit breaker", () => {
  it("uses the required exponential cooldown schedule", () => {
    let state = healthy();
    const now = new Date("2026-07-29T00:00:00Z");
    const expected = [30, 120, 600, 1_800];
    for (const seconds of expected) {
      state = applyAttemptOutcome(state, { success: false, errorMessage: "network fetch failed" }, now);
      expect((state.cooldownUntil!.getTime() - now.getTime()) / 1_000).toBe(seconds);
    }
    expect(refreshExpiredCircuit(state, new Date(now.getTime() + 1_801_000)).state).toBe("half_open");
  });

  it("limits account failures to Channel and provider-path failures to Profile", () => {
    expect(classifyAttemptOutcome({ success: false, httpStatus: 401 }, 0)).toMatchObject({ scope: "channel", permanent: false });
    expect(classifyAttemptOutcome({ success: false, httpStatus: 403 }, 0)).toMatchObject({ scope: "channel" });
    expect(classifyAttemptOutcome({ success: false, errorMessage: "insufficient account balance" }, 0))
      .toMatchObject({ scope: "channel", errorClass: "quota_exhausted" });
    expect(classifyAttemptOutcome({ success: false, errorMessage: "account credit exhausted" }, 0))
      .toMatchObject({ scope: "channel", errorClass: "quota_exhausted" });
    expect(classifyAttemptOutcome({ success: false, httpStatus: 429, errorMessage: "API key rate limit exceeded" }, 0))
      .toMatchObject({ scope: "channel", errorClass: "rate_limited" });
    expect(classifyAttemptOutcome({ success: false, httpStatus: 429, errorMessage: "model busy" }, 0))
      .toMatchObject({ scope: "profile", errorClass: "rate_limited" });
    expect(classifyAttemptOutcome({ success: false, errorCode: "model_not_found" }, 0)).toMatchObject({ scope: "profile", permanent: false });
    expect(classifyAttemptOutcome({ success: false, errorMessage: "unsupported tool schema" }, 0)).toMatchObject({ scope: "profile", errorClass: "tool_incompatible" });
    expect(classifyAttemptOutcome({ success: false, httpStatus: 502 }, 0)).toMatchObject({ scope: "profile", errorClass: "provider_5xx" });
    expect(classifyAttemptOutcome({ success: false, httpStatus: 500 }, 0)).toMatchObject({ scope: "profile", errorClass: "provider_5xx" });
    expect(classifyAttemptOutcome({ success: false, httpStatus: 524 }, 0)).toMatchObject({ scope: "profile", errorClass: "provider_edge_timeout", recoverableBeforeModelOutput: true });
  });

  it("does not penalize client cancellation", () => {
    const previous = healthy();
    const next = applyAttemptOutcome(previous, { success: false, clientCancelled: true });
    expect(next).toMatchObject({ state: "healthy", consecutiveFailures: 0, recentSuccessRate: 1 });
  });

  it("classifies an empty pre-output stream as transient Profile health", () => {
    expect(classifyAttemptOutcome({
      success: false, httpStatus: 200, errorCode: "stream_ended_before_model_event",
    }, 0)).toMatchObject({
      errorClass: "provider_empty_stream", scope: "profile", cooldownSeconds: 30,
      recoverableBeforeModelOutput: true,
    });
    expect(classifyAttemptOutcome({
      success: false, httpStatus: 503, errorCode: "stream_ended_before_model_event",
    }, 0)).toMatchObject({ errorClass: "provider_5xx", scope: "profile", cooldownSeconds: 30 });
  });

  it("quarantines actual-model mismatch and distrusts missing Usage at Profile scope", () => {
    expect(classifyAttemptOutcome({ success: false, actualModelMismatch: true }, 0)).toMatchObject({
      errorClass: "actual_model_mismatch", scope: "profile", permanent: false, cooldownSeconds: 1_800,
    });
    expect(classifyAttemptOutcome({ success: false, errorCode: "usage_untrusted" }, 0)).toMatchObject({
      errorClass: "usage_untrusted", scope: "profile", usageTrusted: false,
    });
    expect(classifyAttemptOutcome({ success: true, usageTrusted: false }, 0)).toMatchObject({ errorClass: "usage_untrusted", scope: "profile", usageTrusted: false });
  });
});
