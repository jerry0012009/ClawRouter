---
name: lucen-billing-reconciliation
description: Reconcile Lucen usage bills with ACU model costs, execution-profile multipliers, cache pricing, and provider cash conversion. Use when importing Lucen usage exports, auditing model or channel prices, investigating billing discrepancies, onboarding Lucen channels, or updating ACU economics.
---

# Lucen Billing Reconciliation

Use Lucen per-request component costs as the billing source of truth for
Lucen execution profiles. Keep Lucen's USD-denominated credits separate from
ACU's RMB accounting: when recharge is 1 RMB for 1 USD credit, the numeric
nominal credit price converts one-for-one to RMB cash before the channel
multiplier.

## Source Of Truth

Treat these values as different:

- **Lucen nominal price**: `input_cost`, `output_cost`,
  `cache_read_cost`, and `cache_creation_cost` divided by their token counts.
- **Lucen charged price**: `actual_cost`, normally
  `total_cost * rate_multiplier`.
- **ACU cost**: Lucen nominal price in provider-credit units multiplied by
  provider conversion and execution-profile multiplier, yielding RMB.
- **Official vendor price**: context only; never substitute it for observed
  Lucen billing during reconciliation.

Use `provider + channel/execution profile + provider model` as the effective
pricing key. Do not assume one global model price is valid for every Lucen
group.

## Workflow

1. Obtain a Lucen usage export or sanitized API response. Never store
   passwords, bearer tokens, API key values, IP addresses, or request IDs.
2. Normalize each row into model, provider model, route group, token counts,
   component costs, `total_cost`, `actual_cost`, and `rate_multiplier`.
3. Calculate a component price only when its token count is positive:

   `unit_price = component_cost / component_tokens * 1,000,000`

4. Group by model and route group. Report the modal unit price and all
   materially different price clusters; do not average across groups.
5. Verify:

   `actual_cost ≈ total_cost * rate_multiplier`

6. Compare observed Lucen nominal prices with ACU profile prices before
   applying the multiplier. Update channel multipliers from Lucen's live
   group table, not from API-key labels.
7. Keep profiles with different nominal prices separate. If runtime only
   supports global model prices, mark the discrepancy and do not silently
   rewrite a shared model used by BlackAI or CloseAI.
8. Save a dated sanitized artifact and a short reconciliation report.

## Runtime Rules

- A verified execution-profile price override takes precedence over the global
  catalog price.
- A live route-group multiplier takes precedence over a stale channel label.
- Missing cache prices remain explicitly unknown; do not infer them from input
  price without recording the assumption.
- Separate requested model from `upstream_model` and actual model identity.
- A billable model is not automatically protocol-, tool-, identity-, or
  routing-eligible.

## Resources

Read [references/billing-method.md](references/billing-method.md) for field
mapping, currency rules, and the operational checklist.

Run the deterministic comparator with:

```bash
python3 skills/lucen-billing-reconciliation/scripts/reconcile_usage.py \
  --billing reports/lucen-billing-sample-20260801.json \
  --catalog src/acu/catalog/model-catalog.json
```
