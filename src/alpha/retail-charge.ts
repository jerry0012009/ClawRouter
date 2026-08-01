export const DEFAULT_RETAIL_MARKUP_MULTIPLIER = 1;
export const DEFAULT_BILLING_POLICY_VERSION = "acu-retail-v1";

export type RetailChargeInput = {
  successfulProviderCashCostCny: number;
  judgeCashCostCny: number;
  failedAttemptCashCostCny: number;
  retailMarkupMultiplier: number;
};

export type RetailCharge = {
  retailMarkupMultiplier: number;
  successfulProviderCashCostCny: number;
  judgeCashCostCny: number;
  failedAttemptCashCostCny: number;
  billableBaseCostCny: number;
  actualTotalCashCostCny: number;
  userChargeCny: number;
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
    input.judgeCashCostCny,
    input.failedAttemptCashCostCny,
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Retail charge cost components must be finite non-negative numbers");
  }
  if (!Number.isFinite(input.retailMarkupMultiplier) || input.retailMarkupMultiplier < 1) {
    throw new Error("Retail markup multiplier must be a finite number greater than or equal to 1");
  }

  const billableBaseCostCny = input.successfulProviderCashCostCny + input.judgeCashCostCny;
  const actualTotalCashCostCny = billableBaseCostCny + input.failedAttemptCashCostCny;
  const userChargeCny = billableBaseCostCny * input.retailMarkupMultiplier;
  const grossProfitCny = userChargeCny - actualTotalCashCostCny;
  return {
    ...input,
    billableBaseCostCny,
    actualTotalCashCostCny,
    userChargeCny,
    grossProfitCny,
    grossMarginRate: userChargeCny === 0 ? 0 : grossProfitCny / userChargeCny,
  };
}
