# Lucen vs ACU Auto Price Reconciliation (2026-08-01)

## Scope

This audit intentionally separates three price concepts:

1. **ACU catalog price**: the per-model values in `src/models.ts`, copied into
   `src/acu/catalog/model-catalog.json`.
2. **Lucen nominal price**: the `input_cost`, `output_cost`,
   `cache_read_cost`, and `cache_creation_cost` before the routing-group
   multiplier.
3. **Lucen charged price**: `actual_cost`, after the routing-group multiplier.

The target of this audit is:

> ACU's price used for a Lucen execution profile must reproduce Lucen's own
> nominal component costs and charged cost. Official vendor list prices are
> reference evidence only and are not the routing source of truth.

## Evidence

The sanitized evidence file is
`reports/lucen-billing-sample-20260801.json`.

- Collection window: 2026-07-31 through 2026-08-01, Asia/Shanghai.
- Records: 1,493.
- Models with observed billing: 18.
- Lucen fields used directly: component token counts, component costs,
  `total_cost`, `actual_cost`, and `rate_multiplier`.
- Sensitive values excluded: API key values, IP addresses, request IDs,
  account IDs, and authentication tokens.

For every sampled row:

`actual_cost = total_cost * rate_multiplier`

No sampled row violated this equality.

## Main conclusion

The current ACU catalog does **not** reliably reproduce Lucen billing.

There are two distinct causes:

1. Many model-level nominal prices are stale or use a different unit basis.
2. A single model can have different Lucen nominal prices on different
   routing groups. A single global model price cannot represent this.

Therefore, blindly replacing the global catalog with Lucen prices is unsafe,
especially for models also routed through BlackAI or CloseAI. Lucen prices
must be stored as execution-profile price overrides.

## Observed Lucen nominal prices

Values are input / output / cache read / cache creation per 1M tokens.
`-` means no billable sample was observed for that component.

| Model | ACU catalog | Lucen observed | Evidence | Assessment |
| --- | --- | --- | ---: | --- |
| `gpt-5.6-sol` | 5 / 30 / 0.5 / 5 | 5 / 30 / 0.5 / - | 1,031 | Match for observed components |
| `gpt-5.6-luna` | 1 / 6 / 0.1 / 1 | 0.2 / 1.2 / 0.02 / - | 80 current-price rows | Catalog is 5x high |
| `gpt-5.6-terra` | 2.5 / 15 / 0.25 / 2.5 | 2 / 12 / 0.2 / - | 42 | Catalog is 1.25x high |
| `gpt-5.5` | 5 / 30 / 2.5 / 5 | 5 / 30 / 0.5 / - | 62 normal rows | Cache read is 5x high |
| `gpt-5.4-mini` | 0.75 / 4.5 / 0.375 / 0.75 | 0.75 / 4.5 / 0.075 / - | 63 | Cache read is 5x high |
| `claude-opus-4-8` | 5 / 25 / 0.5 / 6.25 | 5 / 25 / 0.5 / 6.25 | 29 | Match |
| `claude-sonnet-5` | 3 / 15 / 0.3 / 3.75 | 2 / 10 / 0.2 / 2.5 | 18 | Catalog is 1.5x high |
| `claude-fable-5` | 10 / 50 / 1 / 12.5 | 10 / 50 / 1 / 12.5 | 4 | Match |
| `gemini-2.5-flash` | 0.15 / 0.6 / 0.0375 / 0.15 | 0.3 / 2.5 / - / - | 15 | Catalog underestimates input 2x and output 4.17x |
| `gemini-3.5-flash` | 1.5 / 9 / 0.75 / 1.5 | 1.5 / 9 / - / - | 13 | Input/output match |
| `deepseek-v4-flash` | 0.15 / 0.3 / 0.07 / 0.15 | 1 / 2 / 0.02 / - | 10 | Input/output underestimated about 6.67x |
| `deepseek-v4-pro` | 1.8 / 3.6 / 0.9 / 1.8 | 3 / 6 / 0.025 / - | 5 | Input/output underestimated 1.67x; cache read 36x high |
| `glm-5.2` | 1.2 / 4.2 / 0.6 / 1.2 | 8 / 28 / 2 / - | 48 | Catalog materially underestimates Lucen |
| `glm-5.1` | 0.9 / 3.5 / 0.45 / 0.9 | 8 / 28 / 2 on group 147; 6 / 24 / - on groups 121/145 | 27 | Profile-specific prices required |
| `kimi-k2.6` | 0.95 / 4 / 0.475 / 0.95 | 6.5 / 27 / - / - | 5 | Catalog underestimates about 6.8x |
| `kimi-k2.7-code` | 0.95 / 4 / 0.475 / 0.95 | 6.5 / 27 / - / - | 5 | Catalog underestimates about 6.8x |
| `kimi-k3` | 3 / 15 / 0.3 / 3 | 20 / 100 / 2 / - | 20 | Catalog underestimates about 6.67x |
| `qwen3.7-max` | 1.8 / 5.4 / 0.9 / 1.8 | 12 / 36 / - / - | 3 | Catalog underestimates about 6.67x |

### Time-sensitive price change

Four Luna rows at 2026-07-31 02:19 China time used 1 / 6. All Luna rows
from 2026-07-31 14:30 onward used 0.2 / 1.2, and cache-bearing rows used
0.02 for cache reads. The ACU catalog still contains the earlier price.

### Same model, different nominal price

`gpt-5.5` normally uses 5 / 30 / 0.5, but calls through Lucen group 147
(`no.20-glm官key专线-openai-0.3`) were billed at 8 / 28 / 2.

This proves that a canonical model ID alone is not a sufficient pricing key.
The correct key is at least:

`provider + channel/execution profile + provider model`

## Aggregate distortion in the sample

The following compares the ACU catalog's reconstructed nominal cost with
Lucen `total_cost` over the captured records.

| Model | ACU / Lucen nominal cost ratio | Routing effect |
| --- | ---: | --- |
| `gpt-5.6-sol` | 1.000 | Correct |
| `gpt-5.6-luna` | 4.868 | ACU avoids a model that is much cheaper on Lucen |
| `gpt-5.6-terra` | 1.250 | ACU overestimates cost |
| `gpt-5.4-mini` | 1.576 | ACU overestimates cache-heavy calls |
| `gpt-5.5` | 1.920 | Mostly caused by stale cache-read price |
| `claude-sonnet-5` | 1.500 | ACU overestimates cost |
| `gemini-2.5-flash` | 0.484 | ACU underestimates cost |
| `deepseek-v4-flash` | 0.197 | ACU substantially underestimates cost |
| `deepseek-v4-pro` | 0.724 | ACU underestimates observed mix |
| `glm-5.2` | 0.220 | ACU substantially underestimates cost |
| `glm-5.1` | 0.162 | ACU substantially underestimates cost |
| `kimi-k2.6` | 0.148 | ACU substantially underestimates cost |
| `kimi-k2.7-code` | 0.148 | ACU substantially underestimates cost |
| `kimi-k3` | 0.150 | ACU substantially underestimates cost |
| `qwen3.7-max` | 0.150 | ACU substantially underestimates cost |

## Routing-group multiplier audit

Lucen currently exposes 42 groups and 43 user API keys. Most registry
multipliers still match, but these discrepancies require attention:

| ACU channel | Registry multiplier | Lucen current group | Current multiplier | Result |
| --- | ---: | --- | ---: | --- |
| `lucen-cx006-value-dynamic` | 0.06 | `cx010-性价比-动态调价` | 0.10 | ACU underestimates cash cost by 40% relative to actual |
| `lucen-qwen-official-openai-010` | 0.10 | `no.22-qwen官key专线-openai-0.4` | 0.40 | ACU underestimates cash cost by 4x |
| `lucen-qwen-official-claude-010` | 0.10 | `no.21-qwen官key专线-cc-0.4` | 0.40 | ACU underestimates cash cost by 4x |
| `lucen-grok-020` | 0.20 | `稳定grok-025` | 0.25 | ACU underestimates cash cost by 25% |
| `lucen-cx003-low` | missing | `cx003-低价` | 0.03 | Price unavailable in ACU |
| `lucen-claude-clone-020` | missing | `cc-高仿山寨(0.2)` | 0.20 | Price unavailable in ACU |

The `cx006-性价比-动态调价-0.06x` API key label itself is stale: it currently
routes to a 0.10 group. Lucen's live group assignment, not the key label, must
be treated as authoritative.

## Unrepresented live Lucen groups

Two active Lucen groups are not represented by the current channel registry:

- `cx005-独立线路`, multiplier 0.05.
- `no.15-主流国产模型-openai协议-0.3`, multiplier 0.30.

They are available groups, but no dedicated active API key was observed in
the account snapshot. They should be treated as supply opportunities, not
automatically activated channels.

## Current implementation limitation

`profileEffectivePrices()` currently takes the global catalog input/output
price and multiplies it by the execution profile's economics multiplier.
The multiplier can be profile-specific, but the nominal model price cannot.

Additionally, ACU model selection currently passes only effective input and
output prices into `recommendModel()`. Cache-read and cache-creation prices
are not part of the model-selection cost estimate, even though post-call
accounting uses cached input tokens.

Consequences:

- Lucen profile-specific nominal prices cannot be represented.
- Cache-heavy sessions can be routed using materially wrong economics.
- Post-call nominal cost can disagree with Lucen even when token usage is
  trusted.

## Recommended change direction

### P0: execution-profile price override

Add optional fields to each execution profile:

- `inputPricePerMillion`
- `outputPricePerMillion`
- `cacheReadPricePerMillion`
- `cacheWritePricePerMillion`
- `priceUnit` (`provider_credit`)
- `priceSource`
- `priceObservedAt`
- `priceStatus` (`verified`, `estimated`, `missing`)

Pricing precedence:

1. execution-profile verified price;
2. provider-model verified price;
3. global catalog fallback;
4. otherwise exclude the profile from cost-sensitive automatic routing.

Do not globally replace catalog values for models shared with BlackAI or
CloseAI until those providers have their own observed billing evidence.

### P0: refresh live multipliers

Update the six multiplier discrepancies above. In particular, immediately
stop treating the dynamic CX channel as 0.06 and Qwen official channels as
0.10.

### P1: cache-aware model selection

Extend effective prices and call-cost estimates to include estimated cache
read and cache write tokens. Persist the exact profile price snapshot in each
route decision so later billing reconciliation uses the same price version.

### P1: automated Lucen reconciliation

Run a read-only daily audit against:

- `/api/v1/groups/available`
- `/api/v1/keys`
- `/api/v1/usage`
- `/api/v1/usage/{id}`

Alert when:

- a component unit rate changes;
- a key is reassigned to a different group;
- a group multiplier changes;
- a billed model has no execution-profile price;
- ACU reconstructed cost differs from Lucen by more than a small rounding
  tolerance.

### P2: supply onboarding

Evaluate the two unrepresented live groups and re-test currently inactive
models (`deepseek-v4-pro`, `qwen3.7-max`, and `gemini-3.5-flash`) separately
from pricing. A model being billable does not prove protocol, tool, identity,
or routing eligibility.
