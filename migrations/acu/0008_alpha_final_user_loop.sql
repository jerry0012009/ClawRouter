BEGIN;

ALTER TABLE acu_logical_requests
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS abandoned_at TIMESTAMPTZ;

UPDATE acu_logical_requests
SET updated_at = COALESCE(completed_at, started_at),
    processing_lease_expires_at = CASE
      WHEN status = 'pending' THEN started_at + interval '10 minutes'
      ELSE processing_lease_expires_at
    END
WHERE updated_at IS NULL OR (status = 'pending' AND processing_lease_expires_at IS NULL);

UPDATE acu_logical_requests r
SET status = 'abandoned',
    completed_at = COALESCE(r.completed_at, now()),
    updated_at = now(),
    abandoned_at = now(),
    error_category = 'stale_processing',
    metadata_json = r.metadata_json || jsonb_build_object(
      'staleProcessingRecovered', true,
      'staleProcessingRecoveredAt', now(),
      'staleProcessingRecoveryVersion', 'active-request-lease-v1'
    )
WHERE r.status = 'pending'
  AND COALESCE(r.processing_lease_expires_at, r.started_at + interval '10 minutes') <= now()
  AND NOT EXISTS (
    SELECT 1 FROM acu_attempts a
    WHERE a.logical_request_id = r.logical_request_id AND a.status = 'started'
  );

ALTER TABLE acu_logical_requests
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE acu_logical_requests
  DROP CONSTRAINT IF EXISTS acu_logical_requests_newapi_user_id_ingress_idempotency_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_acu_active_trusted_request
  ON acu_logical_requests (newapi_user_id, ingress_idempotency_key)
  WHERE status = 'pending';

INSERT INTO acu_schema_migrations (migration_version)
VALUES ('0008_alpha_final_user_loop')
ON CONFLICT (migration_version) DO NOTHING;

COMMIT;
