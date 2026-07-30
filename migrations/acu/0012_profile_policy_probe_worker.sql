BEGIN;

CREATE TABLE IF NOT EXISTS acu_profile_probe_queue (
  execution_profile_id TEXT PRIMARY KEY,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS acu_probe_worker_lease (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  holder_id TEXT,
  lease_until TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO acu_probe_worker_lease (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

INSERT INTO acu_schema_migrations (migration_version)
VALUES ('0012_profile_policy_probe_worker')
ON CONFLICT (migration_version) DO NOTHING;

COMMIT;
