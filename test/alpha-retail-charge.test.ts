import { describe, expect, it } from "vitest";
import { calculateRetailCharge, parseRetailMarkupMultiplier } from "../src/alpha/retail-charge.js";

describe("Alpha retail charge", () => {
  it("charges successful provider and Judge cost at the retail markup", () => {
    expect(calculateRetailCharge({
      successfulProviderCashCostCny: 1,
      successfulJudgeCashCostCny: 0.1,
      failedAttemptCashCostCny: 0,
      failedJudgeAttemptCashCostCny: 0,
      retailMarkupMultiplier: 1.25,
    })).toMatchObject({
      actualTotalCashCostCny: 1.1,
      billableBaseCostCny: 1.1,
      userChargeCny: 1.375,
    });
  });

  it("keeps failed attempt cost internal", () => {
    const result = calculateRetailCharge({
      successfulProviderCashCostCny: 1,
      successfulJudgeCashCostCny: 0.1,
      failedAttemptCashCostCny: 0.2,
      failedJudgeAttemptCashCostCny: 0,
      retailMarkupMultiplier: 1.25,
    });
    expect(result.actualTotalCashCostCny).toBeCloseTo(1.3);
    expect(result.billableBaseCostCny).toBe(1.1);
    expect(result.userChargeCny).toBe(1.375);
    expect(result.grossProfitCny).toBeCloseTo(0.075);
  });

  it("charges only the successful Judge attempt and keeps confirmed failed Judge cost internal", () => {
    const result = calculateRetailCharge({
      successfulProviderCashCostCny: 1,
      successfulJudgeCashCostCny: 0.1,
      failedAttemptCashCostCny: 0.2,
      failedJudgeAttemptCashCostCny: 0.05,
      retailMarkupMultiplier: 1.25,
    });
    expect(result.providerUserChargeCny).toBe(1.25);
    expect(result.judgeUserChargeCny).toBe(0.125);
    expect(result.userChargeCny).toBe(1.375);
    expect(result.actualTotalCashCostCny).toBeCloseTo(1.35);
  });

  it("uses the same rule for a Judge-only admission failure", () => {
    expect(calculateRetailCharge({
      successfulProviderCashCostCny: 0,
      successfulJudgeCashCostCny: 0.1,
      failedAttemptCashCostCny: 0,
      failedJudgeAttemptCashCostCny: 0,
      retailMarkupMultiplier: 1.25,
    })).toMatchObject({
      actualTotalCashCostCny: 0.1,
      billableBaseCostCny: 0.1,
      userChargeCny: 0.125,
    });
  });

  it("defaults to 1.0 and accepts 1.25", () => {
    expect(parseRetailMarkupMultiplier(undefined)).toBe(1);
    expect(parseRetailMarkupMultiplier("1.25")).toBe(1.25);
  });

  it.each(["0.99", "NaN", "Infinity", "invalid"])("rejects invalid multiplier %s", (value) => {
    expect(() => parseRetailMarkupMultiplier(value)).toThrow(/greater than or equal to 1/);
  });
});
