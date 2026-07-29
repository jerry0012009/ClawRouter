# ACU Alpha RC2.1 Economics and Judge Audit

Date: 2026-07-30

## Cost Semantics

All Router candidate comparisons and Founder Alpha charging use cash CNY. Provider reconciliation retains Credits, while catalog prices remain nominal USD.

| Provider | Recharge basis | Credit cash cost | Channel multiplier | 1 nominal USD cash cost |
|---|---:|---:|---:|---:|
| Lucen active value Channel | ¥500 / 500 Credits | ¥1.00/Credit | 0.06 | ¥0.06 |
| BlackAI | ¥15 / 100 Credits | ¥0.15/Credit | channel-specific | unavailable for exact Judge model |
| CloseAI | ¥7.2 / 1 Credit | ¥7.20/Credit | 1.0 | ¥7.20 |

Lucen fixture: nominal `$0.139364` produces `0.00836184 Credits`, and therefore `¥0.00836184` effective Provider cash cost.

New API continues to convert `user_charge_cny / USDExchangeRate` into its global Quota unit. That value is an internal USD-equivalent only and is not displayed as ACU actual cash cost.

## Judge State Machine

- `plan_started`: new Planning Segment, one Judge call, `temporaryPhaseOverride=88`.
- Planning Tool/Function steps: reuse the Segment Evaluation.
- ordinary `plan_finished`: new Execution Segment, remove the override, reuse the prior Judge Evaluation.
- `plan_finished` with new human goal/constraint evidence: Judge.
- fixed `acceptedModelResponsesSinceJudge >= 16` refresh: removed from the production trigger path.
- 10-minute Routing Lease: retained.

## Judge Provider Audit

Production remains `model=deepseek-v4-flash`, economics Provider CloseAI. The ACU database contains 94 live CloseAI Judge records with reported Usage. CloseAI cash conversion is `¥7.20` per nominal USD.

Lucen directory discovery contains exact `deepseek-v4-flash` on an OpenAI-compatible 0.5x Channel and two Messages candidates. The existing Profile fixture is inactive and still lacks verified Context, Usage trust, tool/schema conformance, and actual-model evidence. Its theoretical cash conversion is `¥0.50` per nominal USD.

BlackAI's current directory has no exact `deepseek-v4-flash`; no alias was inferred and no call was made.

One permitted Lucen Preflight used the production Judge schema and no user code:

- JSON schema: valid;
- Difficulty Index: 9.0 (`raw=10.5`, confidence 0.99);
- Web Intent: `not_required` (confidence 0.99);
- latency: about 18.0 seconds;
- Usage: 6,643 prompt / 521 completion tokens as reported by Provider;
- nominal cost: `$0.00115275`;
- effective cash cost: approximately `¥0.000576375`;
- actual model: unavailable because the current Judge adapter does not retain the response `model` field.

The Preflight does not justify an automatic switch: latency is much higher than the current target, output Usage exceeded the requested 300-token cap as reported, and actual model remains unverified.

## Conclusion

No production Judge switch is recommended. Cache-aware routing should remain an offline research track until the evidence gaps listed in `cache-aware-routing-audit-20260730.md` are closed. Founder traffic can continue after deploying both RC2.1 commits and migrations.
