# Phase 2 synthetic benchmark curve interface

## Status and boundary

Every catalog row and price used here is explicitly **synthetic**. The demo does not contain or imply a verified score for a real model. The only permitted example model IDs are `demo-economy`, `demo-value`, `demo-premium`, and `demo-frontier`.

## Curve contract

The V1 benchmark-fitted curve is `sigmoid(alpha_model - beta_model * difficulty)`, with difficulty and quality in `[0, 1]` and a strict `beta_model > 0` constraint. Consequently every emitted curve is monotonically non-increasing and cannot locally recover at higher difficulty.

- Aggregate-only scores calibrate alpha against the published task-difficulty distribution while beta comes from a domain-shared value or declared prior. `slope_identified=false`; the result must not be described as an identified model slope.
- Stratified scores fit alpha and beta jointly under the same positive-beta bounds.
- The output stores benchmark score, domain-adjusted score, difficulty prior, weighted fit error, parameter constraints, beta source, confidence label, and all fitted parameters.

## Uncertainty contract

The interface accepts benchmark-score error, beta-prior bounds, numeric source confidence, and a domain-match discount. It emits `quality_estimate`, `quality_lower`, and `quality_upper` at every difficulty. In this frozen demo, aggregate-only mean interval width is `0.3989`, versus `0.0700` for synthetic stratified inputs—a `5.70x` ratio.

## Identity separation

`model_id` and `mapped_capability_tier` are separate columns. Capability tiers (`low`, `mid`, `mid_high`, `high`) are durable policy labels; a model can be remapped as verified benchmark and price evidence changes. The engine does not encode a permanent tier-to-model identity.

## Fallback projection

The demo uses a configurable validator detection rate marked `synthetic_assumption`. Final quality and expected total cost follow the Phase 2 equations implemented in `src/acu_decision_engine.py`. They are projections, not observed execution results.
