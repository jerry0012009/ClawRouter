UPDATE channels
SET models = 'acu-auto,claude-fable-5,claude-opus-4-8,claude-sonnet-5,deepseek-v4-flash,gemini-2.5-flash,glm-5.1,glm-5.2,gpt-5.4-mini,gpt-5.5,gpt-5.6-luna,gpt-5.6-sol,gpt-5.6-terra,kimi-k2.6,kimi-k2.7-code,kimi-k3',
    header_override = '{"*":""}'
WHERE id = 1 AND name = 'ACU Responses Alpha';

INSERT INTO abilities ("group", model, channel_id, enabled, priority, weight, tag)
SELECT 'default', model_id, 1, true, 0, 0, 'acu-router'
FROM unnest(ARRAY['acu-auto','claude-fable-5','claude-opus-4-8','claude-sonnet-5','deepseek-v4-flash','gemini-2.5-flash','glm-5.1','glm-5.2','gpt-5.4-mini','gpt-5.5','gpt-5.6-luna','gpt-5.6-sol','gpt-5.6-terra','kimi-k2.6','kimi-k2.7-code','kimi-k3']) AS model_id
ON CONFLICT ("group", model, channel_id) DO UPDATE SET enabled = true, tag = 'acu-router';

INSERT INTO models
  (model_name, description, tags, status, sync_official, created_time, updated_time, name_rule)
SELECT model_id, 'ACU Founder Alpha routing-active canonical model', 'ACU,Tool Call,Reasoning,Routing Active',
       1, 0, EXTRACT(EPOCH FROM now())::bigint, EXTRACT(EPOCH FROM now())::bigint, 0
FROM unnest(ARRAY['acu-auto','claude-fable-5','claude-opus-4-8','claude-sonnet-5','deepseek-v4-flash','gemini-2.5-flash','glm-5.1','glm-5.2','gpt-5.4-mini','gpt-5.5','gpt-5.6-luna','gpt-5.6-sol','gpt-5.6-terra','kimi-k2.6','kimi-k2.7-code','kimi-k3']) AS model_id
WHERE NOT EXISTS (
  SELECT 1 FROM models existing
  WHERE existing.model_name = model_id AND existing.deleted_at IS NULL
);

UPDATE models
SET status = 1, sync_official = 0, updated_time = EXTRACT(EPOCH FROM now())::bigint
WHERE model_name IN ('acu-auto','claude-fable-5','claude-opus-4-8','claude-sonnet-5','deepseek-v4-flash','gemini-2.5-flash','glm-5.1','glm-5.2','gpt-5.4-mini','gpt-5.5','gpt-5.6-luna','gpt-5.6-sol','gpt-5.6-terra','kimi-k2.6','kimi-k2.7-code','kimi-k3')
  AND deleted_at IS NULL;

UPDATE tokens
SET model_limits_enabled = true,
    model_limits = 'acu-auto,claude-fable-5,claude-opus-4-8,claude-sonnet-5,deepseek-v4-flash,gemini-2.5-flash,glm-5.1,glm-5.2,gpt-5.4-mini,gpt-5.5,gpt-5.6-luna,gpt-5.6-sol,gpt-5.6-terra,kimi-k2.6,kimi-k2.7-code,kimi-k3'
WHERE name = 'ACU Founder Codex'
  AND user_id = (SELECT id FROM users WHERE username = 'acu_founder');

-- This host also runs development workloads. Host-wide CPU sampling would
-- reject all relay traffic when an unrelated build or test saturates CPU.
-- Persist both controls so CPU protection stays off across fresh deployments
-- and remains disabled even if the aggregate monitor is later re-enabled.
INSERT INTO options (key, value)
VALUES
  ('performance_setting.monitor_enabled', 'false'),
  ('performance_setting.monitor_cpu_threshold', '0')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Founder opts into the new cost-first preference explicitly. Existing users
-- retain balanced behavior through the application default.
UPDATE users
SET setting = (
  COALESCE(NULLIF(setting, ''), '{}')::jsonb
  || '{"acu_routing_preference":"economy"}'::jsonb
)::text
WHERE username = 'acu_founder';
