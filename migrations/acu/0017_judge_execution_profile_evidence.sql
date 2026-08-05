BEGIN;

ALTER TABLE acu_judge_attempts
  ADD COLUMN IF NOT EXISTS execution_profile_id TEXT,
  ADD COLUMN IF NOT EXISTS channel_id TEXT;

INSERT INTO acu_schema_migrations (migration_version)
VALUES ('0017_judge_execution_profile_evidence')
ON CONFLICT (migration_version) DO NOTHING;

COMMIT;
