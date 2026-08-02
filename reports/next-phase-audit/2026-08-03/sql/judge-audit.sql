BEGIN READ ONLY;

-- Query 1: request-level Judge invocation and final result by audit window.
WITH windows(label, since, ordinal) AS (
  VALUES
    ('1h', now() - interval '1 hour', 1),
    ('24h', now() - interval '24 hours', 2),
    ('7d', now() - interval '7 days', 3)
), admissions AS (
  SELECT a.*,
    COALESCE((a.metadata_json->>'judgeCalls')::int, 0) AS judge_calls,
    COALESCE((a.metadata_json->>'judgeReused')::boolean, false) AS judge_reused,
    a.metadata_json->>'trigger' AS trigger
  FROM acu_admission_traces a
), per_attempt AS (
  SELECT judge_evaluation_id,
    count(*) AS attempt_count,
    bool_or(attempt_index = 1 AND status = 'success') AS first_attempt_success,
    bool_or(attempt_role = 'same_model_failover') AS same_model_failover,
    bool_or(attempt_role = 'backup') AS backup_used,
    sum(latency_ms) AS attempt_latency_ms,
    sum(effective_cost_cny) AS cost_cny,
    sum(effective_cost_cny) FILTER (WHERE status = 'error') AS failed_cost_cny,
    sum(effective_cost_cny) FILTER (WHERE attempt_role = 'backup') AS backup_cost_cny
  FROM acu_judge_attempts
  GROUP BY judge_evaluation_id
)
SELECT w.label,
  count(DISTINCT lr.logical_request_id) AS logical_requests,
  count(DISTINCT a.logical_request_id) FILTER (WHERE a.judge_calls > 0) AS judge_new,
  count(DISTINCT a.logical_request_id) FILTER (WHERE a.judge_calls = 0 AND a.judge_reused) AS judge_reused,
  count(DISTINCT lr.logical_request_id)
    - count(DISTINCT a.logical_request_id) FILTER (WHERE a.judge_calls > 0 OR a.judge_reused) AS no_judge_or_no_admission,
  round(100.0 * count(DISTINCT a.logical_request_id) FILTER (WHERE a.judge_calls > 0)
    / NULLIF(count(DISTINCT lr.logical_request_id), 0), 3) AS judge_new_rate_pct,
  round(100.0 * count(DISTINCT a.logical_request_id) FILTER (WHERE a.judge_calls = 0 AND a.judge_reused)
    / NULLIF(count(DISTINCT lr.logical_request_id), 0), 3) AS judge_reuse_rate_pct,
  round(avg(pa.attempt_count) FILTER (WHERE a.judge_calls > 0), 3) AS avg_attempts_per_new,
  count(DISTINCT a.logical_request_id) FILTER (WHERE a.judge_calls > 0 AND je.judge_status IN ('live','backup_live','cache_hit')) AS new_final_live,
  count(DISTINCT a.logical_request_id) FILTER (WHERE a.judge_calls > 0 AND je.judge_status = 'recent_evaluation') AS new_recent_evaluation,
  count(DISTINCT a.logical_request_id) FILTER (WHERE a.judge_calls > 0 AND je.judge_status = 'rules_fallback') AS new_rules_fallback,
  count(DISTINCT a.logical_request_id) FILTER (WHERE a.judge_calls > 0 AND je.error_category = 'judge_context_length_exceeded') AS context_terminal_failure
FROM windows w
LEFT JOIN acu_logical_requests lr ON lr.started_at >= w.since
LEFT JOIN admissions a ON a.logical_request_id = lr.logical_request_id
LEFT JOIN acu_judge_evaluations je ON je.judge_evaluation_id = a.judge_evaluation_id
LEFT JOIN per_attempt pa ON pa.judge_evaluation_id = je.judge_evaluation_id
GROUP BY w.label, w.ordinal
ORDER BY w.ordinal;

-- Query 2: final Judge status and result source for requests that actually ran Judge.
WITH windows(label, since, ordinal) AS (
  VALUES ('1h', now()-interval '1 hour', 1), ('24h', now()-interval '24 hours', 2), ('7d', now()-interval '7 days', 3)
)
SELECT w.label, je.judge_status, je.judge_result_source, count(DISTINCT a.logical_request_id) AS requests
FROM windows w
JOIN acu_admission_traces a ON a.created_at >= w.since
JOIN acu_judge_evaluations je ON je.judge_evaluation_id = a.judge_evaluation_id
WHERE COALESCE((a.metadata_json->>'judgeCalls')::int, 0) > 0
GROUP BY w.label, w.ordinal, je.judge_status, je.judge_result_source
ORDER BY w.ordinal, requests DESC;

-- Query 3: failover, latency and cost for requests that actually ran Judge.
WITH windows(label, since, ordinal) AS (
  VALUES ('1h', now()-interval '1 hour', 1), ('24h', now()-interval '24 hours', 2), ('7d', now()-interval '7 days', 3)
), runs AS (
  SELECT w.label, w.ordinal, a.logical_request_id, je.judge_evaluation_id, je.judge_status,
    coalesce(bool_or(ja.attempt_index = 1 AND ja.status = 'success'), false) AS first_attempt_success,
    coalesce(bool_or(ja.attempt_role = 'same_model_failover'), false) AS same_model_failover,
    coalesce(bool_or(ja.attempt_role = 'backup'), false) AS backup_used,
    COALESCE(sum(ja.latency_ms), 0) AS total_latency_ms,
    COALESCE(sum(ja.effective_cost_cny), 0) AS cost_cny,
    COALESCE(sum(ja.effective_cost_cny) FILTER (WHERE ja.status = 'error'), 0) AS failed_cost_cny,
    COALESCE(sum(ja.effective_cost_cny) FILTER (WHERE ja.attempt_role = 'backup'), 0) AS backup_cost_cny
  FROM windows w
  JOIN acu_admission_traces a ON a.created_at >= w.since
  JOIN acu_judge_evaluations je ON je.judge_evaluation_id = a.judge_evaluation_id
  LEFT JOIN acu_judge_attempts ja ON ja.judge_evaluation_id = je.judge_evaluation_id
  WHERE COALESCE((a.metadata_json->>'judgeCalls')::int, 0) > 0
  GROUP BY w.label, w.ordinal, a.logical_request_id, je.judge_evaluation_id, je.judge_status
)
SELECT label, count(*) AS judge_new,
  round(100.0 * avg(first_attempt_success::int), 3) AS first_attempt_success_pct,
  round(100.0 * avg(same_model_failover::int), 3) AS same_model_failover_pct,
  round(100.0 * avg(backup_used::int), 3) AS backup_rate_pct,
  round(100.0 * avg((judge_status IN ('live','backup_live','cache_hit'))::int), 3) AS final_live_success_pct,
  round(100.0 * avg((judge_status='rules_fallback')::int), 3) AS rules_fallback_pct,
  round(100.0 * avg((judge_status='recent_evaluation')::int), 3) AS recent_evaluation_fallback_pct,
  percentile_cont(.5) WITHIN GROUP (ORDER BY total_latency_ms) AS latency_p50_ms,
  percentile_cont(.95) WITHIN GROUP (ORDER BY total_latency_ms) AS latency_p95_ms,
  percentile_cont(.99) WITHIN GROUP (ORDER BY total_latency_ms) AS latency_p99_ms,
  round(sum(cost_cny), 10) AS total_cost_cny,
  round(avg(cost_cny), 10) AS average_new_judge_cost_cny,
  round(sum(failed_cost_cny), 10) AS failed_attempt_cost_cny,
  round(sum(backup_cost_cny), 10) AS backup_cost_cny,
  round(sum(cost_cny) FILTER (WHERE judge_status='rules_fallback'), 10) AS rules_fallback_prior_cost_cny,
  percentile_cont(.5) WITHIN GROUP (ORDER BY total_latency_ms) FILTER (WHERE judge_status='rules_fallback') AS rules_fallback_latency_p50_ms
FROM runs GROUP BY label, ordinal ORDER BY ordinal;

-- Query 4: error categories. Parser exception detail is not persisted in acu_judge_attempts.
WITH windows(label, since, ordinal) AS (
  VALUES ('1h', now()-interval '1 hour', 1), ('24h', now()-interval '24 hours', 2), ('7d', now()-interval '7 days', 3)
)
SELECT w.label, ja.provider, ja.model, ja.endpoint_host,
  COALESCE(ja.error_category, 'none') AS error_category,
  COALESCE(ja.http_status, 0) AS http_status,
  count(*) AS attempts,
  round(avg(ja.latency_ms), 1) AS average_latency_ms,
  round(sum(ja.effective_cost_cny), 10) AS cost_cny
FROM windows w
JOIN acu_judge_attempts ja ON ja.created_at >= w.since
GROUP BY w.label, w.ordinal, ja.provider, ja.model, ja.endpoint_host, error_category, http_status
ORDER BY w.ordinal, attempts DESC, provider, endpoint_host;

-- Query 5: profile attribution recovered from segment judgeRun metadata only.
WITH runs AS (
  SELECT s.segment_id, s.created_at, s.metadata_json->'judgeRun' AS run
  FROM acu_segments s
  WHERE s.created_at >= now()-interval '7 days' AND jsonb_typeof(s.metadata_json->'judgeRun'->'attempts')='array'
), attempts AS (
  SELECT runs.segment_id, runs.created_at, runs.run, value AS attempt
  FROM runs CROSS JOIN LATERAL jsonb_array_elements(runs.run->'attempts') value
)
SELECT COALESCE(attempt->>'executionProfileId','<not_persisted>') AS execution_profile_id,
  COALESCE(attempt->>'channel','<not_persisted>') AS channel,
  COALESCE(attempt->>'provider','<not_persisted>') AS provider,
  count(*) FILTER (WHERE (attempt->>'attemptIndex')::int=1) AS first_attempts,
  count(*) FILTER (WHERE attempt->>'status'='success') AS successes,
  count(*) FILTER (WHERE attempt->>'status'='error') AS failures,
  count(*) FILTER (WHERE attempt->>'role'='same_model_failover') AS failover_attempts,
  count(*) FILTER (WHERE run->>'selectedProfileId'=attempt->>'executionProfileId' AND attempt->>'status'='success') AS final_selected,
  max(created_at) FILTER (WHERE attempt->>'status'='success') AS last_success_at,
  round(avg((attempt->>'latencyMs')::numeric),1) AS average_latency_ms,
  percentile_cont(.5) WITHIN GROUP (ORDER BY (attempt->>'latencyMs')::numeric) AS latency_p50_ms,
  percentile_cont(.95) WITHIN GROUP (ORDER BY (attempt->>'latencyMs')::numeric) AS latency_p95_ms
FROM attempts
GROUP BY execution_profile_id, channel, provider
ORDER BY first_attempts DESC, failures DESC, execution_profile_id;

-- Query 6: current Luna profile runtime and current probe queue, read-only snapshots.
SELECT execution_profile_id, channel_id, provider_id, protocol, circuit_state, cooldown_until,
  consecutive_failures, recent_success_rate, first_token_latency_ms, total_latency_ms,
  error_class, http_status, last_attempt_at, last_success_at, last_failure_at,
  usage_trusted, actual_model_verified, health_reason, updated_at
FROM acu_provider_model_profile_health
WHERE canonical_model_id='gpt-5.6-luna'
ORDER BY execution_profile_id;

SELECT q.execution_profile_id, q.enqueued_at, max(pa.completed_at) AS last_probe_at,
  (array_agg(pa.status ORDER BY pa.completed_at DESC NULLS LAST))[1] AS last_probe_status
FROM acu_profile_probe_queue q
LEFT JOIN acu_profile_probe_attempts pa USING(execution_profile_id)
GROUP BY q.execution_profile_id, q.enqueued_at
ORDER BY q.enqueued_at;

COMMIT;
