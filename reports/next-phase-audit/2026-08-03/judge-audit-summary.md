# Production Judge audit

Audit query time: 2026-08-02 23:xx Europe/Berlin. Windows are rolling from query time. Primary rates use Admission Trace rows with explicit `judgeCalls > 0`, so Reuse is never counted as a failed invocation.

| Window | Logical requests | New Judge | Reused | First attempt success | Same-model failover | Final live | Recent-evaluation fallback | Rules fallback |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1h | 7 | 2 | 4 | 0/2 (0%) | 2/2 (100%) | 0 | 2 | 0 |
| 24h | 27 | 13 | 12 | 6/13 (46.154%) | 7/13 (53.846%) | 6 | 4 | 3 (23.077%) |
| 7d | 862 | 76 | 330 | 47/76 (61.842%) | 15/76 (19.737%) | 54 | 6 | 16 (21.053%) |

One 7d New Judge evaluation has no normalized Attempt row and is conservatively non-success in the first-attempt denominator. There are also 456 7d Logical Requests without current explicit New/Reuse Admission metadata, mainly older/legacy paths; they are not labeled Judge failures.

## Status and source

The auditable 7d New cohort is: 48 `live/upstream_live`, 6 `backup_live/upstream_live`, 6 `recent_evaluation/recent_evaluation`, 16 `rules_fallback/rules_strategy`. No disk-cache or safe-profile result occurred. The raw evaluation table contains 205 rows (142 live, 8 backup live, 16 recent, 39 rules), but 129 lack a current request-level `judgeCalls` linkage and are reported separately rather than mixed into rates.

## Error and stability finding

Judge is not continuously failing across the full week, but it is materially unstable and sharply worse in the latest windows. Final live success is 71.053% over 7d, 46.154% over 24h and 0% for the two New calls in 1h. The last two calls each exhausted three Luna Profile attempts and fell back to recent evaluation.

Most unstable Judge paths:

- Preferred `lucen-cx006-value-dynamic:gpt-5.6-luna:responses`: 40 first attempts, 23 successes, 17 failures; 12 timeouts and 5 HTTP 502 in richer Segment metadata.
- `blackai-codex-mix-low`: 17 failures, all `invalid_response/SyntaxError`, usually HTML rather than Judge JSON.
- `blackai-codex-mix-pro-fallback`: 17 failures with the same signature.

The two BlackAI Profiles are still runtime `healthy` with zero consecutive failures because Judge errors do not update the shared health records.

## Latency and cost

New Judge attempt-chain latency p50/p95/p99: 18.495s/18.552s/18.557s (1h), 16.434s/18.514s/18.549s (24h), 11.087s/24.956s/44.999s (7d). Seven-day Judge cost is CNY 1.9127420280, average CNY 0.0251676583 per auditable New call, failed-attempt cost CNY 0.5128750800, backup cost CNY 0.3024450000, and cost incurred on eventual rules-fallback runs CNY 0.2139739800. Rules-fallback chain latency p50 is 17.486s.

Zero-cost failures usually have no provider Usage. This does not mean they have zero latency or operational impact.

## Persistence limitations

`acu_judge_attempts` lacks `execution_profile_id`, `channel`, parser exception and backup reason columns. These are recoverable only from Segment `metadata_json.judgeRun` for newer rows. Consequently exact Profile aggregates combine normalized facts with metadata attribution and label legacy values `not_persisted`.

Full queries: `sql/judge-audit.sql`. Machine-readable summaries: the five CSV files in this directory.
