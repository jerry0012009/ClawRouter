BEGIN;

ALTER TABLE acu_judge_evaluations
  ADD COLUMN IF NOT EXISTS raw_request_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS raw_request_token_estimate BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS judge_context_limit BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS judge_context_source TEXT NOT NULL DEFAULT 'visible_context_legacy',
  ADD COLUMN IF NOT EXISTS curve_calibration_eligible BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS curve_calibration_exclusion_reason TEXT;

UPDATE acu_sessions
SET metadata_json = metadata_json || jsonb_build_object(
      'curveCalibrationEligible', false,
      'curveCalibrationExclusionReason', 'judge_context_truncated_goal_loss',
      'curveCalibrationReviewedAt', now()
    ),
    updated_at = now()
WHERE session_id = 'ses_8b6f42cb864943cbbe9acfb0912f5c33';

UPDATE acu_judge_evaluations
SET curve_calibration_eligible = false,
    curve_calibration_exclusion_reason = 'judge_context_truncated_goal_loss'
WHERE segment_id IN (
  SELECT segment.segment_id
  FROM acu_segments segment
  JOIN acu_tasks task ON task.task_id = segment.task_id
  WHERE task.session_id = 'ses_8b6f42cb864943cbbe9acfb0912f5c33'
);

INSERT INTO acu_schema_migrations (migration_version)
VALUES ('0009_raw_judge_context')
ON CONFLICT (migration_version) DO NOTHING;

COMMIT;
