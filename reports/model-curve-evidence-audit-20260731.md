# ACU Model Curve Evidence Audit - 2026-07-31

## Method

This audit cross-checks the routed catalog against independent broad capability, coding, agentic, and design-arena evidence. Benchmark index values are used only for relative placement between runs produced by the same methodology. They are not treated as request success probabilities.

Primary sources:

- OpenHands Index pinned 500-task SWE-bench aggregates already stored in the repository.
- Artificial Analysis Intelligence Index v4.1 effort-specific model pages.
- OpenRouter benchmark feed for Artificial Analysis intelligence, coding, agentic, and Design Arena dimensions.
- Official model cards for capability and harness caveats.

## Material Findings

| Model | Independent evidence | Existing anchor | Decision |
|---|---:|---:|---|
| Claude Fable 5 | AA 59.9, coding 76.5, agentic 52.8; OpenHands 95.8% with 500 tasks | 0.9580 | Retain. The AA run uses Opus 4.8 fallback, so it corroborates rather than replaces the direct OpenHands anchor. |
| Kimi K3 max | AA 57.1, coding 76.2, agentic 50.1; Design Arena mean rank 2.25 | 0.9305 | Retain the prior correction. It is close to Fable across independent dimensions and should remain frontier-shaped. |
| GPT-5.6 Sol medium | AA 53.5888; Sol high 55.8665, xhigh 57.6538, max 58.8898 | 0.8420 | Correct to 0.8953 using the medium-effort same-methodology gap to Fable. Do not apply max/xhigh evidence to ordinary requests. |
| GLM 5.2 high | AA 51.1, coding 68.8, agentic 43.1; Design Arena mean rank 8.19 | 0.7750 | Correct to 0.8703. The prior value was only a small GLM 5.1 family delta and materially understated current evidence. |
| Claude Opus 4.8 | AA 55.7, coding 74.3, agentic 47.2; direct OpenHands 83.8% | 0.8380 | Retain the direct Agent-harness anchor. The broad index confirms strong placement but does not justify replacing a direct 500-task result. |
| GPT-5.5 | AA 54.8, coding 74.9, agentic 44.9; direct OpenHands 78.2% | 0.7820 | Retain the direct Agent-harness anchor. |
| Gemini 3.5 Flash | AA 50.2, coding 70.1, agentic 37.4; direct OpenHands 78.6% | 0.7860 | Retain the direct Agent-harness anchor. |
| DeepSeek V4 Pro | AA 44.3, coding 59.4, agentic 36.4; direct OpenHands 73.2% | 0.7320 | Retain. Broad and repository-engineering benchmarks measure different task distributions. |
| DeepSeek V4 Flash | AA 40.3, coding 56.2, agentic 31.1 | 0.6720 | Retain the conservative Pro-relative curve. |
| Claude Sonnet 5 | AA 53.4, coding 71.5, agentic 46.7 | 0.7780 | Flag for future effort-matched validation. Current production Profiles advertise only low/medium/high while public leading runs use larger reasoning budgets. |
| GPT-5.6 Terra / Luna | AA max 55.0 / 51.2, with effort-dependent variation | 0.8120 / 0.7920 | Retain until a production-effort-matched comparison is available. Max scores must not be assigned to ordinary requests. |
| Kimi K2.7 Code / Qwen 3.7 Max | AA 41.9 / 46.0, with stronger coding than broad index placement | 0.7760 / 0.7620 | Retain coding-specialist shapes; broad composite alone would erase their documented specialization. |

## Sol xhigh Decision

Do not activate `gpt-5.6-sol-xhigh` as a separate routable model in this change.

The leaderboard evidence is real, but every currently declared Sol Execution Profile supports only `low`, `medium`, and `high`. Adding a second catalog identity without verified supply would create a candidate that cannot be recovered consistently and whose realized reasoning-token cost is not yet characterized.

The maintainable design is an inference preset, not a duplicated provider model:

1. Add a preset identity only after at least two recovery-capable Profiles verify `xhigh` and actual model identity.
2. Store `defaultReasoningEffort=xhigh` on the preset and inject it only when the client did not explicitly choose an effort.
3. Keep the provider model ID as `gpt-5.6-sol`; filter recovery by preset-compatible Profiles.
4. Give the preset its own quality curve and realized-cost observations because reasoning output volume changes cash cost even when nominal token rates do not.
5. Preserve explicit client effort. Never silently upgrade a direct `gpt-5.6-sol` request to xhigh.

This keeps the model catalog honest while leaving a small, testable path to add the xhigh option after supply verification.
