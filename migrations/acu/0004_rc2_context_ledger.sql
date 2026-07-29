BEGIN;

ALTER TABLE acu_provider_model_profile_health
  ADD COLUMN IF NOT EXISTS canonical_advertised_context_window BIGINT,
  ADD COLUMN IF NOT EXISTS provider_declared_context_window BIGINT,
  ADD COLUMN IF NOT EXISTS observed_successful_input_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_hard_context_cap BIGINT,
  ADD COLUMN IF NOT EXISTS context_capability_status TEXT,
  ADD COLUMN IF NOT EXISTS context_capability_source TEXT,
  ADD COLUMN IF NOT EXISTS context_last_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS acu_admission_traces (
  admission_trace_id TEXT PRIMARY KEY,
  admission_idempotency_key TEXT NOT NULL UNIQUE,
  newapi_user_id TEXT NOT NULL,
  logical_request_id TEXT REFERENCES acu_logical_requests(logical_request_id),
  session_id TEXT NOT NULL REFERENCES acu_sessions(session_id),
  task_id TEXT NOT NULL REFERENCES acu_tasks(task_id),
  segment_id TEXT NOT NULL REFERENCES acu_segments(segment_id),
  judge_evaluation_id TEXT REFERENCES acu_judge_evaluations(judge_evaluation_id),
  request_protocol TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('evaluating','admitted','rejected')),
  error_type TEXT,
  http_status INTEGER,
  estimated_input_tokens BIGINT NOT NULL,
  estimation_method TEXT NOT NULL,
  requested_max_output_tokens BIGINT NOT NULL,
  reserved_output_tokens BIGINT NOT NULL,
  safety_margin_tokens BIGINT NOT NULL,
  required_total_context_tokens BIGINT NOT NULL,
  maximum_available_context_tokens BIGINT,
  candidate_context_limits_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  exclusion_counts_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_acu_admission_user_segment
  ON acu_admission_traces (newapi_user_id,segment_id,created_at DESC);

CREATE TABLE IF NOT EXISTS acu_judge_ledger_entries (
  judge_ledger_entry_id TEXT PRIMARY KEY,
  judge_evaluation_id TEXT NOT NULL UNIQUE REFERENCES acu_judge_evaluations(judge_evaluation_id),
  admission_trace_id TEXT NOT NULL REFERENCES acu_admission_traces(admission_trace_id),
  newapi_user_id TEXT NOT NULL,
  judge_provider TEXT,
  judge_model TEXT,
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  nominal_cost_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  effective_cash_cost_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  cost_source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE acu_usage_reports
  ADD COLUMN IF NOT EXISTS nominal_provider_cost_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_balance_charge_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS effective_provider_cash_cost_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS judge_cash_cost_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_attempt_cash_cost_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actual_total_cash_cost_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS user_charge_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS counterfactual_quality_ceiling_cost_cny NUMERIC(20,10);

COMMIT;
