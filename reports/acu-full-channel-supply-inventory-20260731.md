# ACU Full Channel Supply Inventory (2026-07-31)

## Scope and method

This inventory covers every Provider configuration group found in the production `.env` and every entry in `deploy/alpha/provider-channels.json`. Secret values were never copied into this report. Model directory checks used each Channel's own credential and made no inference request.

Authoritative machine-readable evidence:

- `deploy/alpha/provider-channel-model-discovery.json`: all directory responses, endpoint hosts, returned models and exact Canonical intersections.
- `deploy/alpha/full-pool-preflight-observations.json`: full Responses protocol, SSE, Tool Call, actual-model and Usage evidence.
- `deploy/alpha/full-pool-preflight-messages-observations.json`: corrected `/v1/messages` evidence.
- `deploy/alpha/full-pool-qualified-profiles.json`: the exact Profiles admitted by the full-pool validation.
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
| Paid candidate Profiles tested | 112 |
| Profiles passing the minimum live validation | 59 |
| Active execution profiles after preserving previously verified supply | 73 |
| Active text/Agent Canonical models | 13 |
| Active Channels | 22 |
| Active independent Providers | 3 |
| Validation cash cost | CNY 0.176878854 |

`model_list_verified` means only that the directory endpoint authenticated and returned the model. It does not by itself mean protocol, Tool Call, SSE, actual-model identity, Usage or routing eligibility was verified.

## Complete configured Channel list

All BlackAI groups (6):

`blackai-codex-mix-low`, `blackai-pro-1-4`, `blackai-claude-reverse`, `blackai-grok`, `blackai-image`, `blackai-codex-mix-pro-fallback`.

All Lucen groups (40):

`lucen-cn-image-010`, `lucen-cn-models-k3-015`, `lucen-grok-020`, `lucen-image-003`, `lucen-image-006`, `lucen-image-008`, `lucen-claude-clone-020`, `lucen-claude-cursor-reverse-030`, `lucen-cx003-low`, `lucen-cx004-low-dedicated`, `lucen-cx006-value-dynamic`, `lucen-cx006-plus`, `lucen-cx008-plus-dedicated`, `lucen-cx010-plus-fast`, `lucen-cx012-pro`, `lucen-cx014-pro-stable`, `lucen-cx017-pro-first-token`, `lucen-cx025-pro-premium`, `lucen-gemini-image-008`, `lucen-gemini-image-007`, `lucen-claude-aws-reverse-040`, `lucen-claude-max-090`, `lucen-claude-antigravity-reverse-040`, `lucen-gemini-openai-030`, `lucen-mainstream-cn-claude-030`, `lucen-grok-openai-006`, `lucen-kiro-cache-claude-015`, `lucen-glm-official-claude-030`, `lucen-glm-official-openai-030`, `lucen-qwen-official-claude-010`, `lucen-qwen-official-openai-010`, `lucen-grok-006`, `lucen-deepseek-openai-050`, `lucen-deepseek-claude-050`, `lucen-kimi-k3-claude-040`, `lucen-kimi-k3-openai-040`, `lucen-kiro-cache90-claude-006`, `lucen-kiro-cache70-claude-006`, `lucen-claude-max-unlimited-100`, `lucen-gemini-reverse-native-030`.

Every group above is `discovered` and `model_list_verified`. The exact endpoint host and full returned model set for every row are retained in the machine-readable discovery artifact. BlackAI groups resolve to `blackaicoding.com`; current Lucen groups resolve to `lucen.cc`. Protocol labels in the discovery artifact are candidates inferred from the directory family, not promoted verification.

## Verified pool expansion

The minimum validation used native Responses or Messages, legal SSE, a Tool Call and Tool Result roundtrip, actual-model identity, Provider Usage, and known Economics. Directory presence alone never activated a Profile. The passing model set is:

`gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `claude-opus-4-8`, `claude-sonnet-5`, `deepseek-v4-flash`, `gemini-2.5-flash`, `glm-5.1`, `glm-5.2`, `kimi-k2.6`, `kimi-k2.7-code`.

Active Profile counts by model:

| Model | Profiles |
| --- | ---: |
| `claude-opus-4-8` | 8 |
| `claude-sonnet-5` | 6 |
| `deepseek-v4-flash` | 1 |
| `gemini-2.5-flash` | 1 |
| `glm-5.1` | 1 |
| `glm-5.2` | 3 |
| `gpt-5.4-mini` | 10 |
| `gpt-5.5` | 12 |
| `gpt-5.6-luna` | 12 |
| `gpt-5.6-sol` | 10 |
| `gpt-5.6-terra` | 7 |
| `kimi-k2.6` | 1 |
| `kimi-k2.7-code` | 1 |

The 22 active Channels comprise 16 Lucen, 4 BlackAI and 2 protocol-specific CloseAI Channels. All 51 unique runtime environment variable names required by the 73 Profiles are present in the production Router container; Secret values were not inspected or copied.

Rejected models remain out of automatic routing: `deepseek-v4-pro` failed Tool input/result or upstream validation, Qwen candidates returned HTTP 400/502, and `gemini-3.5-flash` returned `gemini-3-flash-agent` and failed actual-model identity. Individual failed Profiles remain in the observation artifacts with their exact `timeout`, HTTP 502/503, protocol, Tool, or model-mismatch reason.

## Current Luna supply

`gpt-5.6-luna` has 12 total Profiles and three independent Providers: BlackAI, Lucen and CloseAI. Active Lucen Responses price/stability layers include 0.06, 0.08, 0.10, 0.12, 0.14, 0.17 and 0.25. BlackAI and CloseAI remain cross-Provider redundancy.

## Environment-only and non-routed configuration

The production environment also contains Judge/API groups (`MIMO_API_KEY`, `ACU_JUDGE_API_KEY`, `CLOSEAI_API_KEY`) and generic proxy/OpenRouter variables. These are not blindly converted into execution supply. Image, Audio, Realtime, Grok, rejected Qwen/DeepSeek/Gemini variants, and model IDs without a verified Canonical mapping remain inventory-only.

No configured Profile was found without its required runtime Adapter or Economics after synchronization. Directory aliases and non-Canonical observations remain rejected from automatic mapping because model identity would be ambiguous.

## Probe and cash-cost semantics

The full pool is probed serially at most once every six hours. A scheduled run requires at least one real API Logical Request in the preceding six hours; after an idle period, the next real request wakes the shared Worker asynchronously and does not wait for it. Probe attempts do not call Judge, enter user billing, or appear in Work Timeline.

The first production full-pool run attempted all 73 Profiles: 65 succeeded and 8 failed. The 65 attempts with trusted Provider Usage cost CNY 0.038363499. Eight failures had no Provider Usage, so their cash cost is recorded as unavailable rather than estimated from an error body. At four runs per day the measured trusted cost is CNY 0.153453996; the daily safety budget is CNY 0.20.

Lucen cash conversion is founder-confirmed as CNY 100 for 100 USD-denominated Provider credits, so one Provider credit costs CNY 1. Each Execution Profile's observed multiplier is then applied to nominal Catalog token cost. For example, the supplied cx025 record is independently reproducible:

`((4,473 x $1/M input) + (6 x $6/M output)) x 0.25 x CNY 1/credit = CNY 0.00112725`, matching the Lucen balance charge `$0.001127` after display rounding.
