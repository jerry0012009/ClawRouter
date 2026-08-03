BEGIN;

ALTER TABLE acu_judge_attempts
  DROP CONSTRAINT IF EXISTS acu_judge_attempts_attempt_index_check;

ALTER TABLE acu_judge_attempts
  ADD CONSTRAINT acu_judge_attempts_attempt_index_check
  CHECK (attempt_index BETWEEN 1 AND 5);

INSERT INTO acu_schema_migrations (migration_version)
VALUES ('0016_judge_profile_attempt_limit_5')
ON CONFLICT (migration_version) DO NOTHING;

COMMIT;
