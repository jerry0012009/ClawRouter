# ACU Cache-aware Routing Offline Audit

Date: 2026-07-30  
Mode: offline replay only  
Production Routing Formula: unchanged

## Method

The replay uses read-only ACU database aggregates and the versioned model catalog. All compared costs are effective cash CNY. The offline formula is:

```text
uncached_input * input_price
+ cached_read * cached_input_price
+ estimated_cache_write * cache_write_price
+ output * output_price
+ judge_cost
+ expected_fallback_cost
+ cache_break_cost
```

The sampled OpenAI-compatible Usage records expose cached reads but no separately billed cache-write quantity, so `estimated_cache_write=0`. No sampled successful path had a billed fallback Attempt. Different Provider or different model has zero cache affinity; same model on a different Channel remains low/unknown.

## Results

| Session | Requests / Segments | Input / Cached / Uncached | Hit ratio | Model / Channel switches | Production estimate | Cache-aware | Difference | Selection |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Founder chuxin | 21 / 7 | 402,886 / 351,360 / 51,526 | 87.21% | 0 / 0 | ¥0.09665916 | ¥0.07768572 | -¥0.01897344 (-19.63%) | unchanged |
| RC2 411,967 Token | 1 / 1 | 411,967 / 0 / 411,967 | 0% | 0 / 0 | ¥0.025662465 | ¥0.025662465 | ¥0 | unchanged |
| Existing multi-Step | 13 / 2 | 200,770 / 170,125 / 30,645 | 84.74% | 1 / 0 | ¥7.53026328 | ¥2.01821328 | -¥5.51205 (-73.20%) | unchanged |

The Founder Session remained on `lucen-cx006-value-dynamic:gpt-5.6-luna:responses`, so its observed cache affinity reinforces the existing choice. The long-context request had no cached input. The other multi-Step Session switched from Terra to Sol at a Planning boundary but stayed on the same CloseAI Channel; the first Sol request was a miss and the next 11 requests established a high hit rate. The lower cache-aware cost does not reverse the quality-driven Sol choice.

## Decision

No sampled Segment changes selection. This is evidence that cache accounting materially improves cost estimates, not evidence that production routing weights should change.

Routing v0.4 is not recommended yet. The sample is too small, cache-write billing is not observable, cross-Channel affinity is unverified, fallback/cache-break costs are not calibrated, and no decision boundary reversal was observed. More controlled multi-Session replay is required before changing the production formula.
