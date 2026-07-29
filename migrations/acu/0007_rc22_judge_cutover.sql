BEGIN;

CREATE TABLE IF NOT EXISTS acu_schema_migrations (
  migration_version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO acu_schema_migrations (migration_version) VALUES
  ('0001_alpha_p0'),
  ('0002_provider_channel_health'),
  ('0003_web_intent_source'),
  ('0004_rc2_context_ledger'),
  ('0005_rc2_judge_reconciliation'),
  ('0006_rc21_cost_semantics'),
  ('0007_rc22_judge_cutover')
ON CONFLICT (migration_version) DO NOTHING;

ALTER TABLE acu_judge_evaluations
  ADD COLUMN IF NOT EXISTS explanation_normalized BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS original_explanation_length INTEGER,
  ADD COLUMN IF NOT EXISTS official_payg_equivalent_cost NUMERIC(20,10) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_currency TEXT NOT NULL DEFAULT 'CNY',
  ADD COLUMN IF NOT EXISTS judge_cost_status TEXT NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS judge_cost_source TEXT NOT NULL DEFAULT 'not_applicable';

CREATE TABLE IF NOT EXISTS acu_judge_attempts (
  judge_attempt_id TEXT PRIMARY KEY,
  judge_evaluation_id TEXT NOT NULL REFERENCES acu_judge_evaluations(judge_evaluation_id),
  logical_request_id TEXT REFERENCES acu_logical_requests(logical_request_id),
  attempt_index INTEGER NOT NULL CHECK (attempt_index IN (1, 2)),
  attempt_role TEXT NOT NULL CHECK (attempt_role IN ('primary', 'backup')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  endpoint_host TEXT NOT NULL,
  upstream_request_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  error_category TEXT,
  http_status INTEGER,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  nominal_cost_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  official_payg_equivalent_cost NUMERIC(20,10) NOT NULL DEFAULT 0,
  effective_cost_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  cost_status TEXT NOT NULL,
  cost_source TEXT NOT NULL,
  usage_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (judge_evaluation_id, attempt_index),
  UNIQUE (logical_request_id, attempt_index, attempt_role)
);

CREATE INDEX IF NOT EXISTS idx_acu_judge_attempts_evaluation
  ON acu_judge_attempts (judge_evaluation_id, attempt_index);

ALTER TABLE acu_judge_ledger_entries
  ADD COLUMN IF NOT EXISTS official_payg_equivalent_cost NUMERIC(20,10) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CNY',
  ADD COLUMN IF NOT EXISTS cost_status TEXT NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS cost_source_detail TEXT NOT NULL DEFAULT 'not_applicable';

ALTER TABLE acu_usage_reports
  ADD COLUMN IF NOT EXISTS judge_input_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS judge_output_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS judge_official_payg_equivalent_cost NUMERIC(20,10) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS judge_cost_currency TEXT NOT NULL DEFAULT 'CNY',
  ADD COLUMN IF NOT EXISTS judge_cost_status TEXT NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS judge_cost_source TEXT NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS judge_provider TEXT,
  ADD COLUMN IF NOT EXISTS judge_model TEXT;

COMMIT;
