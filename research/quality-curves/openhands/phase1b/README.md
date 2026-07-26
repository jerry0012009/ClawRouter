# Phase 1B: RouteLLM difficulty validity on SWE-bench Verified

## Executive conclusion

**The result does not support using the pinned RouteLLM MF score as a SWE-bench difficulty signal in this experiment.** The raw strong-model-need score has essentially no association with empirical failure across 34 OpenHands models: Spearman ρ = **0.0051**, with a question-bootstrap 95% confidence interval of **[-0.0841, 0.0937]**. Only **1 of 34** model curves satisfies `Easy >= Medium >= Hard`; the median Easy-to-Hard success-rate change is a decline of just **0.60 percentage points**. Excluding the nine null `resolved` records changes ρ to 0.0024 and does not change the conclusion.

This is evidence about transfer to these 500 software-engineering prompts, not a general claim that RouteLLM is ineffective. There is also one material provenance limitation: direct OpenAI and OpenRouter access were unavailable, so embeddings were obtained from the user-configured closeai OpenAI-compatible gateway. The gateway returned model name `text-embedding-3-small` and 1536-dimensional vectors, but its upstream OpenAI snapshot cannot be independently attested from the API response. Therefore the statistical result is complete and reproducible from cache, while an official-endpoint replication remains necessary before a production decision.

No Completion or Responses API was called. The script never generated answers, used a gold patch, ran RouteLLM's chat interface, used cost in analysis, or changed production code.

## Frozen inputs and implementation

| Component | Frozen version |
|---|---|
| OpenHands Index | `OpenHands/openhands-index`, tag `v2026.06.30-3015ac6`, resolved HF commit `94ac78ad8ec547875a0a4ec56e15a644aa5653f6` |
| SWE-bench Verified | `SWE-bench/SWE-bench_Verified`, commit `91aa3ed51b709be6457e12d00300a6a596d4c6a3` |
| RouteLLM | official `lm-sys/RouteLLM`, commit `0b64fdafe049e596a3f5657c219329f24af24198` |
| Router/checkpoint | `mf`; `routellm/mf_gpt4_augmented`, revision `5eb3dc745cbe7cb16ca342ceb83b7f6ecf8c77c5` |
| Checkpoint SHA-256 | `bfc93d473b48f8b85ce719f0d7e8bb86a139fa052e8b0c3ac387eabf45e47293` |
| Original strong/weak semantics | `gpt-4-1106-preview` / `mixtral-8x7b-instruct-v0.1`, model IDs 24 / 36 |
| Embedding request | `text-embedding-3-small`, 1536 dimensions, closeai compatible gateway |
| Runtime | Python 3.12.3; exact package versions are in `requirements.txt` and `outputs/run_manifest.json` |

The script verifies the official RouteLLM source contract and uses an equivalent NumPy float32 implementation of the lower-level MF inference formula: normalize the frozen model embeddings, project the prompt embedding, calculate both logits, then apply `sigmoid(strong_logit - weak_logit)`. It does not invoke `chat.completions.create` or either routed model.

## Method

The joined matrix contains exactly 500 SWE-bench Verified questions, 34 models, and 17,000 model-question outcomes. Each raw `problem_statement` is hashed and is the only text sent for embedding. No gold patch, test result, repository content, or outcome field enters the score.

The five-question gate required five finite 1536-dimensional embeddings and audited every network request. It observed five `/v1/embeddings` requests and zero Completion requests. The full online pass cached each embedding and metadata atomically under ignored `.cache/`; the final offline pass made zero network requests and reproduced the principal CSV and JSON files byte-for-byte. The service reported 223,858 input tokens across all 500 embeddings, approximately **$0.0067** at the user-provided $0.03 per million-token rate. This operational estimate is not used in any validity analysis.

Questions are stably sorted by raw score into exactly 167 Easy, 166 Medium, and 167 Hard records. These labels mean score tertiles only; they are not asserted to be true difficulty. The primary outcome treats `resolved == true` as success and both `false` and null as not successful. The sensitivity analysis excludes null outcomes.

For overall validity, the analysis computes Spearman correlation between raw score and the failure proportion across all 34 models, with 10,000 question-level bootstrap resamples. It also reports score deciles, official-difficulty groups, Kruskal-Wallis comparison, and partial rank correlation after controlling for official difficulty. For every model it reports three success rates with Wilson 95% intervals, Easy-to-Hard change, monotonicity, score/success Spearman correlation, and failure ROC-AUC.

The pre-registered automated decision rule is:

- **Support:** bootstrap lower bound > 0, at least two thirds of models monotonic, and median Easy-to-Hard decline > 0.
- **Partial support:** positive point estimate with a positive upper confidence bound, at least half of models monotonic, and median decline > 0.
- **Not support:** otherwise.

## Core results

Raw scores range from **0.05796 to 0.49993** (P25 0.15496, median 0.19721, mean 0.20398, P75 0.24438). They are retained without normalization or reversal; percentile and tertile fields are display aids only.

| Test | Result |
|---|---:|
| Raw score vs cross-model failure Spearman ρ | 0.0051 |
| Bootstrap 95% CI | [-0.0841, 0.0937] |
| Partial ρ controlling official difficulty | 0.0158 |
| Partial bootstrap 95% CI | [-0.0735, 0.1047] |
| Raw score vs ordered official difficulty ρ | -0.0063 |
| Official-difficulty Kruskal-Wallis p | 0.5319 |
| Monotonic model curves | 1 / 34 |
| Median Easy-to-Hard decline | 0.60 pp |

The score does not add a stable ordering beyond official difficulty in this sample. The ten equal-count score deciles are also visibly non-monotonic: mean failure falls to 16.2% in decile 6 and rises again later. This pattern was reported as observed; no bins or models were changed after seeing it.

### Representative model curves

| Model | Easy | Medium | Hard | Easy→Hard decline |
|---|---:|---:|---:|---:|
| `claude-opus-4-8` | 85.0% | 85.5% | 80.8% | 4.19 pp |
| `GPT-5.5` | 79.0% | 80.7% | 74.9% | 4.19 pp |
| `Gemini-3.5-Flash` | 78.4% | 79.5% | 77.8% | 0.60 pp |
| `DeepSeek-V4-Pro` | 70.7% | 77.7% | 71.3% | -0.60 pp |
| `GLM-5.1` | 73.1% | 78.9% | 73.1% | 0.00 pp |
| `Kimi-K2.6` | 72.5% | 78.3% | 73.1% | -0.60 pp |
| `MiniMax-M3` | 74.9% | 78.9% | 75.4% | -0.60 pp |
| `Qwen3-Coder-Next` | 64.7% | 69.3% | 65.9% | -1.20 pp |

All eight representative curves are non-monotonic because Medium exceeds Easy. Of all 34 models, only `claude-opus-4-7` is monotonic. Complete model statistics remain in the CSV; the representative list affects figures only.

## Null sensitivity

Nine of 17,000 results have null `resolved`: three each for `DeepSeek-V3.2-Reasoner` and `Nemotron-3-Nano`, two for `Kimi-K2-Thinking`, and one for `Kimi-K2.5`. Excluding them changes aggregate ρ from **0.0051** to **0.0024**, leaves the monotonic count at 1/34, leaves the median Easy-to-Hard decline at 0.60 pp, and preserves the **not support** conclusion.

## Interpretation and next decision

These results are not sufficient to enter RouteLLM-backed production difficulty or cost routing. The immediate implication is to avoid treating this MF score as SWE-bench difficulty merely because its original semantics are “strong-model need.” Before rejecting the approach completely, replicate the 500 embeddings through an attestable official OpenAI or Azure OpenAI `text-embedding-3-small` deployment and compare per-question embeddings or scores. If that replication agrees, the negative transfer result is strong enough to stop this router/checkpoint for SWE-bench and evaluate a separately pre-registered router. If it differs materially, the gateway provenance—not the outcome data—must be resolved first.

Other embedding models cannot be substituted into this checkpoint: its learned `128 x 1536` text projection is tied to the `text-embedding-3-small` vector space. Using Qwen, BGE, Gemini, or even `text-embedding-3-large` would define a different, unvalidated experiment unless the MF model were retrained.

## Limitations

- The closeai gateway claims the requested model and returned the expected shape, but cannot prove the actual upstream provider or snapshot.
- RouteLLM's checkpoint was trained on general preference data and much older model semantics; SWE-bench issue resolution is a substantial domain shift.
- Official SWE-bench difficulty is highly imbalanced: only three questions have `>4 hours`, limiting comparisons at that level.
- OpenHands outcomes combine model and agent behavior. Phase 1A found actual agent-version differences across models, so the empirical rate is not a model-only construct.
- Wilson intervals quantify binomial sampling uncertainty within a model/bin; they do not remove dependence induced by shared questions or repositories.
- No cost fields enter this phase, so it provides no evidence for cost-aware routing.

## Reproduce

From this directory:

```bash
python3 -m venv .cache/venv
.cache/venv/bin/python -m pip install -r requirements.txt
.cache/venv/bin/python scripts/run_routellm_validation.py --mode preflight --embedding-gateway closeai
.cache/venv/bin/python scripts/run_routellm_validation.py --mode full --embedding-gateway closeai
.cache/venv/bin/python scripts/run_routellm_validation.py --mode full --embedding-gateway closeai --offline
```

For the closeai run, put `PROXY_BASE_URL` and `PROXY_API_KEY` in the repository's ignored `.env` file or environment. The script never prints or writes the key. `--embedding-gateway openrouter` instead reads `OPENROUTER_API_KEY`. Offline replay needs neither credential. A missing key, wrong input hash, wrong RouteLLM commit/checkpoint, unexpected embedding dimension, non-finite score, missing cache item, or non-embedding API request causes a non-zero exit.

## Outputs

- `question_routellm_scores.csv`: 500 raw scores, hashes, rank, percentile, and tertile.
- `question_empirical_difficulty.csv`: 500 cross-model outcome summaries.
- `model_difficulty_curves.csv`: 34 × 3 bin results with Wilson intervals.
- `model_validity_metrics.csv`: all 34 model correlations, AUCs, declines, and monotonicity.
- `aggregate_validation.json`: aggregate tests, bootstrap intervals, thresholds, and conclusion.
- `null_sensitivity_analysis.csv`: primary versus null-excluded comparison.
- `figures/`: four figures generated from the committed CSV files.
- `run_manifest.json`: immutable data, RouteLLM, checkpoint, runtime, request audit, hashes, and parameters.

Large source files, the RouteLLM checkout, checkpoint, virtual environment, embeddings, and request audit live under `.cache/` and are excluded from Git.
