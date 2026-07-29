BEGIN;

DO $$
DECLARE constraint_name TEXT;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid='acu_attempts'::regclass
    AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%attempt_kind%attempt_index%2%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE acu_attempts DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;
ALTER TABLE acu_attempts ADD COLUMN IF NOT EXISTS network_endpoint TEXT;
ALTER TABLE acu_attempts ADD COLUMN IF NOT EXISTS channel_id TEXT;

CREATE TABLE IF NOT EXISTS acu_channel_health (
  channel_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  circuit_state TEXT NOT NULL CHECK (circuit_state IN ('healthy','degraded','open','half_open','disabled')),
  cooldown_until TIMESTAMPTZ,
  half_open_probe_in_flight BOOLEAN NOT NULL DEFAULT false,
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  recent_success_rate DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (recent_success_rate BETWEEN 0 AND 1),
  first_token_latency_ms DOUBLE PRECISION,
  total_latency_ms DOUBLE PRECISION,
  error_class TEXT,
  http_status INTEGER,
  external_status TEXT,
  external_availability_7d DOUBLE PRECISION,
  external_latency_ms DOUBLE PRECISION,
  external_observed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS acu_provider_model_profile_health (
  execution_profile_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  canonical_model_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  circuit_state TEXT NOT NULL CHECK (circuit_state IN ('healthy','degraded','open','half_open','disabled')),
  cooldown_until TIMESTAMPTZ,
  half_open_probe_in_flight BOOLEAN NOT NULL DEFAULT false,
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  recent_success_rate DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (recent_success_rate BETWEEN 0 AND 1),
  first_token_latency_ms DOUBLE PRECISION,
  total_latency_ms DOUBLE PRECISION,
  error_class TEXT,
  http_status INTEGER,
  actual_model_verified BOOLEAN NOT NULL DEFAULT false,
  usage_trusted BOOLEAN NOT NULL DEFAULT false,
  health_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_acu_channel_health_routing ON acu_channel_health (circuit_state,cooldown_until);
CREATE INDEX IF NOT EXISTS idx_acu_profile_health_routing ON acu_provider_model_profile_health (canonical_model_id,protocol,circuit_state,cooldown_until);

CREATE OR REPLACE VIEW acu_provider_health AS
SELECT provider_id,
  CASE
    WHEN bool_or(circuit_state IN ('healthy','degraded','half_open')) THEN
      CASE WHEN bool_or(circuit_state='healthy') THEN 'healthy' ELSE 'degraded' END
    WHEN bool_or(circuit_state='open') THEN 'open'
    ELSE 'disabled'
  END AS circuit_state,
  count(*) AS channel_count,
  count(*) FILTER (WHERE circuit_state IN ('healthy','degraded','half_open')) AS routable_channel_count,
  avg(recent_success_rate) AS recent_success_rate,
  max(updated_at) AS updated_at
FROM acu_channel_health GROUP BY provider_id;

COMMIT;
