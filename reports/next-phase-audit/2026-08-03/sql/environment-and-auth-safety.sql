BEGIN READ ONLY;

-- Run in each production database to record the logical target without credentials.
SELECT current_database(),current_user,inet_server_addr(),inet_server_port();
SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;

-- Run in newapi_alpha. It returns only counts and masked identity attributes.
SELECT count(*) AS total_users,
 count(*) FILTER (WHERE lower(username) LIKE '%test%' OR lower(display_name) LIKE '%test%' OR lower(email) LIKE '%test%') AS apparent_test_users
FROM users;

SELECT id,left(username,2)||'***' AS username_mask,left(coalesce(display_name,''),1)||'***' AS display_mask,
 role,status,CASE WHEN access_token IS NOT NULL AND length(trim(access_token))>0 THEN true ELSE false END AS has_dashboard_access_token,
 request_count
FROM users
WHERE lower(username) LIKE '%test%' OR lower(display_name) LIKE '%test%' OR lower(email) LIKE '%test%';

SELECT count(*) AS active_model_tokens,
 count(*) FILTER (WHERE coalesce(t.name,'') ILIKE '%test%' OR coalesce(t.name,'') ILIKE '%audit%') AS explicitly_labelled_test_or_audit
FROM tokens t JOIN users u ON u.id=t.user_id
WHERE (lower(u.username) LIKE '%test%' OR lower(u.display_name) LIKE '%test%' OR lower(u.email) LIKE '%test%')
 AND t.status=1;

COMMIT;
