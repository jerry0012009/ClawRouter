BEGIN;

DROP VIEW IF EXISTS acu_provider_health;
DROP TABLE IF EXISTS acu_provider_model_profile_health;
DROP TABLE IF EXISTS acu_channel_health;
DROP TABLE IF EXISTS acu_usage_reports;
ALTER TABLE IF EXISTS acu_logical_requests DROP CONSTRAINT IF EXISTS fk_acu_accepted_attempt;
ALTER TABLE IF EXISTS acu_logical_requests DROP CONSTRAINT IF EXISTS fk_acu_response_payload;
ALTER TABLE IF EXISTS acu_logical_requests DROP CONSTRAINT IF EXISTS fk_acu_request_payload;
ALTER TABLE IF EXISTS acu_segments DROP CONSTRAINT IF EXISTS fk_acu_segment_route;
ALTER TABLE IF EXISTS acu_segments DROP CONSTRAINT IF EXISTS fk_acu_segment_judge;
ALTER TABLE IF EXISTS acu_sessions DROP CONSTRAINT IF EXISTS fk_acu_session_segment;
ALTER TABLE IF EXISTS acu_sessions DROP CONSTRAINT IF EXISTS fk_acu_session_task;
ALTER TABLE IF EXISTS acu_payloads DROP CONSTRAINT IF EXISTS fk_acu_payload_attempt;
DROP TABLE IF EXISTS acu_attempts;
DROP TABLE IF EXISTS acu_route_decisions;
DROP TABLE IF EXISTS acu_judge_evaluations;
DROP TABLE IF EXISTS acu_events;
DROP TABLE IF EXISTS acu_payloads;
DROP TABLE IF EXISTS acu_logical_requests;
DROP TABLE IF EXISTS acu_segments;
DROP TABLE IF EXISTS acu_tasks;
DROP TABLE IF EXISTS acu_sessions;

COMMIT;
