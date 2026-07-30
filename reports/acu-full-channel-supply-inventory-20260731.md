# ACU Full Channel Supply Inventory (2026-07-31)

## Scope and method

This inventory covers every Provider configuration group found in the production `.env` and every entry in `deploy/alpha/provider-channels.json`. Secret values were never copied into this report. Model directory checks used each Channel's own credential and made no inference request.

Authoritative machine-readable evidence:

- `deploy/alpha/provider-channel-model-discovery.json`: all directory responses, endpoint hosts, returned models and exact Canonical intersections.
- `deploy/alpha/provider-channel-preflight-observations.json`: paid protocol, SSE, Tool Call, actual-model and Usage evidence.
- `deploy/alpha/provider-model-profiles.json`: verified promoted profiles.
- `deploy/alpha/execution-profiles.json`: routing-active profiles, including CloseAI.

## Totals

| Measure | Result |
| --- | ---: |
| Registry Providers | 2 (BlackAI, Lucen) |
| Additional active Provider represented by profiles/economics | 1 (CloseAI) |
| Discovered Channels | 46 |
| Successful model-list calls | 46 |
| Unique returned model IDs | 144 |
| Existing Canonical models intersected | 17 |
| Exact Canonical intersections | 119 |
| Responses candidates from directory | 81 |
| Messages candidates from directory | 31 |
| Active execution profiles after this change | 21 |

`model_list_verified` means only that the directory endpoint authenticated and returned the model. It does not by itself mean protocol, Tool Call, SSE, actual-model identity, Usage or routing eligibility was verified.

## Complete configured Channel list

All BlackAI groups (6):

`blackai-codex-mix-low`, `blackai-pro-1-4`, `blackai-claude-reverse`, `blackai-grok`, `blackai-image`, `blackai-codex-mix-pro-fallback`.

All Lucen groups (40):

`lucen-cn-image-010`, `lucen-cn-models-k3-015`, `lucen-grok-020`, `lucen-image-003`, `lucen-image-006`, `lucen-image-008`, `lucen-claude-clone-020`, `lucen-claude-cursor-reverse-030`, `lucen-cx003-low`, `lucen-cx004-low-dedicated`, `lucen-cx006-value-dynamic`, `lucen-cx006-plus`, `lucen-cx008-plus-dedicated`, `lucen-cx010-plus-fast`, `lucen-cx012-pro`, `lucen-cx014-pro-stable`, `lucen-cx017-pro-first-token`, `lucen-cx025-pro-premium`, `lucen-gemini-image-008`, `lucen-gemini-image-007`, `lucen-claude-aws-reverse-040`, `lucen-claude-max-090`, `lucen-claude-antigravity-reverse-040`, `lucen-gemini-openai-030`, `lucen-mainstream-cn-claude-030`, `lucen-grok-openai-006`, `lucen-kiro-cache-claude-015`, `lucen-glm-official-claude-030`, `lucen-glm-official-openai-030`, `lucen-qwen-official-claude-010`, `lucen-qwen-official-openai-010`, `lucen-grok-006`, `lucen-deepseek-openai-050`, `lucen-deepseek-claude-050`, `lucen-kimi-k3-claude-040`, `lucen-kimi-k3-openai-040`, `lucen-kiro-cache90-claude-006`, `lucen-kiro-cache70-claude-006`, `lucen-claude-max-unlimited-100`, `lucen-gemini-reverse-native-030`.

Every group above is `discovered` and `model_list_verified`. The exact endpoint host and full returned model set for every row are retained in the machine-readable discovery artifact. BlackAI groups resolve to `blackaicoding.com`; current Lucen groups resolve to `lucen.cc`. Protocol labels in the discovery artifact are candidates inferred from the directory family, not promoted verification.

## Selective activation

| Channel | Model | Multiplier | Directory | Adapter | Protocol/Tool/SSE/Usage | Routing state | Reason |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| `lucen-cx004-low-dedicated` | `gpt-5.6-luna` | 0.04 | verified | available | rejected: HTTP 503 | inactive | Minimum live verification failed before a valid model response. |
| `lucen-cx014-pro-stable` | `gpt-5.6-luna` | 0.14 | verified | available | verified | routing_active | Exact model, legal SSE, Tool roundtrip and parseable Usage. |
| `lucen-cx025-pro-premium` | `gpt-5.6-luna` | 0.25 | verified | available | verified | routing_active | Exact model, legal SSE, Tool roundtrip and parseable Usage. |

The two passing Tool roundtrips used six inference requests total and CNY 0.00355358 estimated cash cost. No other inactive line was activated from model-list evidence alone.

## Current Luna supply

`gpt-5.6-luna` has eight total profiles, seven Responses profiles, and three independent Providers: BlackAI, Lucen and CloseAI. Active Lucen Responses price/stability layers are 0.06, 0.08, 0.14 and 0.25. BlackAI and CloseAI remain cross-Provider redundancy.

## Environment-only and non-routed configuration

The production environment also contains Judge/API groups (`MIMO_API_KEY`, `ACU_JUDGE_API_KEY`, `CLOSEAI_API_KEY`) and generic proxy/OpenRouter variables. These are not blindly converted into execution supply. Lucen image, Gemini, Grok, GLM, Qwen, DeepSeek, Kimi, Kiro-cache and Claude reverse groups remain inventory-only unless an existing Canonical mapping, compatible adapter, Tool capability, economics and live protocol evidence all exist.

No configured Profile was found without its required runtime adapter after synchronization. Directory aliases and 491 non-Canonical observations remain rejected from automatic mapping because model identity would be ambiguous.
