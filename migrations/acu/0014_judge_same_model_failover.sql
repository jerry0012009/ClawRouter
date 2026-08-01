BEGIN;

ALTER TABLE acu_judge_attempts
  DROP CONSTRAINT IF EXISTS acu_judge_attempts_attempt_role_check;

ALTER TABLE acu_judge_attempts
  ADD CONSTRAINT acu_judge_attempts_attempt_role_check
  CHECK (attempt_role IN ('primary', 'same_model_failover', 'backup'));

INSERT INTO acu_schema_migrations (migration_version)
VALUES ('0014_judge_same_model_failover')
ON CONFLICT (migration_version) DO NOTHING;

COMMIT;
