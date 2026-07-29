# ACU Judge Candidate Bake-off: MiMo

Date: 2026-07-30

## Executive conclusion

Recommendation: **`keep_current`**. A small production Shadow is **not recommended yet**.

The candidate is conclusively the exact Xiaomi `mimo-v2.5-pro`. It returned strict JSON for all 30 primary samples and had no timeouts, but only 23/30 responses passed the production ACU Judge Schema. All seven failures exceeded the 80-character `explanation` limit. On the 13 schema-valid historical comparisons, the candidate changed the selected canonical model 3 times (23.08%), and Planning stability varied by as much as 13.8 Difficulty points.

No production Judge, Router, routing parameters, environment variables, or provider profiles were changed. The current DeepSeek results are comparison data, not asserted ground truth.

## 1. Production deployment

| Check | Result |
|---|---|
| ClawRouter source HEAD | `14f6916410732b50e0eb1cdf27a15382c5ad1f4c` |
| New API source HEAD | `50ac356e56bf1e1cc094e78928a30141ac19c464` |
| Exact running image commits | Not provable: the images have no embedded Git SHA label |
| RC2.1 actually deployed | **No** |
| `0006_rc21_cost_semantics.sql` applied | **No** |
| `codex-acu doctor` | Healthy; Codex 0.146.0, isolated `CODEX_HOME`, effective model `acu-auto` |

Runtime evidence is decisive even though exact image commits are unavailable: the running Router bundle still contains the fixed `acceptedModelResponsesSinceJudge >= 16` refresh, its image includes migrations only through `0005_rc2_judge_reconciliation.sql`, and the production `acu_usage_reports` table lacks the three RC2.1 columns checked from migration 0006.

## 2. Candidate identity

| Field | Observed value |
|---|---|
| Requested `codex-mi` executable | Not present on current `PATH` |
| Actual launcher | `/usr/local/bin/codex-mi-1` |
| Launcher SHA256 | `2ca7c2e2c0f9089428abc76ebb20a3ccf57d36f2f8c45eddc0cb660908b5378c` |
| `CODEX_HOME` | `/root/.codex-mi-1` |
| Codex version | `0.146.0` |
| Codex binary SHA256 | `134063e133f0b4244fa3b251acf973d4fe4b4aeeacbdc135211bf480f59f1477` |
| Configured model | `mimo-v2.5-pro` |
| Actual response model | `mimo-v2.5-pro` |
| Provider / owner | Xiaomi MiMo / `xiaomi` |
| Base URL | `https://token-plan-cn.xiaomimimo.com/v1` |
| Configured Codex wire API | `responses` |
| Bake-off transport | Direct `chat/completions` |
| Configured reasoning effort | `high` |
| Judge thinking | Disabled, matching production |

The Provider model directory and every evaluated API response reported the exact model ID. This is not a name-derived alias. Judge calls were made directly to the underlying API; the Codex CLI was not used. The `chat/completions` call was a transport-only adaptation.

## 3. Protocol conformance

The candidate used the production Judge system prompt and current prompt version `acu-tier-requirement-v4`, the same input fields and JSON Schema, `temperature=0`, `max_tokens=300`, 20-second timeout semantics, 6,000-token context truncation, JSON-object response format, disabled thinking, and concurrency 1.

The production comparison was `deepseek-v4-flash` through CloseAI, using existing durable Judge Cache and PostgreSQL results only. No new paid DeepSeek baseline calls were made.

## 4. Evaluation set

The primary set contains 20 deduplicated historical Judge input snapshots and 10 deterministic, non-sensitive fixtures. It covers simple tasks, ordinary and multi-file coding, Planning, Execution, Recovery, long context, explicit Web/no-Web cases, repeated capability failure, and English, Chinese, and mixed-language inputs. Only hashed sample IDs and categories appear in this report; no prompt body, user code, or Secret is included.

There were 94 historical Judge evaluations, of which 92 yielded eligible unique snapshots. A compatibility caveat matters: 93/94 production records use prompt v3, while this bake-off replayed their actual input snapshots under current v4. The old v3 rows do not persist Web Intent, so historical Web agreement is **not comparable**, not 0%. The deterministic explicit Web/no-Web fixtures passed 10/10.

## 5. Results

| Metric | Result |
|---|---:|
| Strict JSON | 30/30, 100% |
| Production Schema | 23/30, 76.67% |
| Timeout | 0/30, 0% |
| Latency p50 | 4,449 ms |
| Latency p95 | 7,214.5 ms |
| Deterministic Web Intent | 10/10, 100% |
| Historical Difficulty mean delta | -6.085 points |
| Historical Difficulty MAE | 8.715 points |
| Difficulty rank Spearman | 0.918 |

All seven Schema failures were valid JSON but had `explanation` longer than the production 80-character limit. No extra prose or response truncation was observed.

Across all 58 transport calls, including preflight, diagnostics, 30 primary evaluations, and 10 stability repeats, usage was 259,640 input tokens, 124,352 cached input tokens, and 10,244 output tokens. Nominal cost at published rates was `$0.0682102272`.

## 6. Cost semantics

This credential uses a Xiaomi Token Plan. The API response does not expose Provider Credits deducted, and authenticated purchase/quota records needed to allocate recharge cash were not available locally. Therefore:

- observed Provider Credits: **unknown**;
- actual cash cost CNY: **unknown**;
- official pay-as-you-go equivalent upper bound: **¥0.4704368**;
- allowed budget: **¥1.0**, not exceeded.

The budget bound used published MiMo-V2.5-Pro prices per 1M tokens: cached input ¥0.025, uncached input ¥3, and output ¥6. The ¥0.4704368 figure is a conservative pay-as-you-go equivalent, not observed Token Plan Credits and not an asserted actual cash cost.

## 7. Difficulty and routing impact

Only the 13 schema-valid historical results are comparable. Three would change the final model selection:

| Sanitized sample | Difficulty current -> MiMo | Selection current -> MiMo | Estimated cost delta |
|---|---:|---|---:|
| `hist-f8397a51a4d2` | 47.8 -> 56.9 | `gpt-5.6-luna` -> `gpt-5.6-terra` | +¥0.02227687 |
| `hist-096b2a86c611` | 54.0 -> 37.1 | `gpt-5.6-terra` -> `gpt-5.6-luna` | -¥0.01679997 |
| `hist-acff2f2dd4fa` | 66.0 -> 44.0 | `claude-opus-4-8` -> `gpt-5.6-luna` | -¥0.10223831 |

The selection-change rate is 3/13 (23.08%). Across all 13 comparable samples, including unchanged selections and the candidate Judge cost estimate, the modeled aggregate delta is +¥0.00171542.

Largest review-worthy Difficulty disagreements were 44.0 -> 20.0 on Planning, 66.0 -> 44.0 on long Execution, 54.0 -> 37.1 on Execution, 72.1 -> 55.6 on Planning, and 47.8 -> 56.9 on Execution. MiMo tends lower on several broad Planning/Execution samples, while rank ordering remains strong. These are disagreements for human review, not errors adjudicated against DeepSeek as truth.

## 8. Stability

Five samples were called twice. Greeting remained schema-valid with a 0.2-point Difficulty range and stable `not_required` Web Intent. BTC remained schema-valid with a 4.3-point range and stable `required` Web Intent. Planning remained schema-valid but ranged 13.8 points. The long-context and Recovery historical samples remained strict JSON but showed Schema failures caused by length conformance. No run emitted extra text or showed truncation.

## 9. Recommendation

Use **`keep_current`**. MiMo is the exact requested candidate and has acceptable latency, perfect strict-JSON syntax, strong Difficulty rank correlation, and correct deterministic Web behavior. It is not ready as primary, backup, or production Shadow because production Schema conformance is only 76.67%, comparable selections change 23.08%, Planning variance is material, and actual Token Plan cash allocation is not observable.

Do not start a small production Shadow yet. The next useful gate is an offline schema-conformance study, including whether Provider-native strict JSON Schema can enforce field lengths without changing the shared Judge criteria. Production `ACU_JUDGE_*` configuration remains unchanged.
