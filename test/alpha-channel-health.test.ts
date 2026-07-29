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

  it("limits authentication to Channel and model incompatibility to Profile", () => {
    expect(classifyAttemptOutcome({ success: false, httpStatus: 401 }, 0)).toMatchObject({ scope: "channel", permanent: true });
    expect(classifyAttemptOutcome({ success: false, errorCode: "model_not_found" }, 0)).toMatchObject({ scope: "profile", permanent: true });
    expect(classifyAttemptOutcome({ success: false, errorMessage: "unsupported tool schema" }, 0)).toMatchObject({ scope: "profile", errorClass: "tool_incompatible" });
    expect(classifyAttemptOutcome({ success: false, httpStatus: 502 }, 0)).toMatchObject({ scope: "channel", errorClass: "provider_5xx" });
    expect(classifyAttemptOutcome({ success: false, httpStatus: 500 }, 0)).toMatchObject({ scope: "profile", errorClass: "provider_5xx" });
  });

  it("does not penalize client cancellation", () => {
    const previous = healthy();
    const next = applyAttemptOutcome(previous, { success: false, clientCancelled: true });
    expect(next).toMatchObject({ state: "healthy", consecutiveFailures: 0, recentSuccessRate: 1 });
  });

  it("quarantines actual-model mismatch and distrusts missing Usage at Profile scope", () => {
    expect(classifyAttemptOutcome({ success: true, actualModelMismatch: true }, 0)).toMatchObject({ errorClass: "actual_model_mismatch", scope: "profile", permanent: true });
    expect(classifyAttemptOutcome({ success: true, usageTrusted: false }, 0)).toMatchObject({ errorClass: "usage_untrusted", scope: "profile", usageTrusted: false });
  });
});
