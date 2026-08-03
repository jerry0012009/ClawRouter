import { describe, expect, it } from "vitest";
import { classifyExecutionOutcome, costCompletenessStatus } from "../src/alpha/execution-outcome.js";
import { isRecoveredSupplyProfile } from "../src/alpha/channel-registry.js";
import { effectiveContextCeiling } from "../src/alpha/context-admission.js";
import { classifyAttemptOutcome } from "../src/alpha/channel-health.js";

describe("Alpha execution outcome boundaries", () => {
  it("distinguishes verified, estimated, and unknown provider cost", () => {
    expect(costCompletenessStatus({ providerUsageReported: true, estimated: false })).toBe("complete");
    expect(costCompletenessStatus({ providerUsageReported: false, estimated: true })).toBe("partially_estimated");
    expect(costCompletenessStatus({ providerUsageReported: false, estimated: false })).toBe("provider_cost_unknown");
  });
  it("does not health-fail or erase billing when a client cancels after output", () => {
    expect(classifyExecutionOutcome({
      httpStatus: 200, complete: false, clientCancelled: true, modelVisibleOutputBytes: 1024,
      providerUsageReported: true,
    })).toEqual({
      deliveryStatus: "client_cancelled_after_output",
      recoveryStatus: "blocked_after_output",
      billingStatus: "provider_usage_verified",
      healthImpact: "none",
    });
  });

  it("distinguishes incomplete 200 before and after model output", () => {
    expect(classifyExecutionOutcome({ httpStatus: 200, complete: false, clientCancelled: false, modelVisibleOutputBytes: 0, providerUsageReported: false }).healthImpact)
      .toBe("profile_failure");
    expect(classifyExecutionOutcome({ httpStatus: 200, complete: false, clientCancelled: false, modelVisibleOutputBytes: 12, providerUsageReported: true }).healthImpact)
      .toBe("none");
    expect(classifyAttemptOutcome({
      success: false, httpStatus: 200, errorMessage: "upstream_failed_before_output",
    }, 0)).toMatchObject({ scope: "profile", countsAsChannelFailure: false });
  });

  it("requires verified model, usage, and healthy runtime before recovery", () => {
    const base = { actualModelVerified: true, usageTrusted: true, lastSuccessAt: new Date(), state: "healthy" };
    expect(isRecoveredSupplyProfile(base)).toBe(true);
    expect(isRecoveredSupplyProfile({ ...base, actualModelVerified: false })).toBe(false);
    expect(isRecoveredSupplyProfile({ ...base, usageTrusted: false })).toBe(false);
    expect(isRecoveredSupplyProfile({ ...base, state: "degraded" })).toBe(false);
  });

  it("does not turn unverified context metadata into a hard admission cap", () => {
    expect(effectiveContextCeiling({ modelId: "gpt-5.6-terra", contextCapabilityStatus: "unverified_long_context" }))
      .toBe(Number.MAX_SAFE_INTEGER);
  });
});
