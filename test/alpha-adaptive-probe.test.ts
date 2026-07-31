import { describe, expect, it } from "vitest";
import { adaptiveProbeIntervalMinutes, fullPoolProbeDue } from "../src/alpha/adaptive-probe.js";

describe("adaptive Probe scheduling", () => {
  it("does not probe without real user activity", () => {
    expect(adaptiveProbeIntervalMinutes(0)).toBeNull();
  });

  it("uses low, medium and high traffic windows", () => {
    expect(adaptiveProbeIntervalMinutes(1)).toBe(60);
    expect(adaptiveProbeIntervalMinutes(5)).toBe(60);
    expect(adaptiveProbeIntervalMinutes(6)).toBe(30);
    expect(adaptiveProbeIntervalMinutes(20)).toBe(30);
    expect(adaptiveProbeIntervalMinutes(21)).toBe(15);
  });

  it("runs a six-hour full-pool Probe only after real user activity", () => {
    const now = Date.parse("2026-07-31T06:00:00Z");
    expect(fullPoolProbeDue({ manual: false, userRequestsLastSixHours: 0, now })).toBe(false);
    expect(fullPoolProbeDue({ manual: false, userRequestsLastSixHours: 1, now })).toBe(true);
    expect(fullPoolProbeDue({ manual: false, userRequestsLastSixHours: 1, now,
      lastCompletedAt: new Date(now - 5 * 60 * 60_000) })).toBe(false);
    expect(fullPoolProbeDue({ manual: false, userRequestsLastSixHours: 1, now,
      lastCompletedAt: new Date(now - 6 * 60 * 60_000) })).toBe(true);
    expect(fullPoolProbeDue({ manual: true, userRequestsLastSixHours: 0, now,
      lastCompletedAt: new Date(now) })).toBe(true);
  });
});
