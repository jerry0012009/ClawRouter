BEGIN;

ALTER TABLE acu_usage_reports
  ADD COLUMN IF NOT EXISTS provider_balance_charge NUMERIC(20,10) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_balance_currency TEXT NOT NULL DEFAULT 'USD-denominated credits',
  ADD COLUMN IF NOT EXISTS provider_credit_cash_cost_cny NUMERIC(20,10) NOT NULL DEFAULT 0;

UPDATE acu_usage_reports
SET provider_balance_charge = provider_balance_charge_usd,
    provider_balance_currency = 'USD-denominated credits',
    provider_credit_cash_cost_cny = CASE
      WHEN provider_balance_charge_usd > 0
        THEN effective_provider_cash_cost_cny / provider_balance_charge_usd
      ELSE 0
    END
WHERE provider_balance_charge = 0
  AND (provider_balance_charge_usd <> 0 OR effective_provider_cash_cost_cny <> 0);

COMMENT ON COLUMN acu_usage_reports.provider_balance_charge IS
  'Provider balance deduction in USD-denominated Credits; this is not cash USD.';
COMMENT ON COLUMN acu_usage_reports.provider_balance_currency IS
  'Unit label for Provider balance accounting, currently USD-denominated credits.';
COMMENT ON COLUMN acu_usage_reports.provider_credit_cash_cost_cny IS
  'Cash CNY paid per Provider Credit, before channel billing multiplier.';

COMMIT;
