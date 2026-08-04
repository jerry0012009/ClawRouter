import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_RECOVERY_WINDOW_MS,
  FULL_POOL_BUDGET_FRACTION,
  activeRecoveryRequired,
  adaptiveProbeIntervalMinutes,
  adaptiveProbePayload,
  fullPoolProbeDue,
  fullPoolBudgetLimit,
  recoveredAfterLastFailure,
} from "../src/alpha/adaptive-probe.js";

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

  it("continues targeted recovery for a recent queue or active model demand", () => {
    const now = Date.parse("2026-08-01T12:00:00Z");
    expect(activeRecoveryRequired({
      recoveryStartedAt: new Date(now - ACTIVE_RECOVERY_WINDOW_MS), recentModelDemand: false, now,
    })).toBe(true);
    expect(activeRecoveryRequired({
      recoveryStartedAt: new Date(now - ACTIVE_RECOVERY_WINDOW_MS - 1), recentModelDemand: true, now,
    })).toBe(true);
    expect(activeRecoveryRequired({
      recoveryStartedAt: new Date(now - ACTIVE_RECOVERY_WINDOW_MS - 1), recentModelDemand: false, now,
    })).toBe(false);
  });

  it("only accepts exact success newer than the last exact failure", () => {
    const failure = new Date("2026-08-01T10:00:00Z");
    expect(recoveredAfterLastFailure({ lastSuccessAt: new Date("2026-08-01T09:00:00Z"), lastFailureAt: failure })).toBe(false);
    expect(recoveredAfterLastFailure({ lastSuccessAt: new Date("2026-08-01T11:00:00Z"), lastFailureAt: failure })).toBe(true);
  });

  it("reserves twenty percent of daily budget from scheduled full-pool", () => {
    expect(FULL_POOL_BUDGET_FRACTION).toBe(0.8);
    expect(fullPoolBudgetLimit(1, false)).toBe(0.8);
    expect(fullPoolBudgetLimit(1, true)).toBe(1);
  });

  it("uses a one CNY daily probe default in runtime and deployment configuration", async () => {
    const [server, compose, envExample] = await Promise.all([
      readFile(new URL("../src/alpha/server.ts", import.meta.url), "utf8"),
      readFile(new URL("../deploy/alpha/docker-compose.yml", import.meta.url), "utf8"),
      readFile(new URL("../deploy/alpha/.env.example", import.meta.url), "utf8"),
    ]);
    expect(server).toContain('ACU_PROBE_DAILY_BUDGET_CNY ?? "1.00"');
    expect(compose).toContain("ACU_PROBE_DAILY_BUDGET_CNY:-1.00");
    expect(envExample).toContain("ACU_PROBE_DAILY_BUDGET_CNY=1.00");
  });
});

describe("adaptive probe payload", () => {
  it("uses the Responses minimum output allowance accepted by CloseAI", () => {
    expect(adaptiveProbePayload("responses", "gpt-5.6-luna")).toMatchObject({
      model: "gpt-5.6-luna",
      max_output_tokens: 16,
      stream: true,
    });
  });

  it("preserves the Messages probe payload", () => {
    expect(adaptiveProbePayload("messages", "gpt-5.6-luna")).toMatchObject({
      model: "gpt-5.6-luna",
      max_tokens: 4,
      stream: true,
    });
  });
});
