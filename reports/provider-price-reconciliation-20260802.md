# Provider price reconciliation - 2026-08-02

## Decision

The shared ACU catalog is an official public-price reference. Authenticated provider ledgers must not rewrite it. Runtime cost uses this precedence:

1. verified execution-profile ledger price;
2. official shared catalog price;
3. unavailable, rather than an invented price.

The cash formula is:

`cash CNY = token cost in provider credits * routing-group multiplier * CNY per provider credit`

Lucen uses `1.00 CNY/credit`. BlackAI uses `140/1000 = 0.14 CNY/credit`. A single provider-wide multiplier is insufficient because both sites expose multiple routing groups.

## Authenticated ledger evidence

| Provider | Records read | Multiplier identity | Dashboard window | Charged credits | Cash CNY |
|---|---:|---:|---|---:|---:|
| Lucen | 5,916 | 5,916/5,916 exact | 2026-07-26 to 2026-08-01 | 52.7343259546 | 52.7343259546 |
| BlackAI | 13,251 | 13,251/13,251 exact | 2026-07-26 to 2026-08-01 | 610.159416182 | 85.42231826548 |

"Exact" means `actual_cost == total_cost * rate_multiplier` within `1e-8`. BlackAI's authenticated group directory currently reports `1.0x` and `1.4x` groups. Lucen records contain observed multipliers from `0.04x` through `1.0x`, depending on group and model.

The compact, request-identifier-free evidence is in `reports/provider-billing-evidence-20260802.json`. Raw credentials, tokens, cookies, IP addresses, request IDs and account identifiers are excluded.

Stable Lucen provider-model rates were copied only to execution profiles. Examples:

| Model | Ledger input | Cache read | Cache write | Output | Samples |
|---|---:|---:|---:|---:|---:|
| gpt-5.6-sol | 5 | 0.5 | unknown | 30 | 5,137 |
| glm-5.2 | 8 | 2 | unknown | 28 | 95 |
| kimi-k3 | 20 | 2 | unknown | 100 | 30 |
| claude-opus-4-8 | 5 | 0.5 | 6.25 | 25 | 29 |
| deepseek-v4-flash | 1 | 0.02 | unknown | 2 | 15 |

Rates with observed alternatives, such as Lucen `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-terra` and `glm-5.1`, were not flattened into one provider-model override. They require exact routing-group evidence.

## Public price validation

The source manifest is `deploy/alpha/official-price-sources.json`. Primary sources checked on 2026-08-02:

- OpenAI: https://developers.openai.com/api/docs/pricing
- Anthropic: https://docs.anthropic.com/en/docs/about-claude/pricing
- Google: https://ai.google.dev/gemini-api/docs/pricing
- DeepSeek: https://api-docs.deepseek.com/quick_start/pricing
- Z.AI: https://docs.z.ai/guides/overview/pricing
- xAI: https://docs.x.ai/docs/models
- Moonshot: https://platform.moonshot.cn/docs/pricing/chat
- OpenRouter live directory: https://openrouter.ai/api/v1/models

Material shared-catalog corrections include OpenAI `o3` from `10/40` to `2/8`, GLM 5.2 from Lucen's `8/28` to Z.AI's `1.4/4.4`, DeepSeek V4 Flash from `1/2` to `0.14/0.28`, and current OpenRouter model-directory prices.

## Known limits

- GPT-5.5, GPT-5.6, Gemini 2.5 Pro and xAI have context-dependent price tiers. The flat catalog stores the standard short-context tier.
- Google's cache storage is priced per token-hour, not as a cache-write token fee. Image output has separate units.
- Moonshot publishes the selected Kimi prices in CNY. They are recorded as native-currency evidence and are not silently normalized into the flat USD catalog.
- Claude Sonnet 5 has a published promotional price through 2026-08-31 and must be refreshed before 2026-09-01.

## CloseAI status

The public frontend states that model prices use official USD base prices plus a plan/model service factor. Its model directory and account usage APIs require authentication. The normal login precheck from this execution environment returned `country=FR, allow=false` and then required human verification. No region or CAPTCHA bypass was attempted.

CloseAI's existing `7.2 CNY/credit` deployment economics therefore remain unchanged and are not relabelled as newly ledger-verified. Its account-specific model factors and usage ledger need a normal session from an allowed region before execution-profile overrides can be added.
