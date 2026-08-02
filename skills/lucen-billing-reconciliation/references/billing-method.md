# Provider Billing Method

## Evidence Layers

Keep four independently auditable layers:

| Layer | Key | Purpose |
| --- | --- | --- |
| Official public price | vendor + canonical model + price tier | Cross-provider reference |
| Ledger component price | provider + model + route group/profile | Provider-credit token cost |
| Billing multiplier | provider + route group | Converts nominal to charged credits |
| Cash conversion | provider + recharge batch | Converts charged credits to RMB |

Use `verified profile ledger price > official catalog fallback`. Never write a
provider ledger rate into the global official catalog.

## Currency

Lucen displays account balance and request costs as USD-denominated credits.
The observed recharge rule is:

```text
1 RMB cash = 1 Lucen USD credit
```

Therefore, a Lucen nominal price of `8 credits / 1M` corresponds to
`8 RMB / 1M` cash before the route multiplier. Do not apply an additional
USD/CNY exchange rate. The ACU router's final accounting unit is RMB.

If the recharge ratio changes, update provider economics first:

```text
effective RMB cost =
nominal Lucen credits
* execution-profile multiplier
* recharge_cash_cny / credits_received_usd
```

Current founder-confirmed conversions at the 2026-08-02 reconciliation:

| Provider | Recharge | Cash ratio |
| --- | --- | ---: |
| Lucen | CNY 1 for 1 credit | 1 CNY/credit |
| BlackAI | CNY 140 for 1000 web credits | 0.14 CNY/credit |
| CloseAI | Existing deployment value only until account ledger refresh | 7.2 CNY/credit |

Do not relabel an existing CloseAI conversion as newly ledger-verified when
login is blocked.

## API Fields

Lucen and BlackAI use rows from `/api/v1/usage` and detail rows from
`/api/v1/usage/{id}`.

| Usage field | Meaning |
| --- | --- |
| `input_tokens` | Uncached input tokens |
| `output_tokens` | Output tokens |
| `cache_read_tokens` | Cache-read tokens |
| `cache_creation_tokens` | Cache creation tokens |
| `input_cost` | Nominal input component cost |
| `output_cost` | Nominal output component cost |
| `cache_read_cost` | Nominal cache-read component cost |
| `cache_creation_cost` | Nominal cache-creation component cost |
| `total_cost` | Sum of nominal components |
| `actual_cost` | Amount charged after multiplier |
| `rate_multiplier` | Live Lucen routing-group multiplier |
| `group_id` | Live routing-group identity |
| `model` | Requested model label |
| `upstream_model` | Provider model when supplied |

Calculate a component price only when its token count is positive:

```text
component_price_per_1M =
  component_cost / component_tokens * 1,000,000
```

Validate every row with:

```text
abs(actual_cost - total_cost * rate_multiplier) <= rounding_tolerance
```

CloseAI currently uses `/api/v1/account/usage/detail` and
`/api/v1/account/usage/export`. Its public `/api/v1/models` directory contains
`prompt_price`, `completion_price`, optional `price_detail`, and
`pricing_factor`. Treat these as CloseAI channel prices, not first-party vendor
prices.

## Reconciliation Rules

1. Group by `model`, `upstream_model`, and `group_id`.
2. Use the dominant exact component price within each group.
3. Preserve multiple clusters; they usually indicate different Lucen route
   groups or a changed price schedule.
4. Treat zero-token components as unobserved, not free.
5. Compare provider nominal component prices to ACU profile prices before applying
   the multiplier.
6. Compare Lucen charged amounts to ACU RMB estimates after applying provider
   conversion and profile multiplier.
7. Keep the shared global price tied to a primary official source. Add a
   profile-level override or split the provider model key for account prices.
8. A profile override requires stable component evidence for the exact key.
   If alternatives exist, keep them in the report and leave the override
   unresolved until the route group is known.
9. Verify generated New API effective prices use the selected profile's
   component price, group multiplier, and cash conversion.

## Official Price Sources

Prefer primary vendor pages and record URL, observation date, native currency,
service tier, context tier, cache semantics, and promotional end date. Use a
channel directory such as OpenRouter only for channel-routed models and label
it as a channel source.

The repository source manifest is
`deploy/alpha/official-price-sources.json`. Flat catalog limitations must be
documented, especially context-dependent prices, Google cache storage per
token-hour, image/media units, and native-CNY prices.

## Operational Checklist

- Capture date range and timezone.
- Capture `/groups/available` in sanitized form. Do not retain API keys or key
  identifiers unless they are strictly required for an aggregate group join.
- Use live `group.rate_multiplier`, not the human-readable API-key name.
- Save raw source outside git if it contains secrets; commit only sanitized
  rows and aggregate results.
- Record price source, observation time, and confidence.
- Re-run after Lucen announces a package, balance, or multiplier change.
- Re-test inactive models independently from billing reconciliation.
- Rotate credentials after any credential is pasted into a chat or log.
- Delete raw login responses, tokens, cookies, screenshots, and request-level
  temporary exports after the sanitized aggregate is generated.
- Search committed files for supplied credentials before committing.
- Run `git diff --check`, JSON parsing, typecheck, tests, and build.
