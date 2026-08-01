# Lucen Billing Method

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

## API Fields

The user usage endpoint returns rows from `/api/v1/usage` and detail rows from
`/api/v1/usage/{id}`.

| Lucen field | Meaning |
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

## Reconciliation Rules

1. Group by `model`, `upstream_model`, and `group_id`.
2. Use the dominant exact component price within each group.
3. Preserve multiple clusters; they usually indicate different Lucen route
   groups or a changed price schedule.
4. Treat zero-token components as unobserved, not free.
5. Compare Lucen nominal component prices to ACU profile prices before applying
   the multiplier.
6. Compare Lucen charged amounts to ACU RMB estimates after applying provider
   conversion and profile multiplier.
7. Do not replace a shared global model price when BlackAI or CloseAI also use
   that model. Add a profile-level override or split the provider model key.

## Operational Checklist

- Capture date range and timezone.
- Capture `/groups/available` and `/keys` in sanitized form.
- Use live `group.rate_multiplier`, not the human-readable API-key name.
- Save raw source outside git if it contains secrets; commit only sanitized
  rows and aggregate results.
- Record price source, observation time, and confidence.
- Re-run after Lucen announces a package, balance, or multiplier change.
- Re-test inactive models independently from billing reconciliation.
- Rotate credentials after any credential is pasted into a chat or log.
