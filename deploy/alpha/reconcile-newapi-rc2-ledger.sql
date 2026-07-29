BEGIN;

DO $rc2_cash_reconciliation$
DECLARE
  quota_adjustment INTEGER;
BEGIN
  UPDATE acu_usage_finalizes
  SET judge_cash_cost_cny='0.0071215200',
      actual_total_cash_cost_cny='0.0256624650',
      user_charge_cny='0.0256624650',
      final_user_cost_usd='0.0035154062',
      final_quota=1758,
      cost_breakdown_json=(
        cost_breakdown_json::jsonb
        || '{"judge_cash_cost_cny":0.00712152,"actual_total_cash_cost_cny":0.025662465,"user_charge":0.025662465,"user_charge_cny":0.025662465,"cash_reconciliation_source":"rc2_explicit_closeai_judge_economics"}'::jsonb
      )::text,
      updated_at=EXTRACT(EPOCH FROM now())::bigint
  WHERE report_idempotency_key='c8231a1eea30068db1a3c665b4228194d66c60c7968983aa5242f802964b9ec7'
    AND judge_cash_cost_cny='0.0009891000'
    AND actual_total_cash_cost_cny='0.0195300450'
    AND final_quota=1338
  RETURNING 1758-1338 INTO quota_adjustment;

  IF quota_adjustment IS NOT NULL THEN
    UPDATE users SET quota=quota-quota_adjustment WHERE id=3;
    UPDATE tokens SET remain_quota=remain_quota-quota_adjustment WHERE id=3 AND user_id=3;
    UPDATE logs
    SET quota=1758,
        other=(
          jsonb_set(
            COALESCE(NULLIF(other,''),'{}')::jsonb
              || '{"judge_cash_cost_cny":"0.0071215200","actual_total_cash_cost_cny":"0.0256624650","user_charge_cny":"0.0256624650","final_user_cost_usd":"0.0035154062","cash_reconciliation_source":"rc2_explicit_closeai_judge_economics"}'::jsonb,
            '{acu_cost_breakdown}',
            COALESCE(NULLIF(other,''),'{}')::jsonb->'acu_cost_breakdown'
              || '{"judge_cash_cost_cny":0.00712152,"actual_total_cash_cost_cny":0.025662465,"user_charge":0.025662465,"user_charge_cny":0.025662465,"cash_reconciliation_source":"rc2_explicit_closeai_judge_economics"}'::jsonb,
            true
          )
        )::text
    WHERE user_id=3 AND token_id=3 AND type=2
      AND request_id='202607292123231422434738268d9d66CjKQRB8';
  END IF;
END
$rc2_cash_reconciliation$;

COMMIT;
