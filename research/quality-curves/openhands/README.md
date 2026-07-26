# OpenHands Index data audit

## Conclusion

The pinned OpenHands Index release is sufficient to begin a **controlled RouteLLM difficulty validation on SWE-bench Verified**, but not to treat model cost or agent version as fully interchangeable metadata. All 34 models have the same 500 SWE-bench instances, and all 500 `instance_id` values join exactly to the official SWE-bench Verified questions. This gives a complete paired model–question matrix of 17,000 rows with `problem_statement`, `difficulty`, and `repo` available after the join.

The main qualifications are: 17 models were actually evaluated with a SWE-bench agent version different from `default.sdk_version` and `metadata.json`; 9 `resolved` values and 25 costs are null; 134 costs are zero; and Gemini-3.1-Pro's published aggregate score differs by 0.2 percentage points from the mean of its 500 instance results. No scores or costs were imputed.

This directory is a data-only research artifact. The script does not run RouteLLM, call an LLM, or modify ClawRouter production code.

## Pinned official sources

| Source | Version used | Purpose |
|---|---|---|
| [OpenHands/openhands-index](https://huggingface.co/datasets/OpenHands/openhands-index) | tag `v2026.06.30-3015ac6`, resolved HF commit `94ac78ad8ec547875a0a4ec56e15a644aa5653f6` | `default` and `instances` configs |
| [OpenHands/openhands-index-results](https://github.com/OpenHands/openhands-index-results) | commit `3015ac612e7196f428e6e8a3948965d32d9a3331` | `metadata.json` and each `scores.json` |
| [SWE-bench/SWE-bench_Verified](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified) | commit `91aa3ed51b709be6457e12d00300a6a596d4c6a3` | 500 official questions and join fields |

The script uses immutable revision URLs and verifies all three Parquet files by SHA-256. Raw data and the upstream Git checkout live under `.cache/`, which is ignored by Git.

## Reproduce

From this directory:

```bash
python3 -m venv .cache/venv
.cache/venv/bin/python -m pip install -r requirements.txt
.cache/venv/bin/python scripts/audit_openhands_index.py
```

After one successful online run, the audit can be repeated without network access:

```bash
.cache/venv/bin/python scripts/audit_openhands_index.py --offline
```

The command exits non-zero for missing dependencies, download failures, checksum mismatches, unreadable Parquet/JSON, a wrong upstream commit, missing expected row counts, or insufficient anchor candidates. It regenerates every file in `outputs/` deterministically except the `generated_at_utc` timestamp in the JSON summary.

## Data shape and join

The `instances` config contains 40,643 rows. Only SWE-bench enters the first quality-curve candidate set.

| Benchmark | Rows | Models | Union instances | Common to all models | Identical sets? |
|---|---:|---:|---:|---:|---|
| swe-bench | 17,000 | 34 | 500 | 500 | yes |
| swt-bench | 14,572 | 34 | 433 | 295 | no |
| gaia | 5,538 | 34 | 165 | 100 | no |
| swe-bench-multimodal | 2,989 | 34 | 103 | 65 | no |
| commit0 | 544 | 34 | 16 | 16 | yes |

The official Verified table has 500 unique `instance_id` values and no missing `instance_id`, `problem_statement`, `difficulty`, or `repo`. The OpenHands SWE-bench union joins 500/500 (100%), and every individual model joins 500/500. Every one of the 561 model pairs has 500 shared instances; the 34-way intersection is also 500.

## SWE-bench model coverage and missingness

Every model has 500 rows and 100% Verified join coverage. Only models with any null or zero value are listed below; all omitted models have zero missing `resolved`, zero missing cost, and zero zero-cost rows. Complete per-model score, aggregate cost, counts, rates, mean, median, P25, P75, and P95 are in `outputs/model_coverage.csv`.

| Model | `resolved` null | Cost null | Cost zero | Missing-rate note |
|---|---:|---:|---:|---|
| DeepSeek-V3.2-Reasoner | 3 | 0 | 0 | resolved 0.6% |
| Gemini-3.5-Flash | 0 | 2 | 0 | cost 0.4% |
| Gemini-3.1-Pro | 0 | 1 | 0 | cost 0.2% |
| Gemini-3-Pro | 0 | 2 | 0 | cost 0.4% |
| GLM-5.1 | 0 | 2 | 0 | cost 0.4% |
| GLM-4.7 | 0 | 2 | 0 | cost 0.4% |
| GLM-5 | 0 | 0 | 95 | zero cost 19.0% |
| Kimi-K2-Thinking | 2 | 2 | 0 | resolved/cost 0.4% |
| Kimi-K2.5 | 1 | 0 | 0 | resolved 0.2% |
| claude-sonnet-4-6 | 0 | 1 | 21 | cost null 0.2%; zero 4.2% |
| Qwen3-Coder-Next | 0 | 9 | 18 | cost null 1.8%; zero 3.6% |
| Qwen3.5-Flash | 0 | 1 | 0 | cost 0.2% |
| Trinity-Large-Thinking | 0 | 3 | 0 | cost 0.6% |
| Nemotron-3-Nano | 3 | 0 | 0 | resolved 0.6% |

Across SWE-bench there are 12,285 `true`, 4,706 `false`, and 9 null `resolved` values; 16,975 non-null costs, 25 null costs, 134 zero costs, and no negative costs. Cost quantiles use linear interpolation over non-null observations. Zero values are retained because the source records them as observed values.

## Score and version audit

The published score is interpreted as a percentage. For 33 models it agrees with `100 × resolved_true / 500` within 0.1 percentage points. Gemini-3.1-Pro is the exception: published `76.8`, observed `77.0`, delta `-0.2` percentage points. Models with null `resolved` still match a denominator of 500, indicating that the upstream aggregate effectively treats null as non-success rather than dropping it. Downstream code should preserve the null flag and explicitly pre-register this convention.

`default.sdk_version` and `metadata.json.agent_version` agree for all 34 models. However, they both disagree with the actual SWE-bench record in `scores.json.agent_version` for 17 models:

`claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `GPT-5.4`, `Gemini-3.5-Flash`, `Gemini-3.1-Pro`, `GLM-5.1`, `MiniMax-M3`, `Kimi-K2.6`, `Qwen3.6-Plus`, `MiniMax-M2.5`, `Qwen3-Coder-Next`, `GLM-4.7`, `DeepSeek-V4-Pro`, `Qwen3.5-Flash`, and `Nemotron-3-Super`.

The actual evaluation version in this audit is therefore always the SWE-bench record from `scores.json`; metadata is never substituted for it. The upstream repository also has an extra `results/Minimax-2.7` directory not selected by the pinned default ID `OpenHands/MiniMax-M2.7`; the script matches directories by exact default ID suffix to avoid that ambiguity.

## Automatically selected anchors

The script selected eight 2026 models using completeness thresholds followed by objective quality, cost-efficiency, cost-floor, and gradient coverage. The names are output, not an input allowlist.

| Model | Sampling role | Resolved rate | Mean cost | Actual SWE-bench agent |
|---|---|---:|---:|---|
| claude-fable-5 | high quality | 95.8% | 1.4319 | v1.28.0 |
| DeepSeek-V4-Pro | low cost | 73.2% | 0.0395 | v1.22.1 |
| MiniMax-M3 | value | 76.4% | 0.1535 | v1.24.0 |
| Minimax-2.7 | value | 75.6% | 0.1795 | v1.14.0 |
| Trinity-Large-Thinking | quality gradient | 56.8% | 0.6926 | v1.16.1 |
| Nemotron-3-Super | quality gradient | 62.0% | 0.4663 | v1.16.1 |
| Kimi-K2.5 | quality gradient | 68.8% | 0.4060 | v1.8.3 |
| GLM-5 | quality gradient | 73.4% | 1.0423 | v1.11.5 |

All selected pairs overlap on all 500 questions. These roles are experimental sampling roles, not model endorsements. See `outputs/recommended_anchor_models.md` for the exact eligibility and selection logic.

## Data-quality findings

- No duplicate `(model, benchmark, instance_id)` records and no conflicting repeated results were found in 40,643 rows.
- SWE-bench model instance sets are identical. Three out-of-scope benchmarks have unequal model instance sets: GAIA, SWE-bench Multimodal, and SWT-bench.
- The SWE-bench question join is complete and its four required question fields are non-null.
- Missing outcomes are small but real and must not be imputed. A binary curve should use `resolved is true` as success while retaining a missingness indicator.
- Cost is less clean than outcome: nulls and particularly 134 zeros require a documented treatment before any cost-aware routing objective.
- Agent version is a material confounder: half the models' actual SWE-bench agent version differs from the index-level version.

## RouteLLM readiness and remaining decisions

The data is sufficient for a first paired **difficulty-only** validation because question coverage and overlap are complete and the binary success field is directly observed. Before generating a quality or cost curve:

1. Use `scores.json` SWE-bench `agent_version` as the actual version and decide whether cross-version agent comparisons are acceptable.
2. Pre-register `resolved is true` as success and retain null outcomes; do not silently impute them.
3. Determine whether zero costs mean cached/free executions or instrumentation failure, and define how they enter cost fitting.
4. Keep Gemini-3.1-Pro's aggregate discrepancy visible; derive difficulty evidence from instance rows, not the aggregate.
5. Freeze the anchor algorithm and pinned revisions for the experiment so the candidate set is reproducible.

## Outputs

- `model_coverage.csv`: all 34 models, aggregate and instance-derived score/cost/coverage statistics.
- `model_pair_overlap.csv`: all 561 pairwise common-instance counts and rates.
- `swebench_joined_sample.csv`: 200 deterministic joined rows across multiple models and questions.
- `sdk_version_audit.csv`: index, metadata, and actual SWE-bench versions side by side.
- `data_quality_issues.csv`: machine-readable warnings, informational zero-cost findings, and errors if present.
- `recommended_anchor_models.md`: generated anchor list and selection rationale.
- `audit_summary.json`: full source manifest, counts, findings, model records, anchors, and readiness decision.
