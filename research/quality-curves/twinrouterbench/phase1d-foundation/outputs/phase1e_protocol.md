# Phase 1E frozen comparison protocol

## Purpose and frozen inputs

Phase 1E will compare three zero-shot router candidates on the frozen Phase 1D contexts. It may run **RouteLLM MF**, **RouteLLM BERT**, and **P2L 135M GRK** only. The two primary input views are `last_message_text` and `acu_head_tail_context`; `full_context_text` is retained for audit, not promoted to a primary test after results are seen.

The primary label set is the 634-row strong-label subset (`ground_truth_ready` plus `mixed_model_validated`). All 970 rows form the named sensitivity set; the 336 SWE-bench `degradation_search_done` rows remain weak supervision and must never be silently pooled into strict ground truth.

## Leakage-safe partitions

- Calibration is fit on `train` only.
- Hyperparameters and probability thresholds are selected on `validation` only.
- `test` is evaluated exactly once after the analysis plan is locked.
- Every partition and five-fold CV operation groups by `leakage_group_id`, which contains all steps of an instance/trajectory and deterministic near-duplicate initial-task clusters.
- External robustness uses five leave-one-benchmark-out evaluations. For holdout benchmark `b`, all rows with `lobo_holdout_benchmark == b` are test-only and all other benchmark rows are development data.
- No context text, feature, or calibration target may use future messages, trajectory outcome, target tier, pipeline stage, notes, benchmark score, or test-set statistics.

## Candidate order and frozen features

1. Evaluate RouteLLM MF alone.
2. Evaluate RouteLLM BERT alone.
3. Evaluate P2L alone.
4. Test a simple predeclared ensemble only if at least one individual router shows a positive validation signal.
5. Do not call an LLM Judge in Phase 1E.

RouteLLM uses its raw strong-model-need score, then an ordinal-logistic or isotonic calibration layer fitted on train to produce four tier probabilities. Calibration family and regularization are selected on validation.

P2L is restricted to four predeclared features: `unusable_fraction`, `negative_mean_beta`, `negative_median_beta`, and `beta_spread`. An ordinal-logistic calibration maps those features to four tier probabilities. No additional primary feature may be selected after test inspection.

## Zero-shot validity metrics

For each router × input-view pair report:

- Spearman and Kendall correlation with `target_tier_id`, with 10,000 instance-group bootstrap replicates and percentile 95% confidence intervals;
- observed tier distribution in predeclared equal-count router-score bins, preserving ties deterministically;
- ordinal ROC-AUC, defined as the macro mean of one-vs-threshold AUCs for `tier > 0`, `tier > 1`, and `tier > 2` when both classes exist;
- strong-label primary result, all-row weak-label sensitivity result, per-benchmark result, and leave-one-benchmark-out result.

## Calibration and product metrics

The four-class probabilities must sum to one and feed `acu_curve_engine.py` unchanged. Report Brier Score and Expected Calibration Error (10 equal-width confidence bins, with empty bins retained in the manifest). The product chain reports:

- **ROWPASS:** `predicted_tier_id >= target_tier_id`;
- **ROWEXACT:** exact tier match;
- **TRAJPASS:** every step in an instance passes;
- **COSTSAVE:** failure-aware theoretical cost saving under the frozen synthetic/verified catalog used for the experiment;
- **COMBINED:** the predeclared arithmetic mean of ROWPASS, ROWEXACT, TRAJPASS, and COSTSAVE;
- always-low and always-high controls.

Phase 1E must label catalog prices as synthetic unless independently verified price evidence is added under a new frozen source manifest. Oracle results from Phase 1D are chain tests and may not be compared as if they were measured router performance.

## Acceptance and decision rule

A candidate advances only if the test direction agrees with validation, uncertainty excludes a practically null effect under the predeclared threshold, calibration is not materially worse than controls, and the result is not driven solely by weak SWE labels or a single benchmark. Negative and mixed results remain reportable; binning, feature selection, label filtering, and ensemble construction cannot be revised after test inspection.
