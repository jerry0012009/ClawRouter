import { describe, expect, it } from "vitest";
import { adaptiveProbeIntervalMinutes } from "../src/alpha/adaptive-probe.js";

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
});
