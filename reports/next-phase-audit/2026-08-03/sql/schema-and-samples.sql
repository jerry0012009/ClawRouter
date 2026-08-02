BEGIN READ ONLY;

-- Connection target and table discovery (run separately in acu_alpha and newapi_alpha).
SELECT current_database(), current_user, inet_server_addr(), inet_server_port();
SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;

-- ACU table columns used to adapt the audit to the deployed schema.
SELECT table_name,column_name,data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name IN (
  'acu_logical_requests','acu_admission_traces','acu_judge_evaluations','acu_judge_attempts',
  'acu_judge_ledger_entries','acu_provider_model_profile_health','acu_channel_health',
  'acu_route_decisions','acu_attempts','acu_profile_probe_queue','acu_profile_probe_attempts','acu_segments'
)
ORDER BY table_name,ordinal_position;

-- JSON key discovery only. Values and payload bodies are intentionally not selected.
SELECT 'logical' AS source,key,count(*) FROM acu_logical_requests,LATERAL jsonb_object_keys(metadata_json) key GROUP BY key
UNION ALL SELECT 'segment',key,count(*) FROM acu_segments,LATERAL jsonb_object_keys(metadata_json) key GROUP BY key
UNION ALL SELECT 'route',key,count(*) FROM acu_route_decisions,LATERAL jsonb_object_keys(formula_inputs_json) key GROUP BY key
UNION ALL SELECT 'attempt',key,count(*) FROM acu_attempts,LATERAL jsonb_object_keys(metadata_json) key GROUP BY key
ORDER BY source,key;

-- Current Luna runtime/probe snapshot.
SELECT execution_profile_id,channel_id,provider_id,protocol,circuit_state,cooldown_until,
 consecutive_failures,recent_success_rate,first_token_latency_ms,total_latency_ms,error_class,http_status,
 last_attempt_at,last_success_at,last_failure_at,usage_trusted,actual_model_verified,health_reason,updated_at
FROM acu_provider_model_profile_health
WHERE canonical_model_id='gpt-5.6-luna'
ORDER BY execution_profile_id;

SELECT q.execution_profile_id,q.enqueued_at,max(pa.completed_at) AS last_probe_at,
 (array_agg(pa.status ORDER BY pa.completed_at DESC NULLS LAST))[1] AS last_probe_status
FROM acu_profile_probe_queue q
LEFT JOIN acu_profile_probe_attempts pa USING(execution_profile_id)
GROUP BY q.execution_profile_id,q.enqueued_at ORDER BY q.enqueued_at;

-- Judge parser/transport classification from richer Segment metadata.
WITH runs AS (
 SELECT s.created_at,s.metadata_json->'judgeRun' AS run
 FROM acu_segments s WHERE s.created_at>=now()-interval '7 days'
 AND jsonb_typeof(s.metadata_json->'judgeRun'->'attempts')='array'
), attempts AS (
 SELECT r.*,a AS attempt FROM runs r CROSS JOIN LATERAL jsonb_array_elements(r.run->'attempts') a
)
SELECT coalesce(attempt->>'executionProfileId','not_persisted') AS execution_profile_id,
 coalesce(attempt->>'channel','not_persisted') AS channel,
 coalesce(attempt->>'endpointHost','not_persisted') AS endpoint_host,
 coalesce(attempt->>'errorCategory','none') AS error_category,
 coalesce(attempt->>'parserExceptionType','none') AS parser_exception_type,
 coalesce(attempt->>'httpStatus','0') AS http_status,
 count(*) AS attempts,round(avg((attempt->>'latencyMs')::numeric),1) AS average_latency_ms
FROM attempts
GROUP BY execution_profile_id,channel,endpoint_host,error_category,parser_exception_type,http_status
ORDER BY attempts DESC,execution_profile_id;

-- Trigger/Call/Reuse distribution. This is the source of request-level cohort semantics.
SELECT coalesce(metadata_json->>'trigger','missing') AS trigger,
 coalesce(metadata_json->>'judgeCalls','missing') AS judge_calls,
 coalesce(metadata_json->>'judgeReused','missing') AS judge_reused,count(*) AS requests
FROM acu_admission_traces WHERE created_at>=now()-interval '7 days'
GROUP BY trigger,judge_calls,judge_reused ORDER BY requests DESC;

-- Raw evaluation distribution retained as a compatibility reference, not used as New Judge rate denominator.
SELECT judge_status,judge_result_source,count(*) AS persisted_evaluations
FROM acu_judge_evaluations WHERE created_at>=now()-interval '7 days'
GROUP BY judge_status,judge_result_source ORDER BY persisted_evaluations DESC;

-- Desensitized technical sample selector. It never selects prompt, response or payload fields.
WITH base AS (
 SELECT lr.logical_request_id,lr.started_at,lr.status,lr.requested_model,
  s.metadata_json AS segment_meta,a.metadata_json AS admission_meta,
  je.judge_status,je.judge_result_source,je.difficulty_index,je.confidence,
  rd.formula_inputs_json AS formula,rd.selected_profile_json AS selected,
  count(pa.*) AS provider_attempts,bool_or(pa.status='error') AS provider_failure
 FROM acu_logical_requests lr JOIN acu_segments s USING(segment_id)
 LEFT JOIN acu_admission_traces a ON a.logical_request_id=lr.logical_request_id
 LEFT JOIN acu_judge_evaluations je ON je.judge_evaluation_id=a.judge_evaluation_id
 LEFT JOIN acu_route_decisions rd ON rd.route_decision_id=s.route_decision_id
 LEFT JOIN acu_attempts pa ON pa.logical_request_id=lr.logical_request_id AND pa.attempt_kind='provider'
 WHERE lr.started_at>=now()-interval '7 days'
 GROUP BY lr.logical_request_id,lr.started_at,lr.status,lr.requested_model,s.metadata_json,a.metadata_json,
  je.judge_status,je.judge_result_source,je.difficulty_index,je.confidence,rd.formula_inputs_json,rd.selected_profile_json
)
SELECT left(logical_request_id,10)||'...'||right(logical_request_id,4) AS request_mask,
 started_at,status,requested_model,admission_meta->>'trigger' AS trigger,
 admission_meta->>'judgeCalls' AS judge_calls,admission_meta->>'judgeReused' AS judge_reused,
 judge_status,judge_result_source,round(difficulty_index::numeric,2) AS difficulty,
 segment_meta->>'workPhase' AS work_phase,segment_meta->>'workPhaseQualityTargetOffset' AS phase_offset,
 formula->'decisionSnapshot'->>'selectedCandidateId' AS selected_candidate,
 formula->'decisionSnapshot'->>'selectedExecutionPresetId' AS selected_preset,
 selected->>'modelId' AS selected_model,selected->>'executionProfileId' AS selected_profile,
 provider_attempts,provider_failure
FROM base
WHERE judge_status='rules_fallback' OR admission_meta->>'judgeReused'='true'
 OR segment_meta->>'workPhase'='inspection' OR formula::text LIKE '%gpt-5.6-luna@max%'
 OR provider_attempts>1
ORDER BY started_at DESC;

COMMIT;
