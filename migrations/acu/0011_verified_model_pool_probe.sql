BEGIN;

CREATE TABLE IF NOT EXISTS acu_profile_probe_attempts (
  probe_attempt_id TEXT PRIMARY KEY,
  execution_profile_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  canonical_model_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  attempt_kind TEXT NOT NULL DEFAULT 'probe' CHECK (attempt_kind='probe'),
  status TEXT NOT NULL,
  http_status INTEGER,
  error_class TEXT,
  latency_ms INTEGER,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  actual_model TEXT,
  usage_trusted BOOLEAN NOT NULL DEFAULT false,
  cost_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_acu_profile_probe_attempts_profile_started
  ON acu_profile_probe_attempts(execution_profile_id,started_at DESC);

INSERT INTO acu_schema_migrations (migration_version)
VALUES ('0011_verified_model_pool_probe')
ON CONFLICT (migration_version) DO NOTHING;

COMMIT;
