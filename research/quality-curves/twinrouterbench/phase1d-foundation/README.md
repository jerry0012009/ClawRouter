# TwinRouterBench Phase 1D foundation

## Technical summary

The frozen static release contains **970 step records from 520 instances**, spanning 5 benchmarks and 6 scenarios. Structural keys, tier IDs, step counts, GitHub/Hugging Face semantic equality, and Hugging Face Parquet core fields all pass. The dataset is usable for an offline Phase 1E router-to-tier comparison with an important boundary: **all 336 SWE-bench records explicitly identify themselves as weak `degradation_search_done` supervision**. The strong-label primary set therefore contains 634 rows; all 970 rows are retained for sensitivity analysis.

No Router, P2L, LLM Judge, model API, Docker workload, or production route was run. All monetary values and four example models are synthetic interface fixtures.

## Frozen sources and reproducibility

- GitHub `CommonstackAI/TwinRouterBench`: `430acecac71141de77afd8e5e13690d236d58e93`
- Hugging Face `Amorph/TwinRouterBench`: `c2907f006455d9d3b4bf69472a527536c7baa195`
- Paper: arXiv `2605.18859v2`
- Canonical GitHub `question_bank.jsonl`: `5b4f90c24643b214a9b0f26bf4e05afc742554262f4ef405e0b3b4a4cce503f4`
- Canonical GitHub `manifest.json`: `e575b8cc8e33bba993f2d1bcf09b4ee6940fbb098c9255a9c8e5ef7c6771e726`

Run online once, then replay without network:

```bash
python -m venv .cache/venv
.cache/venv/bin/pip install -r requirements.txt
.cache/venv/bin/python scripts/build_foundation.py
.cache/venv/bin/python scripts/build_foundation.py --offline
```

The script verifies every downloaded SHA-256 before parsing. It writes deterministic CSV, JSON, Markdown, Parquet, and PNG outputs. `.cache/` is gitignored.

## Label trust and analytical scope

| Pipeline stage | Rows | Treatment |
|---|---:|---|
| `ground_truth_ready` | 586 | Strong-label primary set |
| `mixed_model_validated` | 48 | Strong-label primary set, separately identifiable |
| `degradation_search_done` | 336 | Weak-label sensitivity only |

The paper describes released labels broadly as execution-verified estimates, while the SWE row notes explicitly say they are not `ground_truth_ready`. This audit follows the more granular row-level qualification. Weak labels are never rewritten, hidden, or silently promoted.

## Deterministic Router input views

| View | Median approx. tokens | P95 | Maximum | Truncated rows |
|---|---:|---:|---:|---:|
| `last_message_text` | 65.0 | 2658.0 | 14095 | 0 |
| `full_context_text` | 1830.5 | 10956.3 | 17778 | 0 |
| `acu_head_tail_context` | 1701.0 | 7597.4 | 8192 | 120 |

Approximate tokens are `ceil(characters / 4)`, not a provider tokenizer claim. `last_message_text` keeps the final visible role and tool name. `full_context_text` serializes all messages in source order with fixed role headers. `acu_head_tail_context` retains the system prompt, initial user task, and newest messages/tool results under an 8,192-token approximation using deterministic middle omission. It never summarizes or rewrites with an LLM.

## Leakage-safe partitions

The fixed seed is `20260726`. Record counts are train `586`, validation `218`, and test `166`. Assignment is benchmark-stratified and grouped by a leakage group that unifies every instance trajectory, identical normalized initial task, and conservative near-duplicate SimHash clusters. Five GroupKFold folds and leave-one-benchmark-out labels are stored per row. Validation confirms zero cross-split instances, trajectories, near-duplicate groups, or identical task signatures.

## API compatibility

ClawRouter's production parser was inspected read-only. It consumes OpenAI-style `messages` and `tools`, while BFCL exposes legacy top-level `functions`, so those rows require deterministic wrapping. Full counts and transformations are in `outputs/api_schema_mapping.md`. ClawRouter has 722 direct rows and 248 rows needing field conversion; none are unmappable. Cross-provider mappings flag nonstandard stored reasoning instead of pretending it can be replayed losslessly.

## ACU probability, cost, and session interfaces

`src/acu_curve_engine.py` validates four probabilities that sum to one, computes continuous difficulty, and emits monotone cumulative **predicted sufficiency** for low/mid/mid-high/high. These values are not concrete-model success rates. `src/acu_decision_engine.py` applies configured uncertainty, quality gates, fallback costs, and the Phase 2 validator projection. `src/acu_session_policy.py` provides a deterministic sticky policy that can escalate but not downgrade within an instance.

The Oracle one-hot conversion tests the product chain at thresholds 0.80, 0.90, and 0.95. It is not a Router result. Synthetic costs verify configuration-driven replay and comparison with always-high; they do not estimate production savings.

## Phase 2 benchmark-curve interface

`src/acu_benchmark_curve_fitter.py` fits `sigmoid(alpha - beta × difficulty)` with `beta > 0`, preventing local recovery. Aggregate-only scores identify alpha conditional on a shared/prior beta and explicitly set `slope_identified=false`; stratified inputs may fit both parameters. Aggregate-only uncertainty bands are 5.70× as wide on average as the synthetic stratified bands in this demo.

Model identity and capability-tier identity remain separate. The only demo IDs are `demo-economy`, `demo-value`, `demo-premium`, and `demo-frontier`; every associated score, date, provider, and price is marked synthetic.

## Four curve types are not interchangeable

1. **Oracle label curve:** deterministic one-hot transformation of released `target_tier`; used only to validate the ACU chain.
2. **Router prediction curve:** calibrated probabilities produced by RouteLLM/P2L or another Router; Phase 1E work, not generated here.
3. **Benchmark-fitted curve:** constrained curve inferred from independently sourced aggregate or stratified Benchmark evidence, with uncertainty and fit assumptions.
4. **Real execution experience curve:** empirical outcomes from actual model/task execution under a specified harness; no such curve is produced in Phase 1D.

Calling any of these simply a “quality curve” without its provenance is prohibited in this project.

## Limitations and next step

The static labels estimate cheapest sufficient capability tiers under the source's fixed pool and downgrade protocol. They do not identify current model probabilities, and four benchmarks in the strong set are not a substitute for dynamic SWE-bench validation. Proceed to Phase 1E conditionally under `outputs/phase1e_protocol.md`; keep SWE weak labels in sensitivity analysis and require later execution evidence before production use.

## Output map

Audit tables, the standardized Parquet, split manifest, Oracle decisions/session simulation, API mapping, protocol, go/no-go memo, synthetic Phase 2 curves, and all figures live under `outputs/`. `outputs/source_manifest.json` is the machine-readable source and runtime ledger; `outputs/audit_summary.json` is the machine-readable conclusion.
