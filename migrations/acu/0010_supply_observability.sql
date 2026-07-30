BEGIN;

ALTER TABLE acu_judge_evaluations
  ADD COLUMN IF NOT EXISTS original_explanation_type TEXT;

CREATE TABLE IF NOT EXISTS acu_channel_admin_actions (
  action_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  action TEXT NOT NULL,
  duration_minutes INTEGER,
  actor TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO acu_schema_migrations (migration_version)
VALUES ('0010_supply_observability')
ON CONFLICT (migration_version) DO NOTHING;

COMMIT;
