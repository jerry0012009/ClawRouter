BEGIN;

-- Recover the two live Judge calls proven by the durable Judge cache and the
-- matching New API error logs from the audited Founder session. The original
-- router failed before it could create any durable request or Judge record.
DO $audit_recovery$
BEGIN
IF EXISTS (
  SELECT 1 FROM acu_segments
  WHERE segment_id='seg_30f71b9ce3bf41ce82dfe6f88d17e40f'
) THEN
INSERT INTO acu_judge_evaluations
  (judge_evaluation_id,newapi_user_id,task_id,segment_id,trigger_event_id,
   judge_idempotency_key,judge_status,judge_result_source,judge_model,judge_provider,
   prompt_version,policy_version,difficulty_method_version,context_hash,
   context_token_estimate,context_truncated,difficulty_score_raw,difficulty_index,
   factors_json,probabilities_json,confidence,evidence_tags_json,explanation,
   prompt_tokens,completion_tokens,actual_cost_usd,created_at)
VALUES
  ('judge_audit_0e5c7bcc79622661','3','task_66805f7470a74c2d8d0c62058f942f2f',
   'seg_30f71b9ce3bf41ce82dfe6f88d17e40f',NULL,
   '0e5c7bcc79622661001e0fd3eae83c3d8af1fead46bb81895fec1bcf692100a7',
   'live','upstream_live','deepseek-v4-flash','openai_compatible',
   'acu-tier-requirement-v3','alpha-judge-policy-v1','acu-difficulty-index-v1',
   '0e5c7bcc79622661001e0fd3eae83c3d8af1fead46bb81895fec1bcf692100a7',
   6000,true,42.5,40.9,
   '{"reasoningDepth":4.2,"taskScope":5,"constraintDensity":3.5,"toolDependency":4.5,"verificationBurden":3,"contextBurden":3.8}'::jsonb,
   '{"pLow":0.18,"pMid":0.68,"pMidHigh":0.12,"pHigh":0.02}'::jsonb,
   0.85,'["repo_exploration","multi_step_plan","demo_creation"]'::jsonb,NULL,
   8009,149,0.00124605,'2026-07-29T18:50:50.886Z'),
  ('judge_audit_4b01ceb70c9fc866','3','task_66805f7470a74c2d8d0c62058f942f2f',
   'seg_30f71b9ce3bf41ce82dfe6f88d17e40f',NULL,
   '4b01ceb70c9fc8666344c1353251e24001c272b7b6cd0b173f6269c04ac7b15f',
   'live','upstream_live','deepseek-v4-flash','openai_compatible',
   'acu-tier-requirement-v3','alpha-judge-policy-v1','acu-difficulty-index-v1',
   '4b01ceb70c9fc8666344c1353251e24001c272b7b6cd0b173f6269c04ac7b15f',
   6000,true,42.5,40.6,
   '{"reasoningDepth":3.5,"taskScope":5,"constraintDensity":3.8,"toolDependency":4.5,"verificationBurden":4,"contextBurden":3.2}'::jsonb,
   '{"pLow":0.18,"pMid":0.68,"pMidHigh":0.12,"pHigh":0.02}'::jsonb,
   0.85,'["repo_exploration","multi_step_plan","demo_creation"]'::jsonb,NULL,
   8009,146,0.00124515,'2026-07-29T18:50:54.888Z')
ON CONFLICT (judge_idempotency_key) DO NOTHING;

INSERT INTO acu_logical_requests
  (logical_request_id,newapi_user_id,newapi_token_id,newapi_log_id,session_id,task_id,
   segment_id,ingress_idempotency_key,request_protocol,requested_model,status,had_tools,
   streaming,started_at,completed_at,error_category,metadata_json)
VALUES
  ('req_audit_0e5c7bcc79622661','3','3','202607291850461598076338268d9d6yqETcFvf',
   'ses_0548592665134f41925f27b6e33aa6ed','task_66805f7470a74c2d8d0c62058f942f2f',
   'seg_30f71b9ce3bf41ce82dfe6f88d17e40f','audit:20260729:0e5c7bcc79622661',
   'responses','acu-auto','error',true,true,'2026-07-29T18:50:46Z',
   '2026-07-29T18:50:50.886Z','context_length_exceeded',
   '{"recovery_source":"founder_session_audit_and_durable_judge_cache","original_http_status":502,"corrected_http_status":400}'::jsonb),
  ('req_audit_4b01ceb70c9fc866','3','3','202607291850511689837558268d9d6wFCOjtmO',
   'ses_0548592665134f41925f27b6e33aa6ed','task_66805f7470a74c2d8d0c62058f942f2f',
   'seg_30f71b9ce3bf41ce82dfe6f88d17e40f','audit:20260729:4b01ceb70c9fc866',
   'responses','acu-auto','error',true,true,'2026-07-29T18:50:51Z',
   '2026-07-29T18:50:54.888Z','context_length_exceeded',
   '{"recovery_source":"founder_session_audit_and_durable_judge_cache","original_http_status":502,"corrected_http_status":400}'::jsonb)
ON CONFLICT (logical_request_id) DO NOTHING;

INSERT INTO acu_admission_traces
  (admission_trace_id,admission_idempotency_key,newapi_user_id,logical_request_id,
   session_id,task_id,segment_id,judge_evaluation_id,request_protocol,requested_model,
   status,error_type,http_status,estimated_input_tokens,estimation_method,
   requested_max_output_tokens,reserved_output_tokens,safety_margin_tokens,
   required_total_context_tokens,maximum_available_context_tokens,
   candidate_context_limits_json,exclusion_counts_json,metadata_json,created_at,updated_at)
VALUES
  ('adm_audit_0e5c7bcc79622661','audit:20260729:admission:0e5c7bcc79622661','3',
   'req_audit_0e5c7bcc79622661','ses_0548592665134f41925f27b6e33aa6ed',
   'task_66805f7470a74c2d8d0c62058f942f2f','seg_30f71b9ce3bf41ce82dfe6f88d17e40f',
   'judge_audit_0e5c7bcc79622661','responses','acu-auto','rejected',
   'context_length_exceeded',400,32769,'historical_lower_bound_from_32768_exclusion',
   0,0,0,32769,32768,'{"legacy_active_responses_pool":32768}'::jsonb,
   '{"context_window":13,"tool_capability":0,"protocol":0,"web":0,"thinking":0,"health":0,"allowlist":0,"cost":0,"adapter":0}'::jsonb,
   '{"recovery_source":"founder_session_audit_and_durable_judge_cache","exact_request_token_estimate_available":false}'::jsonb,
   '2026-07-29T18:50:50.886Z','2026-07-29T18:50:50.886Z'),
  ('adm_audit_4b01ceb70c9fc866','audit:20260729:admission:4b01ceb70c9fc866','3',
   'req_audit_4b01ceb70c9fc866','ses_0548592665134f41925f27b6e33aa6ed',
   'task_66805f7470a74c2d8d0c62058f942f2f','seg_30f71b9ce3bf41ce82dfe6f88d17e40f',
   'judge_audit_4b01ceb70c9fc866','responses','acu-auto','rejected',
   'context_length_exceeded',400,32769,'historical_lower_bound_from_32768_exclusion',
   0,0,0,32769,32768,'{"legacy_active_responses_pool":32768}'::jsonb,
   '{"context_window":13,"tool_capability":0,"protocol":0,"web":0,"thinking":0,"health":0,"allowlist":0,"cost":0,"adapter":0}'::jsonb,
   '{"recovery_source":"founder_session_audit_and_durable_judge_cache","exact_request_token_estimate_available":false}'::jsonb,
   '2026-07-29T18:50:54.888Z','2026-07-29T18:50:54.888Z')
ON CONFLICT (admission_idempotency_key) DO NOTHING;
END IF;
END
$audit_recovery$;

-- The RC2 tables were introduced after these Evaluations existed. Preserve
-- their costs without pretending that unavailable historical admission token
-- estimates are known.
INSERT INTO acu_admission_traces
  (admission_trace_id,admission_idempotency_key,newapi_user_id,logical_request_id,
   session_id,task_id,segment_id,judge_evaluation_id,request_protocol,requested_model,
   status,estimated_input_tokens,estimation_method,requested_max_output_tokens,
   reserved_output_tokens,safety_margin_tokens,required_total_context_tokens,
   candidate_context_limits_json,exclusion_counts_json,metadata_json,created_at,updated_at)
SELECT
  'adm_legacy_' || substr(md5(e.judge_evaluation_id),1,24),
  'legacy:judge-evaluation:' || e.judge_evaluation_id,
  e.newapi_user_id,request.logical_request_id,t.session_id,e.task_id,e.segment_id,
  e.judge_evaluation_id,COALESCE(request.request_protocol,'legacy'),
  COALESCE(request.requested_model,'acu-auto'),
  CASE WHEN route.route_decision_id IS NULL THEN 'evaluating' ELSE 'admitted' END,
  0,'historical_unavailable',0,0,0,0,'{}'::jsonb,'{}'::jsonb,
  jsonb_build_object('recovery_source','rc2_historical_evaluation_backfill',
                     'historical_admission_metrics_available',false),
  e.created_at,e.created_at
FROM acu_judge_evaluations e
JOIN acu_tasks t ON t.task_id=e.task_id
LEFT JOIN LATERAL (
  SELECT l.logical_request_id,l.request_protocol,l.requested_model
  FROM acu_logical_requests l
  WHERE l.segment_id=e.segment_id
  ORDER BY abs(extract(epoch FROM (l.started_at-e.created_at))),l.logical_request_id
  LIMIT 1
) request ON true
LEFT JOIN LATERAL (
  SELECT r.route_decision_id FROM acu_route_decisions r
  WHERE r.judge_evaluation_id=e.judge_evaluation_id LIMIT 1
) route ON true
WHERE NOT EXISTS (
  SELECT 1 FROM acu_admission_traces a WHERE a.judge_evaluation_id=e.judge_evaluation_id
)
ON CONFLICT (admission_idempotency_key) DO NOTHING;

INSERT INTO acu_judge_ledger_entries
  (judge_ledger_entry_id,judge_evaluation_id,admission_trace_id,newapi_user_id,
   judge_provider,judge_model,prompt_tokens,completion_tokens,nominal_cost_usd,
   effective_cash_cost_cny,cost_source,created_at)
SELECT
  'ledger_legacy_' || substr(md5(e.judge_evaluation_id),1,24),e.judge_evaluation_id,
  admission.admission_trace_id,e.newapi_user_id,e.judge_provider,e.judge_model,
  COALESCE(e.prompt_tokens,0),COALESCE(e.completion_tokens,0),e.actual_cost_usd,
  CASE WHEN e.judge_result_source='upstream_live' THEN e.actual_cost_usd*7.2 ELSE 0 END,
  CASE WHEN e.judge_result_source='upstream_live'
    THEN 'historical_backfill:closeai-founder-settlement-cny-7.2-per-usd'
    ELSE 'historical_backfill:zero-cost-evaluation' END,
  e.created_at
FROM acu_judge_evaluations e
JOIN LATERAL (
  SELECT a.admission_trace_id FROM acu_admission_traces a
  WHERE a.judge_evaluation_id=e.judge_evaluation_id
  ORDER BY a.created_at,a.admission_trace_id LIMIT 1
) admission ON true
ON CONFLICT (judge_evaluation_id) DO NOTHING;

DO $audit_settlement$
BEGIN
IF EXISTS (
  SELECT 1 FROM acu_logical_requests
  WHERE logical_request_id='req_audit_0e5c7bcc79622661'
) THEN
INSERT INTO acu_usage_reports
  (usage_report_id,newapi_user_id,newapi_token_id,newapi_log_id,logical_request_id,
   report_idempotency_key,actual_model,provider,channel,input_tokens,
   cached_input_tokens,output_tokens,reasoning_tokens,judge_cost_usd,
   provider_cost_usd,failed_billed_cost_usd,final_user_cost_usd,cost_breakdown_json,
   status,send_attempt_count,next_send_at,created_at,nominal_provider_cost_usd,
   provider_balance_charge_usd,effective_provider_cash_cost_cny,judge_cash_cost_cny,
   failed_attempt_cash_cost_cny,actual_total_cash_cost_cny,user_charge_cny)
VALUES
  ('usage_audit_0e5c7bcc79622661','3','3','202607291850461598076338268d9d6yqETcFvf',
   'req_audit_0e5c7bcc79622661','audit:20260729:usage:0e5c7bcc79622661',
   'acu-auto','openai_compatible','admission',0,0,0,0,0.00124605,0,0,0,
   '{"billing_version":"founder-alpha-actual-cash-v2","recovery_source":"rc2_historical_judge_reconciliation","admission_error_type":"context_length_exceeded","admission_trace_id":"adm_audit_0e5c7bcc79622661","judge_evaluation_id":"judge_audit_0e5c7bcc79622661","judge_model":"deepseek-v4-flash","judge_nominal_cost_usd":0.00124605,"judge_cash_cost_cny":0.00897156,"actual_total_cash_cost_cny":0.00897156,"user_charge_cny":0.00897156}'::jsonb,
   'pending',0,now(),'2026-07-29T18:50:50.886Z',0,0,0,0.00897156,0,0.00897156,0.00897156),
  ('usage_audit_4b01ceb70c9fc866','3','3','202607291850511689837558268d9d6wFCOjtmO',
   'req_audit_4b01ceb70c9fc866','audit:20260729:usage:4b01ceb70c9fc866',
   'acu-auto','openai_compatible','admission',0,0,0,0,0.00124515,0,0,0,
   '{"billing_version":"founder-alpha-actual-cash-v2","recovery_source":"rc2_historical_judge_reconciliation","admission_error_type":"context_length_exceeded","admission_trace_id":"adm_audit_4b01ceb70c9fc866","judge_evaluation_id":"judge_audit_4b01ceb70c9fc866","judge_model":"deepseek-v4-flash","judge_nominal_cost_usd":0.00124515,"judge_cash_cost_cny":0.00896508,"actual_total_cash_cost_cny":0.00896508,"user_charge_cny":0.00896508}'::jsonb,
   'pending',0,now(),'2026-07-29T18:50:54.888Z',0,0,0,0.00896508,0,0.00896508,0.00896508)
ON CONFLICT DO NOTHING;
END IF;
END
$audit_settlement$;

-- Any live historical Judge without a Usage Report is a real cash cost even
-- when admission failed before Provider execution. Queue exactly one v2 cash
-- settlement against the closest original Logical Request and New API log.
INSERT INTO acu_usage_reports
  (usage_report_id,newapi_user_id,newapi_token_id,newapi_log_id,logical_request_id,
   report_idempotency_key,actual_model,provider,channel,input_tokens,
   cached_input_tokens,output_tokens,reasoning_tokens,judge_cost_usd,
   provider_cost_usd,failed_billed_cost_usd,final_user_cost_usd,cost_breakdown_json,
   status,send_attempt_count,next_send_at,created_at,nominal_provider_cost_usd,
   provider_balance_charge_usd,effective_provider_cash_cost_cny,judge_cash_cost_cny,
   failed_attempt_cash_cost_cny,actual_total_cash_cost_cny,user_charge_cny)
SELECT
  'usage_legacy_' || substr(md5(e.judge_evaluation_id),1,24),e.newapi_user_id,
  request.newapi_token_id,request.newapi_log_id,request.logical_request_id,
  'legacy:judge-settlement:' || e.judge_evaluation_id,'acu-auto',e.judge_provider,
  'admission',0,0,0,0,e.actual_cost_usd,0,0,0,
  jsonb_build_object(
    'billing_version','founder-alpha-actual-cash-v2',
    'recovery_source','rc2_historical_judge_reconciliation',
    'admission_error_type',COALESCE(request.error_category,'historical_failure'),
    'admission_trace_id',admission.admission_trace_id,
    'judge_evaluation_id',e.judge_evaluation_id,
    'judge_model',e.judge_model,
    'judge_nominal_cost_usd',e.actual_cost_usd,
    'judge_cash_cost_cny',e.actual_cost_usd*7.2,
    'actual_total_cash_cost_cny',e.actual_cost_usd*7.2,
    'user_charge_cny',e.actual_cost_usd*7.2),
  'pending',0,now(),e.created_at,0,0,0,e.actual_cost_usd*7.2,0,
  e.actual_cost_usd*7.2,e.actual_cost_usd*7.2
FROM acu_judge_evaluations e
JOIN LATERAL (
  SELECT l.logical_request_id,l.newapi_token_id,l.newapi_log_id,l.error_category
  FROM acu_logical_requests l
  WHERE l.segment_id=e.segment_id
    AND NOT EXISTS (
      SELECT 1 FROM acu_usage_reports existing
      WHERE existing.logical_request_id=l.logical_request_id
    )
  ORDER BY abs(extract(epoch FROM (l.started_at-e.created_at))),l.logical_request_id
  LIMIT 1
) request ON true
JOIN acu_judge_ledger_entries ledger ON ledger.judge_evaluation_id=e.judge_evaluation_id
JOIN acu_admission_traces admission ON admission.admission_trace_id=ledger.admission_trace_id
WHERE e.judge_result_source='upstream_live' AND e.actual_cost_usd>0
  AND NOT EXISTS (
    SELECT 1
    FROM acu_usage_reports settled
    JOIN acu_logical_requests settled_request
      ON settled_request.logical_request_id=settled.logical_request_id
    WHERE settled_request.segment_id=e.segment_id
      AND settled.judge_cost_usd=e.actual_cost_usd
  )
ON CONFLICT DO NOTHING;

-- The RC2 long-context gate completed at the Provider before exposing a
-- decoded-body header defect. Correct its Judge cash conversion after the
-- deployment made the Judge economics mapping explicit. New API applies the
-- corresponding idempotent quota adjustment in its own database.
UPDATE acu_judge_ledger_entries
SET effective_cash_cost_cny=0.0071215200,
    cost_source='closeai-deployment-fx-20260729-v1'
WHERE judge_evaluation_id='judge_38d639406920449c89d2889111b75538'
  AND effective_cash_cost_cny=0.0009891000;

UPDATE acu_usage_reports
SET judge_cash_cost_cny=0.0071215200,
    actual_total_cash_cost_cny=0.0256624650,
    user_charge_cny=0.0256624650,
    cost_breakdown_json=(cost_breakdown_json
      || '{"judge_cash_cost_cny":0.00712152,"actual_total_cash_cost_cny":0.025662465,"user_charge":0.025662465,"user_charge_cny":0.025662465,"cash_reconciliation_source":"rc2_explicit_closeai_judge_economics"}'::jsonb)
WHERE logical_request_id='req_5b0c27c84ae3439d982dac5f28c627c8'
  AND judge_cash_cost_cny=0.0009891000
  AND actual_total_cash_cost_cny=0.0195300450;

COMMIT;
