# Phase 1E go / no-go decision

## Decision: conditional GO

Proceed to the offline RouteLLM/P2L comparison using the frozen protocol, but treat the result as router-to-tier-label validity—not model execution quality.

## Why it is sufficient

- All `970` static rows are structurally valid, have unique row and `(instance_id, step_index)` keys, and map consistently to the Hugging Face Parquet representation.
- `634` rows across BFCL, mtRAG, QMSum, and PinchBench meet the Phase 1D strong-label rule and can support the primary analysis.
- Grouped 60/20/20, five-fold GroupKFold, and leave-one-benchmark-out manifests prevent steps from one trajectory or near-duplicate task cluster crossing partitions.
- Both Phase 1E router views are deterministic and capped; no model-generated summary is involved.

## Guardrails that remain mandatory

- The `336` SWE-bench rows are `degradation_search_done` weak supervision and belong only in sensitivity analysis.
- Static target tiers are execution-verified estimates under the source protocol, not concrete-model probabilities or current production success rates.
- The synthetic tier catalog validates interfaces only. Real cost conclusions require separately frozen and verified prices.
- Any Phase 1E signal must later survive dynamic execution or another independent outcome dataset before production routing claims are made.

## No-go triggers during Phase 1E

Stop promotion if test metrics reverse validation direction, leave-one-benchmark results are unstable, probability calibration fails, or apparent gains disappear when weak SWE labels are excluded.
