UPDATE channels
SET models = 'acu-auto,gpt-5.4-mini,gpt-5.6-luna,gpt-5.6-terra,gpt-5.5,gpt-5.6-sol'
WHERE id = 1 AND name = 'ACU Responses Alpha';

INSERT INTO abilities ("group", model, channel_id, enabled, priority, weight, tag)
SELECT 'default', model_id, 1, true, 0, 0, 'acu-router'
FROM unnest(ARRAY['acu-auto','gpt-5.4-mini','gpt-5.6-luna','gpt-5.6-terra','gpt-5.5','gpt-5.6-sol']) AS model_id
ON CONFLICT ("group", model, channel_id) DO UPDATE SET enabled = true, tag = 'acu-router';

UPDATE tokens
SET model_limits_enabled = true,
    model_limits = 'acu-auto'
WHERE name = 'ACU Founder Codex'
  AND user_id = (SELECT id FROM users WHERE username = 'acu_founder');
