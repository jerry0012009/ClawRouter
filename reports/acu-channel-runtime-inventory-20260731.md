# ACU Channel Runtime Inventory - 2026-07-31

Source: versioned `deploy/alpha/execution-profiles.json`, production `acu_channel_health`, loaded adapter/economics wiring, and environment variable names. Secret values are excluded.

## Runtime matrix

| canonicalModel | provider | channel | endpointHost | enabled | administratorAllowed | adapterLoaded | economicsAvailable | usageTrusted | localHealth | monitorHealth | recentSuccessRate | consecutiveFailures | cooldownUntil | p50FirstModelEventLatency | p95FirstModelEventLatency | lastSuccessAt | lastFailureAt |
|---|---|---|---|---:|---:|---:|---:|---:|---|---|---:|---:|---|---|---|---|---|
| gpt-5.6-luna | blackai | blackai-codex-mix-low | blackaicoding.com | yes | yes | yes | yes | yes | healthy | unavailable | 0.9965 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 14:55:52Z | 2026-07-30 09:35:45Z |
| gpt-5.6-sol | blackai | blackai-codex-mix-low | blackaicoding.com | yes | yes | yes | yes | yes | healthy | unavailable | 0.9965 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 14:55:52Z | 2026-07-30 09:35:45Z |
| gpt-5.6-terra | blackai | blackai-codex-mix-low | blackaicoding.com | yes | yes | yes | yes | yes | healthy | unavailable | 0.9965 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 14:55:52Z | 2026-07-30 09:35:45Z |
| gpt-5.4-mini | lucen | lucen-cx006-value-dynamic | lucen.cc | yes | yes | yes | yes | yes | healthy | unavailable | 0.9646 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 14:52:23Z | 2026-07-30 07:12:36Z |
| gpt-5.6-luna | lucen | lucen-cx006-value-dynamic | lucen.cc | yes | yes | yes | yes | yes | healthy | unavailable | 0.9646 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 14:52:23Z | 2026-07-30 07:12:36Z |
| gpt-5.6-terra | lucen | lucen-cx006-value-dynamic | lucen.cc | yes | yes | yes | yes | yes | healthy | unavailable | 0.9646 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 14:52:23Z | 2026-07-30 07:12:36Z |
| gpt-5.6-luna | lucen | lucen-cx006-plus | lucen.cc | yes | yes | yes | yes | yes | healthy | unavailable | 1.0000 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 09:36:11Z | - |
| gpt-5.6-luna | lucen | lucen-cx008-plus-dedicated | lucen.cc | yes | yes | yes | yes | yes | healthy | unavailable | 1.0000 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 07:14:30Z | - |
| gpt-5.4-mini | closeai | closeai-openai-primary | api.openai-proxy.org | yes | yes | yes | yes | yes | healthy | unavailable | 1.0000 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 07:12:42Z | - |
| gpt-5.6-luna | closeai | closeai-openai-primary | api.openai-proxy.org | yes | yes | yes | yes | yes | healthy | unavailable | 1.0000 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 07:12:42Z | - |
| gpt-5.6-terra | closeai | closeai-openai-primary | api.openai-proxy.org | yes | yes | yes | yes | yes | healthy | unavailable | 1.0000 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 07:12:42Z | - |
| gpt-5.5 | closeai | closeai-openai-primary | api.openai-proxy.org | yes | yes | yes | yes | yes | healthy | unavailable | 1.0000 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 07:12:42Z | - |
| gpt-5.6-sol | closeai | closeai-openai-primary | api.openai-proxy.org | yes | yes | yes | yes | yes | healthy | unavailable | 1.0000 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 07:12:42Z | - |
| gpt-5.4-mini | closeai | closeai-anthropic-primary | api.openai-proxy.org | yes | yes | yes | yes | yes | healthy | unavailable | 1.0000 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 07:12:42Z | - |
| gpt-5.6-luna | closeai | closeai-anthropic-primary | api.openai-proxy.org | yes | yes | yes | yes | yes | healthy | unavailable | 1.0000 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 07:12:42Z | - |
| gpt-5.6-terra | closeai | closeai-anthropic-primary | api.openai-proxy.org | yes | yes | yes | yes | yes | healthy | unavailable | 1.0000 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 07:12:42Z | - |
| gpt-5.5 | closeai | closeai-anthropic-primary | api.openai-proxy.org | yes | yes | yes | yes | yes | healthy | unavailable | 1.0000 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 07:12:42Z | - |
| claude-sonnet-5 | closeai | closeai-anthropic-primary | api.openai-proxy.org | yes | yes | yes | yes | yes | healthy | unavailable | 1.0000 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 07:12:42Z | - |
| claude-opus-4-8 | closeai | closeai-anthropic-primary | api.openai-proxy.org | yes | yes | yes | yes | yes | healthy | unavailable | 1.0000 | 0 | - | insufficient samples | insufficient samples | 2026-07-30 07:12:42Z | - |

The new first-model-event fields begin accumulating after this release. p50/p95 remain `insufficient samples` until a Channel/model/input bucket has at least 10 successful observations.

## Provider diversity

| Canonical model | Profiles | Independent providers | Notes |
|---|---:|---:|---|
| gpt-5.6-luna | 6 | 3 | BlackAI, Lucen, CloseAI |
| gpt-5.6-terra | 4 | 3 | BlackAI, Lucen, CloseAI |
| gpt-5.6-sol | 2 | 2 | BlackAI, CloseAI |
| gpt-5.4-mini | 3 | 2 | Lucen, CloseAI; CloseAI has Responses and Messages endpoints |
| gpt-5.5 | 2 | 1 | CloseAI only; two protocols are not independent providers |
| claude-sonnet-5 | 1 | 1 | CloseAI only |
| claude-opus-4-8 | 1 | 1 | CloseAI only |

## Lucen Monitor

`https://lucen.cc/monitor` uses `GET /api/v1/channel-monitors`. The endpoint is stable JSON but returned HTTP 401 without an interactive Lucen user session; the independently scoped Channel API key is not authorized. ACU will not reuse browser cookies and will not scrape HTML. Monitor routing influence is therefore disabled. Local request outcomes, cooldown, and half-open state remain authoritative.

## Environment entries not wired into execution profiles

The environment contains additional Provider configuration groups that are not enabled by this runtime inventory:

- BlackAI: `claude-reverse`, `codex-mix-pro-fallback`, `grok`, `image`, and `pro-1-4` groups.
- Lucen: `cx003`, `cx004`, `cx010`, `cx012`, `cx014`, `cx017`, `cx025`, Claude reverse/clone/max groups, DeepSeek, Gemini, GLM, Grok, image, Kimi, Kiro-cache, mainstream-CN, and Qwen groups.
- Generic/Judge-only variables: OpenRouter, MiMo Judge, and legacy proxy variables.

They were not auto-enabled. The active 19 profiles all have a loaded adapter and a matching economics provider. No configured active profile is missing its adapter.
