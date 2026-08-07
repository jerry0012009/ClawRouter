export const DEFAULT_RETAIL_MARKUP_MULTIPLIER = 1;
export const DEFAULT_BILLING_POLICY_VERSION = "acu-retail-v1";

export function applyRetailMarkup(providerCashCostCny: number, retailMarkupMultiplier: number): number {
  if (!Number.isFinite(providerCashCostCny) || providerCashCostCny < 0) {
    throw new Error("Provider cash cost must be a finite non-negative number");
  }
  if (!Number.isFinite(retailMarkupMultiplier) || retailMarkupMultiplier < 1) {
    throw new Error("Retail markup multiplier must be a finite number greater than or equal to 1");
  }
  return providerCashCostCny * retailMarkupMultiplier;
}

export type RetailChargeInput = {
  successfulProviderCashCostCny: number;
  successfulJudgeCashCostCny: number;
  failedAttemptCashCostCny: number;
  failedJudgeAttemptCashCostCny: number;
  retailMarkupMultiplier: number;
};

export type RetailCharge = {
  retailMarkupMultiplier: number;
  successfulProviderCashCostCny: number;
  successfulJudgeCashCostCny: number;
  failedAttemptCashCostCny: number;
  failedJudgeAttemptCashCostCny: number;
  billableBaseCostCny: number;
  actualTotalCashCostCny: number;
  userChargeCny: number;
  providerUserChargeCny: number;
  judgeUserChargeCny: number;
  grossProfitCny: number;
  grossMarginRate: number;
};

export function parseRetailMarkupMultiplier(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_RETAIL_MARKUP_MULTIPLIER;
  const multiplier = Number(value);
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw new Error("ACU_RETAIL_MARKUP_MULTIPLIER must be a finite number greater than or equal to 1");
  }
  return multiplier;
}

export function calculateRetailCharge(input: RetailChargeInput): RetailCharge {
  const values = [
    input.successfulProviderCashCostCny,
    input.successfulJudgeCashCostCny,
    input.failedAttemptCashCostCny,
    input.failedJudgeAttemptCashCostCny,
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Retail charge cost components must be finite non-negative numbers");
  }
  if (!Number.isFinite(input.retailMarkupMultiplier) || input.retailMarkupMultiplier < 1) {
    throw new Error("Retail markup multiplier must be a finite number greater than or equal to 1");
  }

  const billableBaseCostCny = input.successfulProviderCashCostCny + input.successfulJudgeCashCostCny;
  const actualTotalCashCostCny = billableBaseCostCny + input.failedAttemptCashCostCny
    + input.failedJudgeAttemptCashCostCny;
  const userChargeCny = billableBaseCostCny * input.retailMarkupMultiplier;
  const providerUserChargeCny = input.successfulProviderCashCostCny * input.retailMarkupMultiplier;
  const judgeUserChargeCny = input.successfulJudgeCashCostCny * input.retailMarkupMultiplier;
  const grossProfitCny = userChargeCny - actualTotalCashCostCny;
  return {
    ...input,
    billableBaseCostCny,
    actualTotalCashCostCny,
    userChargeCny,
    providerUserChargeCny,
    judgeUserChargeCny,
    grossProfitCny,
    grossMarginRate: userChargeCny === 0 ? 0 : grossProfitCny / userChargeCny,
  };
}
