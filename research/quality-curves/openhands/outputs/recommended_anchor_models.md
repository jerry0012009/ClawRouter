# Recommended OpenHands anchor models

This list is selected by the audit script, not a hard-coded model allowlist. Eligibility requires a 2026 release, at least 99% Verified join coverage, at most 1% missing `resolved`, at most 1% missing `cost`, and positive observed mean cost. Selection then assigns one quality leader, one lowest-cost model, two additional value models (resolved rate / mean cost), and fills the quality range with overlap as a tie-breaker.

All selected models have 500 instances in common with every other selected model. Cost statistics include observed zero values and exclude only nulls.

| Model | Role | Release | Resolved | Mean cost | Median cost | Actual SWE-bench agent | Min selected overlap |
|---|---|---:|---:|---:|---:|---|---:|
| claude-fable-5 | high_quality | 2026-06-09 | 95.8% | 1.4319 | 1.1368 | v1.28.0 | 500 |
| DeepSeek-V4-Pro | low_cost | 2026-04-24 | 73.2% | 0.0395 | 0.0320 | v1.22.1 | 500 |
| MiniMax-M3 | value | 2026-06-01 | 76.4% | 0.1535 | 0.1125 | v1.24.0 | 500 |
| Minimax-2.7 | value | 2026-03-18 | 75.6% | 0.1795 | 0.1224 | v1.14.0 | 500 |
| Trinity-Large-Thinking | quality_gradient | 2026-04-01 | 56.8% | 0.6926 | 0.4720 | v1.16.1 | 500 |
| Nemotron-3-Super | quality_gradient | 2026-03-11 | 62.0% | 0.4663 | 0.3539 | v1.16.1 | 500 |
| Kimi-K2.5 | quality_gradient | 2026-01-27 | 68.8% | 0.4060 | 0.3212 | v1.8.3 | 500 |
| GLM-5 | quality_gradient | 2026-02-11 | 73.4% | 1.0423 | 1.0050 | v1.11.5 | 500 |

## Interpretation

The role labels are sampling roles, not product endorsements. `high_quality` anchors the top of the observed success range; `low_cost` anchors the observed cost floor; `value` models have high empirical resolved-rate-to-mean-cost ratios; gradient models broaden the success/cost range. Re-run the script when the pinned data revision changes rather than carrying this list forward manually.
