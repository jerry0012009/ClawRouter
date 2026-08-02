---
name: lucen-billing-reconciliation
description: Reconcile Lucen, BlackAI, and CloseAI usage ledgers with official public model prices, execution-profile billing overrides, routing-group multipliers, cache pricing, and RMB cash conversion. Use when importing provider usage exports, validating public or channel prices, investigating billing discrepancies, comparing provider costs, onboarding channels, or updating ACU pricing and economics.
---

# Provider Billing Reconciliation

Keep official public prices, provider ledger prices, routing-group multipliers,
and cash conversion as separate evidence layers. Never make one provider's
ledger price the shared price for another provider.

## Source Of Truth

Apply this precedence:

- **Official catalog price**: public vendor reference price. Update only from
  a dated primary source manifest.
- **Provider ledger price**: `input_cost`, `output_cost`,
  `cache_read_cost`, and `cache_creation_cost` divided by their token counts.
- **Provider charged price**: `actual_cost`, normally
  `total_cost * rate_multiplier`.
- **ACU cash cost**: provider ledger price when verified, otherwise official
  catalog fallback, multiplied by the group multiplier and CNY/credit ratio.

Use `provider + channel/execution profile + provider model` as the effective
pricing key. Do not absorb a model-specific ledger price difference into a
provider-wide multiplier.

## Workflow

1. Read [references/billing-method.md](references/billing-method.md) completely.
2. Obtain each provider's usage export through its normal authenticated flow.
   Respect CAPTCHA and region policy; never bypass them. Never store passwords,
   bearer tokens, API key values, cookies, account identifiers, IP addresses,
   user agents, request bodies, or request IDs.
3. Capture the official public-price source manifest separately. Distinguish
   first-party vendor pages from provider/channel directories.
   For CloseAI saved-page refreshes, keep raw HTML out of git and follow the
   compact snapshot procedure in `references/billing-method.md`.
4. Normalize each row into model, provider model, route group, token counts,
   component costs, `total_cost`, `actual_cost`, and `rate_multiplier`.
5. Calculate a component price only when its token count and cost are positive:

   `unit_price = component_cost / component_tokens * 1,000,000`

6. Group by model and route group. Report the modal unit price and all
   materially different price clusters; do not average across groups.
7. Verify every retained row:

   `actual_cost ≈ total_cost * rate_multiplier`

8. Update routing-group multipliers from authenticated group data or exact
   request equations, not API-key labels. Apply provider cash conversion only
   after the group multiplier.
9. Add an execution-profile price only when the component rate is stable for
   that exact provider/model/profile evidence. Preserve alternatives as
   unresolved; do not flatten them.
10. Regenerate the shared catalog, execution-profile catalog, and New API
    catalog. Verify the New API effective CNY price uses the profile override.
11. Save a dated aggregate artifact and report. Delete authentication and raw
    temporary files after aggregation.

## Runtime Rules

- A verified execution-profile price override takes precedence over the global
  catalog price.
- The global catalog contains official public reference prices, not provider
  account prices.
- A live route-group multiplier takes precedence over a stale channel label.
- Missing cache prices remain explicitly unknown; do not infer them from input
  price without recording the assumption.
- Treat cache read and cache creation as distinct. Anthropic Messages reports
  them outside ordinary input; OpenAI Responses reports cached input inside
  input tokens.
- Keep native currencies explicit. Do not silently treat CNY vendor prices as
  USD.
- Separate requested model from `upstream_model` and actual model identity.
- A billable model is not automatically protocol-, tool-, identity-, or
  routing-eligible.
- Mark a blocked login as unverified with the exact precheck reason. Do not
  preserve an old rate as newly verified.

## Resources

Build the cross-provider aggregate with sanitized temporary inputs:

```bash
node scripts/build-provider-billing-evidence.mjs \
  lucen=/tmp/lucen-ledger-sanitized.json \
  blackai=/tmp/black-ledger-sanitized.json \
  --output reports/provider-billing-evidence-YYYYMMDD.json
```

Validate a CloseAI saved-page snapshot before using it:

```bash
python3 skills/lucen-billing-reconciliation/scripts/validate_closeai_snapshot.py \
  --snapshot reports/provider-pricing/closeai-public-pricing-YYYYMMDD.json \
  --html /tmp/closeai-pricing.html
```

The HTML is optional for later repository-only audits, but required while
creating a new snapshot so its SHA-256 can be verified before deletion.

Then regenerate and verify:

```bash
python3 scripts/sync-acu-catalog-prices.py
npx tsx tools/provider-channels/sync-newapi-channel-status.ts
npm run typecheck
npm test
npm run build
```

Use the legacy single-provider comparator only for an already-sanitized Lucen
sample:

```bash
python3 skills/lucen-billing-reconciliation/scripts/reconcile_usage.py \
  --billing reports/lucen-billing-sample-YYYYMMDD.json \
  --catalog src/acu/catalog/model-catalog.json
```
