BEGIN;

CREATE TABLE acu_sessions (
  session_id TEXT PRIMARY KEY,
  newapi_user_id TEXT NOT NULL,
  newapi_token_id TEXT,
  client_name TEXT NOT NULL,
  client_version TEXT,
  native_protocol TEXT NOT NULL CHECK (native_protocol IN ('responses', 'messages', 'chat_completions')),
  continuity_fingerprint TEXT,
  history_prefix_hash TEXT,
  system_fingerprint TEXT,
  tool_schema_fingerprint TEXT,
  last_tool_call_id TEXT,
  current_task_id TEXT,
  current_segment_id TEXT,
  last_activity_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_acu_sessions_user_updated
  ON acu_sessions (newapi_user_id, updated_at DESC);
CREATE INDEX idx_acu_sessions_user_history
  ON acu_sessions (newapi_user_id, history_prefix_hash);
CREATE INDEX idx_acu_sessions_user_tool
  ON acu_sessions (newapi_user_id, last_tool_call_id);

CREATE TABLE acu_tasks (
  task_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES acu_sessions(session_id),
  newapi_user_id TEXT NOT NULL,
  root_goal_text TEXT,
  root_goal_hash TEXT,
  phase TEXT NOT NULL,
  base_quality_target DOUBLE PRECISION NOT NULL,
  capability_escalation_floor DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_acu_tasks_user_session
  ON acu_tasks (newapi_user_id, session_id, updated_at DESC);

CREATE TABLE acu_segments (
  segment_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES acu_tasks(task_id),
  newapi_user_id TEXT NOT NULL,
  previous_segment_id TEXT REFERENCES acu_segments(segment_id),
  creation_reason TEXT NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'completed', 'blocked')),
  judge_evaluation_id TEXT,
  route_decision_id TEXT,
  selected_execution_profile_id TEXT,
  task_base_quality_target DOUBLE PRECISION NOT NULL,
  capability_escalation_floor DOUBLE PRECISION NOT NULL,
  temporary_phase_override DOUBLE PRECISION NOT NULL,
  effective_quality_target DOUBLE PRECISION NOT NULL,
  accepted_responses_since_judge INTEGER NOT NULL DEFAULT 0 CHECK (accepted_responses_since_judge >= 0),
  last_activity_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  superseded_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX uq_acu_active_segment_per_task
  ON acu_segments (task_id) WHERE status = 'active';
CREATE INDEX idx_acu_segments_user_task
  ON acu_segments (newapi_user_id, task_id, created_at DESC);

CREATE TABLE acu_logical_requests (
  logical_request_id TEXT PRIMARY KEY,
  newapi_user_id TEXT NOT NULL,
  newapi_token_id TEXT,
  newapi_log_id TEXT,
  session_id TEXT NOT NULL REFERENCES acu_sessions(session_id),
  task_id TEXT NOT NULL REFERENCES acu_tasks(task_id),
  segment_id TEXT NOT NULL REFERENCES acu_segments(segment_id),
  step_id TEXT,
  ingress_idempotency_key TEXT NOT NULL,
  request_protocol TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  request_payload_id TEXT,
  response_payload_id TEXT,
  selected_profile_id TEXT,
  accepted_attempt_id TEXT,
  status TEXT NOT NULL,
  had_tools BOOLEAN NOT NULL DEFAULT false,
  streaming BOOLEAN NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  error_category TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (newapi_user_id, ingress_idempotency_key)
);

CREATE INDEX idx_acu_logical_requests_user_started
  ON acu_logical_requests (newapi_user_id, started_at DESC);
CREATE INDEX idx_acu_logical_requests_trace
  ON acu_logical_requests (newapi_user_id, session_id, task_id, segment_id);

CREATE TABLE acu_payloads (
  payload_id TEXT PRIMARY KEY,
  newapi_user_id TEXT NOT NULL,
  logical_request_id TEXT REFERENCES acu_logical_requests(logical_request_id),
  attempt_id TEXT,
  payload_kind TEXT NOT NULL,
  protocol TEXT,
  content_type TEXT,
  headers_sanitized_json JSONB,
  body_json JSONB,
  body_text TEXT,
  body_sha256 TEXT NOT NULL,
  is_complete BOOLEAN NOT NULL,
  retention_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (body_json IS NOT NULL OR body_text IS NOT NULL)
);

CREATE INDEX idx_acu_payloads_request
  ON acu_payloads (newapi_user_id, logical_request_id, created_at);

CREATE TABLE acu_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES acu_sessions(session_id),
  task_id TEXT NOT NULL REFERENCES acu_tasks(task_id),
  segment_id TEXT REFERENCES acu_segments(segment_id),
  logical_request_id TEXT REFERENCES acu_logical_requests(logical_request_id),
  event_type TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  evidence_strength TEXT NOT NULL,
  source_protocol TEXT NOT NULL,
  source_client TEXT NOT NULL,
  source_client_version TEXT,
  source_payload_id TEXT REFERENCES acu_payloads(payload_id),
  tool_call_id TEXT,
  failure_signature TEXT,
  failure_signature_version TEXT,
  is_duplicate BOOLEAN NOT NULL DEFAULT false,
  occurred_at TIMESTAMPTZ NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (session_id, event_hash)
);

CREATE INDEX idx_acu_events_user_trace
  ON acu_events (task_id, segment_id, occurred_at);

CREATE TABLE acu_judge_evaluations (
  judge_evaluation_id TEXT PRIMARY KEY,
  newapi_user_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES acu_tasks(task_id),
  segment_id TEXT NOT NULL REFERENCES acu_segments(segment_id),
  trigger_event_id TEXT REFERENCES acu_events(event_id),
  judge_idempotency_key TEXT NOT NULL UNIQUE,
  judge_status TEXT NOT NULL,
  judge_result_source TEXT NOT NULL,
  judge_model TEXT,
  judge_provider TEXT,
  prompt_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  difficulty_method_version TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  context_token_estimate BIGINT,
  context_truncated BOOLEAN NOT NULL,
  input_payload_id TEXT REFERENCES acu_payloads(payload_id),
  output_payload_id TEXT REFERENCES acu_payloads(payload_id),
  difficulty_score_raw DOUBLE PRECISION,
  difficulty_index DOUBLE PRECISION,
  factors_json JSONB NOT NULL,
  probabilities_json JSONB NOT NULL,
  confidence DOUBLE PRECISION,
  judge_entropy DOUBLE PRECISION,
  evidence_tags_json JSONB NOT NULL,
  explanation TEXT,
  prompt_tokens BIGINT,
  completion_tokens BIGINT,
  latency_ms INTEGER,
  actual_cost_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  error_category TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_acu_judge_user_task
  ON acu_judge_evaluations (newapi_user_id, task_id, created_at DESC);

CREATE TABLE acu_route_decisions (
  route_decision_id TEXT PRIMARY KEY,
  newapi_user_id TEXT NOT NULL,
  segment_id TEXT NOT NULL REFERENCES acu_segments(segment_id),
  judge_evaluation_id TEXT REFERENCES acu_judge_evaluations(judge_evaluation_id),
  mode TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  routing_model_version TEXT NOT NULL,
  quality_curve_version TEXT NOT NULL,
  price_version TEXT NOT NULL,
  effective_quality_target DOUBLE PRECISION NOT NULL,
  formula_inputs_json JSONB NOT NULL,
  candidate_estimates_json JSONB NOT NULL,
  pareto_frontier_json JSONB NOT NULL,
  selected_profile_json JSONB NOT NULL,
  route_explanation TEXT,
  fallback_source TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_acu_routes_user_segment
  ON acu_route_decisions (newapi_user_id, segment_id, created_at DESC);

CREATE TABLE acu_attempts (
  attempt_id TEXT PRIMARY KEY,
  logical_request_id TEXT NOT NULL REFERENCES acu_logical_requests(logical_request_id),
  attempt_index INTEGER NOT NULL CHECK (attempt_index > 0),
  attempt_kind TEXT NOT NULL,
  retry_owner TEXT NOT NULL,
  route_decision_id TEXT REFERENCES acu_route_decisions(route_decision_id),
  judge_evaluation_id TEXT REFERENCES acu_judge_evaluations(judge_evaluation_id),
  execution_profile_id TEXT,
  requested_model TEXT,
  actual_model TEXT,
  provider TEXT NOT NULL,
  channel TEXT,
  provider_request_id TEXT,
  status TEXT NOT NULL,
  error_category TEXT,
  http_status INTEGER,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  usage_source TEXT,
  input_price_per_million NUMERIC(20,10),
  output_price_per_million NUMERIC(20,10),
  actual_cost_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  provider_billed BOOLEAN,
  latency_ms INTEGER,
  visible_output_bytes BIGINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (logical_request_id, attempt_index, attempt_kind),
  CHECK (attempt_kind <> 'provider' OR attempt_index <= 2)
);

CREATE INDEX idx_acu_attempts_request
  ON acu_attempts (logical_request_id, attempt_index);

ALTER TABLE acu_payloads
  ADD CONSTRAINT fk_acu_payload_attempt
  FOREIGN KEY (attempt_id) REFERENCES acu_attempts(attempt_id);

CREATE TABLE acu_usage_reports (
  usage_report_id TEXT PRIMARY KEY,
  newapi_user_id TEXT NOT NULL,
  newapi_token_id TEXT,
  newapi_log_id TEXT,
  logical_request_id TEXT NOT NULL UNIQUE REFERENCES acu_logical_requests(logical_request_id),
  report_idempotency_key TEXT NOT NULL UNIQUE,
  actual_model TEXT,
  provider TEXT,
  channel TEXT,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  judge_cost_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  provider_cost_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  failed_billed_cost_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  final_user_cost_usd NUMERIC(20,10) NOT NULL DEFAULT 0,
  cost_breakdown_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'acknowledged', 'failed')),
  send_attempt_count INTEGER NOT NULL DEFAULT 0,
  next_send_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ
);

CREATE INDEX idx_acu_usage_outbox
  ON acu_usage_reports (status, next_send_at, created_at);
CREATE INDEX idx_acu_usage_user
  ON acu_usage_reports (newapi_user_id, created_at DESC);

ALTER TABLE acu_sessions
  ADD CONSTRAINT fk_acu_session_task
  FOREIGN KEY (current_task_id) REFERENCES acu_tasks(task_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE acu_sessions
  ADD CONSTRAINT fk_acu_session_segment
  FOREIGN KEY (current_segment_id) REFERENCES acu_segments(segment_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE acu_segments
  ADD CONSTRAINT fk_acu_segment_judge
  FOREIGN KEY (judge_evaluation_id) REFERENCES acu_judge_evaluations(judge_evaluation_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE acu_segments
  ADD CONSTRAINT fk_acu_segment_route
  FOREIGN KEY (route_decision_id) REFERENCES acu_route_decisions(route_decision_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE acu_logical_requests
  ADD CONSTRAINT fk_acu_request_payload
  FOREIGN KEY (request_payload_id) REFERENCES acu_payloads(payload_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE acu_logical_requests
  ADD CONSTRAINT fk_acu_response_payload
  FOREIGN KEY (response_payload_id) REFERENCES acu_payloads(payload_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE acu_logical_requests
  ADD CONSTRAINT fk_acu_accepted_attempt
  FOREIGN KEY (accepted_attempt_id) REFERENCES acu_attempts(attempt_id) DEFERRABLE INITIALLY DEFERRED;

COMMIT;
