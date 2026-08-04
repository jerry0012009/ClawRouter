BEGIN;

DO $$
DECLARE
  current_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid)
  INTO current_definition
  FROM pg_constraint
  WHERE conrelid = 'acu_judge_attempts'::regclass
    AND conname = 'acu_judge_attempts_attempt_index_check';

  -- Keep an already-applied v1 constraint or the wider v2 constraint from 0016.
  IF current_definition LIKE '%attempt_index <= 3%'
    OR current_definition LIKE '%attempt_index <= 5%'
    OR current_definition LIKE '%BETWEEN 1 AND 3%'
    OR current_definition LIKE '%BETWEEN 1 AND 5%'
  THEN
    RETURN;
  END IF;

  ALTER TABLE acu_judge_attempts
    DROP CONSTRAINT IF EXISTS acu_judge_attempts_attempt_index_check;

  -- NOT VALID preserves legitimate historical attempts created by newer retry limits
  -- while enforcing the v1 limit for new rows until 0016 widens it to five.
  ALTER TABLE acu_judge_attempts
    ADD CONSTRAINT acu_judge_attempts_attempt_index_check
    CHECK (attempt_index BETWEEN 1 AND 3) NOT VALID;

  IF NOT EXISTS (SELECT 1 FROM acu_judge_attempts WHERE attempt_index > 3) THEN
    ALTER TABLE acu_judge_attempts
      VALIDATE CONSTRAINT acu_judge_attempts_attempt_index_check;
  END IF;
END
$$;

INSERT INTO acu_schema_migrations (migration_version)
VALUES ('0015_judge_profile_attempt_limit')
ON CONFLICT (migration_version) DO NOTHING;

COMMIT;
