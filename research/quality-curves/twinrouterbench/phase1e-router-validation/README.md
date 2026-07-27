# TwinRouterBench Phase 1E router validation

## Technical summary

This study is a **published-label product analysis** over all 970 released TwinRouterBench step labels. It is not a strict-ground-truth claim: 634 rows retain strong-label metadata and 336 SWE-bench rows retain `weak_degradation_search`. RouteLLM MF is classified **NO-GO** and P2L 135M is classified **NO-GO** under the pre-registered product gates. Stop general pretrained-router experiments and proceed to Phase 1F LLM Judge.

The full-context zero-shot ordinal AUC / Spearman values are 0.787 / 0.449 for RouteLLM MF and 0.844 / 0.531 for P2L. Full-minus-last-message ordinal-AUC changes are -0.048 and -0.023. These are associations with published tier labels, not measured model success probabilities.

## Frozen inputs and routers

- Phase 1D input: `../phase1d-foundation/outputs/acu_step_contexts.parquet`, SHA-256 `287ae2e5087bbd731c1513a81a94ccf936ad356c25ca3a78f652dcb91129b6e4`; its train/validation/test, `cv_fold`, `instance_id`, and `leakage_group_id` assignments are reused unchanged.
- RouteLLM MF: Git `0b64fdafe049e596a3f5657c219329f24af24198`, checkpoint `routellm/mf_gpt4_augmented` revision `5eb3dc745cbe7cb16ca342ceb83b7f6ecf8c77c5`, original strong/weak semantics `gpt-4-1106-preview` versus `mixtral-8x7b-instruct-v0.1`.
- RouteLLM embedding: `text-embedding-3-small`, 1536 dimensions, deterministic 8,191-token head-tail cap using `cl100k_base`. The compatible gateway is used only through `/embeddings`; completion calls are blocked and counted.
- P2L: Git `a905fa5ea94a75fdf157d73e27bd3c63ac1ebeb1`, model `lmarena-ai/p2l-135m-grk-01112025` revision `2b642ae1ce114fb54e468e4c676f122135bcf11b`; CPU FP32, four Torch threads, sequential inference, no quantization and no fine-tuning. Official chat formatting and tokenizer are retained, with deterministic head-tail truncation at 8,192 tokens and the CLS token preserved. PyTorch SDPA is used to keep long-context attention within the 7 GiB gate without changing model weights or precision.

The 1,940 RouteLLM context-view embeddings consumed 2,890,375 input tokens and cost an estimated USD 0.086711 at the user-supplied compatible-endpoint rate. Reconstructed API request latency is 76.2 seconds; because one batch latency is copied to each cache row, this is the sum of distinct `(view, batch latency)` values rather than an independent wall-clock trace. MF checkpoint loading peaked at 0.377 GiB RSS. Sequential P2L inference over 1,940 context views took 14388.8 seconds in summed per-record latency and peaked at 2.151 GiB RSS.

## Methods and metric definitions

`last_message` uses Phase 1D `last_message_text`; `full_agent_context` uses `acu_head_tail_context`. Raw RouteLLM evidence is the strong-model-need score. P2L's pre-registered primary score is `unusable_fraction`; complete 130-dimensional beta and eta outputs remain in `router_raw_scores.parquet`, and the three auxiliary features are fixed before test evaluation.

Ordinal ROC-AUC is the macro mean of AUC for `tier_id > 0`, `> 1`, and `> 2`. Zero-shot class metrics use the fixed score thresholds 0.25, 0.50, and 0.75; rank metrics and AUC use the untouched raw score. Confidence intervals use 10,000 `instance_id`-group bootstrap resamples. The balanced challenge uses whole instances, at most 49 rows per tier, and is never used for calibration or cost-savings estimates.

Calibration uses train only. RouteLLM compares regularized cumulative ordinal logistic and cumulative isotonic calibration; P2L uses the four pre-registered features in regularized cumulative ordinal logistic. Validation selects the method and regularization; test is evaluated once. `calibrated_probabilities.parquet` includes all 970 descriptive product estimates while `calibration_metrics.csv` explicitly separates held-out test from all-row, strong-label, and SWE-bench scopes.

## Main findings

- **RouteLLM MF:** full-context AUC 0.787, Spearman 0.449; context AUC delta -0.048; metadata-controlled AUC delta -0.005; balanced AUC 0.534; SWE-bench AUC 0.487.
- **P2L 135M:** full-context AUC 0.844, Spearman 0.531; context AUC delta -0.023; metadata-controlled AUC delta -0.002; balanced AUC 0.618; SWE-bench AUC 0.549.
- The calibrated probabilities sum to one and the ACU cumulative sufficiency relation is mechanically validated for every full-context row. Costs and model names come from the Phase 1D synthetic tier catalog, so cost savings are interface demonstrations rather than vendor-price or concrete-model evidence.

## Curve terminology

- **Oracle label curve:** one-hot released target tiers used only to validate the Phase 1D mechanics.
- **Router prediction curve:** raw RouteLLM/P2L score versus released labels.
- **Benchmark-fitted curve:** Phase 2 logistic capability curve fitted from separately sourced benchmark results; not produced here.
- **Real execution empirical curve:** measured success from actual model task execution; not available here.

These four curve types are not interchangeable. Phase 1E product outputs are labeled `published-label calibrated estimate` and are called predicted sufficiency or predicted attainment, never a concrete model's precise success rate.

## Limitations and robustness

The released labels are highly imbalanced and step position is strongly related to tier. The metadata baselines and augmented GroupKFold comparison therefore matter more than aggregate correlations alone. SWE-bench is weak supervision and is reported separately. Compatible-gateway embeddings advertise the frozen model and dimensions but do not independently attest the upstream OpenAI snapshot. Full-context head-tail views are already deterministically compressed by Phase 1D and may omit middle history; router-specific tokenization can truncate further.

## Reproduction

Use Python 3.12 and the pinned packages in `requirements.txt`. Create an ignored local environment and run:

```bash
python3 -m venv research/quality-curves/twinrouterbench/phase1e-router-validation/.cache/venv
research/quality-curves/twinrouterbench/phase1e-router-validation/.cache/venv/bin/pip install   -r research/quality-curves/twinrouterbench/phase1e-router-validation/requirements.txt
research/quality-curves/twinrouterbench/phase1e-router-validation/.cache/venv/bin/python   research/quality-curves/twinrouterbench/phase1e-router-validation/scripts/run_phase1e.py   --embedding-gateway closeai
```

The online run reads `PROXY_BASE_URL` and `PROXY_API_KEY` from environment or the ignored repository `.env`. No secret is printed or saved. After caches exist, remove credentials and run `--offline`; it performs no network request. The script exits on a missing cache, checksum mismatch, non-finite output, probability violation, leakage, non-embedding request, or memory-gate failure.

## Evidence map

Exact metrics are in the CSV/Parquet outputs, frozen provenance and dependencies in `source_manifest.json`, runtime/memory/cost evidence in `hardware_benchmark.json`, and the decision in `go_no_go.md`. Every PNG is regenerated from the committed CSV or Parquet outputs.
