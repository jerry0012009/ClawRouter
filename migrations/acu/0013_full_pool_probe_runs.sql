BEGIN;

CREATE TABLE IF NOT EXISTS acu_full_pool_probe_runs (
  full_pool_probe_run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running','completed','budget_exhausted','failed')),
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled_activity','manual')),
  profile_count INTEGER NOT NULL DEFAULT 0,
  attempted_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  cost_cny NUMERIC(20,10) NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_acu_full_pool_probe_runs_completed
  ON acu_full_pool_probe_runs(completed_at DESC);

INSERT INTO acu_schema_migrations (migration_version)
VALUES ('0013_full_pool_probe_runs')
ON CONFLICT (migration_version) DO NOTHING;

COMMIT;
