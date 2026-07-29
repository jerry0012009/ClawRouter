# Founder Real Session Reconciliation Audit

Audit scope: 2026-07-30 02:40:00-02:51:00 Asia/Shanghai (2026-07-29 18:40:00-18:51:00 UTC). The terminal retry tail through 18:51:26 UTC is included only to explain the final 502. This report is read-only and redacted.

## Executive result

- Production commits: ClawRouter `fe060ca78161026792284cb78d415ad86b347e6e`; New API `751e06f9ef284241f42542046445431b68679e10`.
- Identity: `newapi_user_id=3`, token ID `3`, API-key SHA-256 fingerprint `67fbd5a0006138e4...`.
- One Session, one Task, seven Routing Segments, nineteen completed Logical Requests and nineteen successful Provider Attempts.
- All nineteen successful Attempts used Lucen / `lucen-cx006-value-dynamic` / `gpt-5.6-luna`; BlackAI Attempts: `0`.
- The nineteen Provider usage records reconcile to the ACU/New API ledger. ACU cached input is 351,360, 40 below the Founder-observed Lucen page total; nominal-cost difference is USD 0.000004 (0.002870%).
- New API charges nominal provider cost plus Judge cost. It does not charge Lucen provider-balance cost or effective cash cost.
- Two live Judge calls on the failed final segment were cached but never persisted or charged. Including them, end-to-end reconciliation differs by USD 0.0024912 (1.672077%), so the under-1% target is not met.
- Effective cash cost: Lucen CNY 0.0083616 plus all eight live Judge calls CNY 0.06932412, total CNY 0.07768572.
- Final 502 originated in ACU Router admission before Logical Request/Attempt creation. All Responses Profiles had a 32,768 context limit; the preceding successful request already had 32,222 input tokens, and the next request exceeded the pool limit. The returned tool-capability error was misleading.
- Pricing exposes six models, but the Founder Key `/v1/models` returns only `acu-auto`; the New API `models` table has no corresponding rows. The six-model presentation is therefore not internally consistent.

## Session identity

| Field | Value |
| --- | --- |
| newapi_user_id | `3` |
| New API user | `acu_founder` |
| Token ID / redacted fingerprint | `3` / `sha256:67fbd5a0006138e4...` |
| Session ID | `ses_0548592665134f41925f27b6e33aa6ed` |
| Task ID | `task_66805f7470a74c2d8d0c62058f942f2f` |
| Client | Codex `0.146.0`, Responses, `acu-auto`, reasoning `medium` |
| Working directory | `/root/jerry/chuxin` |
| Session time | 18:41:17.618-18:51:26.389 UTC |
| Source-IP evidence | The supplied origin is `31.220.80.196`; Nginx/New API persisted Cloudflare edge IPs or blank IP, so the origin IP is not independently recoverable from the audited stores. |

Database `step_id` is null for all nineteen Logical Requests. The `S01`-`S19` labels below are audit ordinals, not invented database IDs.

## Task and Segment structure

The state machine kept one broad Task and created seven Segments. It did not reuse one Segment for the whole Session.

| Segment | Cause / redacted goal | Judge | Steps / LR / tools | Final state and outcome evidence |
| --- | --- | --- | --- | --- |
| `seg_e5c1...d3c` | `task_start`; greeting | live, persisted | 1 / 1 / 0 | superseded; short assistant response completed |
| `seg_18c3...694` | `human_message`; homepage visual redesign plan and public demo | live, persisted | 1 / 1 / 1 | superseded; plan created |
| `seg_a2d9...502` | `plan_started`; design/repository exploration and demo plan | live, persisted | 8 / 8 / 9 | superseded; two plan updates, final plan marked complete |
| `seg_0193...252` | `human_message`; locate other `chuxin` project copies and prior deployment | live, persisted | 2 / 2 / 4 | superseded; local/deployment checks completed, plan finished |
| `seg_6839...486` | `plan_finished`; transition back to execution | live, persisted | 1 / 1 / 1 | superseded; a new plan was started |
| `seg_e957...264` | `plan_started`; continued deployment investigation | live, persisted | 6 / 6 / 7 | superseded; local/server-side investigation completed |
| `seg_30f7...40f` | `human_message`; inspect Gitee, DNS and target server | state machine requested rejudge; no durable Judge Evaluation/Route | 0 / 0 / 0 | active; 502 before Logical Request creation |

The final Segment inherited the preceding Segment's `judgeRun` JSON in segment metadata. That inherited copy is byte-identical and is not proof of reuse. The Judge cache proves two new live calls at 18:50:50.886 and 18:50:54.888 UTC; both still described the earlier design task, showing that the truncated Judge context did not capture the new deployment/DNS goal reliably.

### Nineteen successful Steps

| Step | Segment | Logical Request | Attempt | UTC start-end | Tokens input/cached/output/reasoning |
| --- | --- | --- | --- | --- | --- |
| S01 | `seg_e5c1...d3c` | `req_99a6...3b5` | `att_3c98...ac3` | 18:41:22.283-18:41:25.473 | 13,852 / 3,456 / 11 / 0 |
| S02 | `seg_18c3...694` | `req_d116...9e4` | `att_cd4c...8c4` | 18:43:12.298-18:43:20.483 | 13,976 / 13,696 / 183 / 53 |
| S03 | `seg_a2d9...502` | `req_74c2...bfd` | `att_a80d...be9` | 18:43:25.577-18:43:32.093 | 14,172 / 13,696 / 221 / 0 |
| S04 | `seg_a2d9...502` | `req_b19d...5f9` | `att_e4f4...73e` | 18:43:32.452-18:43:40.096 | 14,509 / 13,696 / 273 / 36 |
| S05 | `seg_a2d9...502` | `req_c9ea...610` | `att_6000...882` | 18:43:40.312-18:43:47.786 | 15,735 / 3,456 / 317 / 139 |
| S06 | `seg_a2d9...502` | `req_fa46...4ca` | `att_fd32...5d8` | 18:43:47.845-18:43:53.477 | 16,065 / 14,720 / 162 / 51 |
| S07 | `seg_a2d9...502` | `req_9f31...f53` | `att_5da0...1f9` | 18:43:53.659-18:44:56.582 | 16,319 / 15,744 / 3,374 / 67 |
| S08 | `seg_a2d9...502` | `req_de0c...6dc` | `att_e7e0...644` | 18:44:56.977-18:45:14.108 | 19,744 / 13,696 / 837 / 94 |
| S09 | `seg_a2d9...502` | `req_7f3d...db8` | `att_7f19...c12` | 18:45:16.562-18:45:24.184 | 20,767 / 18,816 / 308 / 178 |
| S10 | `seg_a2d9...502` | `req_ff1f...9f5` | `att_e5e9...a31` | 18:45:24.418-18:45:33.751 | 21,088 / 19,840 / 422 / 0 |
| S11 | `seg_0193...252` | `req_9756...d20` | `att_e3b8...4d8` | 18:46:45.492-18:46:56.318 | 21,554 / 20,864 / 497 / 73 |
| S12 | `seg_0193...252` | `req_e785...530` | `att_d5cb...af8` | 18:47:06.700-18:47:11.697 | 23,476 / 20,864 / 49 / 10 |
| S13 | `seg_6839...486` | `req_7d02...ef8` | `att_9346...98f` | 18:47:46.324-18:47:51.664 | 23,574 / 22,912 / 61 / 17 |
| S14 | `seg_e957...264` | `req_2de7...4c8` | `att_df09...1f4` | 18:47:56.176-18:48:07.435 | 23,827 / 22,912 / 477 / 68 |
| S15 | `seg_e957...264` | `req_14eb...f91` | `att_325b...c2c` | 18:48:24.542-18:48:27.938 | 24,636 / 22,912 / 51 / 7 |
| S16 | `seg_e957...264` | `req_b5cb...ddf` | `att_e33b...c20` | 18:48:28.073-18:48:32.974 | 26,313 / 23,936 / 142 / 23 |
| S17 | `seg_e957...264` | `req_32d3...249` | `att_a13a...9c7` | 18:48:33.059-18:48:37.468 | 29,652 / 25,984 / 134 / 15 |
| S18 | `seg_e957...264` | `req_ed97...f38` | `att_6a34...871` | 18:48:37.648-18:48:47.947 | 31,405 / 29,056 / 432 / 233 |
| S19 | `seg_e957...264` | `req_6957...650` | `att_b5ec...eee` | 18:48:48.232-18:49:06.997 | 32,222 / 31,104 / 832 / 317 |

## Routing review

Common policy for all six successful routed Segments: preference `economy`, reasoning `medium`, user policy `all_routing_eligible`, explicit allowlist empty (meaning no Router restriction), legal canonical candidates `gpt-5.4-mini`, `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-5.5`. Selected and actual model always `gpt-5.6-luna`; selected and actual channel always Lucen `lucen-cx006-value-dynamic`; no Channel fallback occurred.

| Segment | Difficulty / confidence | Six factors: scope, context, reasoning, tools, constraints, verify | Quality target | Pareto frontier | Selection reason |
| --- | --- | --- | --- | --- | --- |
| `seg_e5c1...d3c` | 1.5 / 0.95 | 0.2, 0.3, 0.1, 0.0, 0.2, 0.1 | 72 | Luna | Luna had slightly lower risk-adjusted total cost than Mini while providing much higher quality. |
| `seg_18c3...694` | 45.1 / 0.95 | 5.5, 3.2, 4.0, 6.5, 3.5, 4.0 | 72 | Luna, Terra, Sol | Luna delivered the highest economy value; about 80% lower expected cost than the quality upper-bound choice. |
| `seg_a2d9...502` | 39.3 / 0.85 | 5.0, 2.8, 3.5, 4.5, 3.2, 3.8 | 80 | Luna, Sol | Luna delivered the highest value; about 81% lower expected cost. |
| `seg_0193...252` | 47.8 / 0.85 | 5.6, 3.8, 4.2, 5.0, 4.5, 4.8 | 72 | Luna, Terra, Sol | Luna delivered the highest value; about 82% lower expected cost. |
| `seg_6839...486` | 38.5 / 0.88 | 4.8, 3.8, 3.5, 4.2, 3.2, 3.0 | 72 | Luna, Sol | Luna delivered the highest value; about 84% lower expected cost. |
| `seg_e957...264` | 42.9 / 0.88 | 5.2, 3.2, 4.5, 4.8, 3.8, 3.6 | 80 | Luna, Terra, Sol | Luna delivered the highest value; about 83% lower expected cost. |
| `seg_30f7...40f` | no durable result | inherited metadata showed 42.9 but is stale | none | none | all 13 Responses Profiles were over the 32,768 context limit; no selection was possible. |

Mini was legal in every successful Segment. For the greeting its estimated call cost was lower (CNY 0.000787635 versus Luna CNY 0.00105018), but its risk-adjusted total was marginally higher (CNY 0.0024648812 versus 0.0024562317) and its estimated quality was lower (0.872301 versus 0.996412). Thus Luna won under the configured fallback-risk and quality utility formula.

For Luna, the same-model channel order in every routed Segment was: Lucen `cx006-value-dynamic`, Lucen `cx006-plus`, Lucen `cx008-plus-dedicated`, BlackAI `codex-mix-low`, CloseAI `openai-primary`. The first channel received a 0.99 reliability factor because it accepted the declared Web tool; no fallback was needed.

Excluded Profiles on successful Segments were the six Messages profiles. Primary reason: native protocol mismatch; `local_tool` incompatibility was secondary. No fixed canonical model was excluded. On the final Segment, all five fixed canonical models were excluded because every Responses execution profile had `contextWindow=32768`.

### Candidate estimates

Values are `estimated quality / estimated call CNY / expected total CNY`; `*` marks Pareto-efficient.

| Segment | Mini | Luna | Terra | Sol | GPT-5.5 |
| --- | --- | --- | --- | --- | --- |
| `seg_e5c1...d3c` | 0.872301 / 0.000787635 / 0.0024648812 | 0.996412 / 0.001050180 / 0.0024562317* | 0.966580 / 0.002625450 / 0.0040966872 | 0.956368 / 0.013127250 / 0.0146208028 | 0.951810 / 0.630108000 / 0.6314804056 |
| `seg_18c3...694` | 0.291357 / 0.000795780 / 0.0037664700 | 0.778876 / 0.001061040 / 0.0029565314* | 0.794522 / 0.002652600 / 0.0045135838* | 0.835934 / 0.013263000 / 0.0150326516* | 0.721026 / 0.636624000 / 0.6385147501 |
| `seg_a2d9...502` | 0.380600 / 0.000822915 / 0.0037565987 | 0.853538 / 0.001097220 / 0.0029557800* | 0.844518 / 0.002743050 / 0.0046221157 | 0.869718 / 0.013715250 / 0.0155370282* | 0.782173 / 0.658332000 / 0.6602163961 |
| `seg_0193...252` | 0.252341 / 0.001243755 / 0.0054431153 | 0.735430 / 0.001658340 / 0.0042512437* | 0.766296 / 0.004145850 / 0.0066361116* | 0.816928 / 0.020729250 / 0.0230511410* | 0.687493 / 0.995004000 / 0.9975567881 |
| `seg_6839...486` | 0.393742 / 0.001359495 / 0.0053024722 | 0.861868 / 0.001812660 / 0.0040634845* | 0.850342 / 0.004531650 / 0.0068241383 | 0.873687 / 0.022658250 / 0.0248663519* | 0.789512 / 1.087596000 / 1.0898914886 |
| `seg_e957...264` | 0.324166 / 0.001378710 / 0.0056123769 | 0.810259 / 0.001838280 / 0.0042914989* | 0.815190 / 0.004595700 / 0.0070308554* | 0.849860 / 0.022978500 / 0.0252866681* | 0.745970 / 1.102968000 / 1.1054369250 |
| `seg_30f7...40f` | excluded: context window | excluded: context window | excluded: context window | excluded: context window | excluded: context window |

Web intent was stored as `not_required` in Route Decision formula inputs. `webIntentSource` was absent in these production rows. One successful step (`S14`) actually emitted Web Search events despite `not_required`; this does not change model/accounting conclusions.

## Provider billing reconciliation

ACU aggregate Provider Usage: input 402,886 total, of which cached 351,360 and uncached 51,526; output 8,783; reasoning 1,381. Reasoning tokens are a subset of output and were not charged again.

`nominal_provider_cost_usd = 51,526*1e-6 + 351,360*0.1e-6 + 8,783*6e-6 = 0.139360`

`provider_balance_charge_usd = 0.139360 * 0.06 = 0.0083616`

Lucen recharge cash ratio is CNY 500 / USD 500 credits, so `effective_cash_cost_cny = 0.0083616`.

Against the supplied Lucen observation (cached 351,400, nominal USD 0.139364, balance USD 0.00836184), the database is lower by 40 cached tokens, USD 0.000004 nominal and USD 0.00000024 balance; absolute percentage error is 0.002870%.

| Step | Nominal provider USD | 0.06 balance / cash CNY | Judge USD | New API user charge USD | Quota ledger |
| --- | --- | --- | --- | --- | --- |
| S01 | 0.0108076 | 0.000648456 | 0.00109230 | 0.01189990 | 5,950 |
| S02 | 0.0027476 | 0.000164856 | 0.00109905 | 0.00384665 | 1,923 |
| S03 | 0.0031716 | 0.000190296 | 0.00120735 | 0.00437895 | 2,189 |
| S04 | 0.0038206 | 0.000229236 | 0 | 0.00382060 | 1,910 |
| S05 | 0.0145266 | 0.000871596 | 0 | 0.01452660 | 7,263 |
| S06 | 0.0037890 | 0.000227340 | 0 | 0.00378900 | 1,895 |
| S07 | 0.0223934 | 0.001343604 | 0 | 0.02239340 | 11,197 |
| S08 | 0.0124396 | 0.000746376 | 0 | 0.01243960 | 6,220 |
| S09 | 0.0056806 | 0.000340836 | 0 | 0.00568060 | 2,840 |
| S10 | 0.0057640 | 0.000345840 | 0 | 0.00576400 | 2,882 |
| S11 | 0.0057584 | 0.000345504 | 0.00124755 | 0.00700595 | 3,503 |
| S12 | 0.0049924 | 0.000299544 | 0 | 0.00499240 | 2,496 |
| S13 | 0.0033192 | 0.000199152 | 0.00124545 | 0.00456465 | 2,282 |
| S14 | 0.0060682 | 0.000364092 | 0.00124545 | 0.00731365 | 3,657 |
| S15 | 0.0043212 | 0.000259272 | 0 | 0.00432120 | 2,161 |
| S16 | 0.0056226 | 0.000337356 | 0 | 0.00562260 | 2,811 |
| S17 | 0.0070704 | 0.000424224 | 0 | 0.00707040 | 3,535 |
| S18 | 0.0078466 | 0.000470796 | 0 | 0.00784660 | 3,923 |
| S19 | 0.0092204 | 0.000553224 | 0 | 0.00922040 | 4,610 |
| Total | 0.1393600 | 0.008361600 | 0.00713715 persisted | 0.14649715 | 73,247 |

Each ACU Attempt, ACU Usage Report and New API finalize agrees exactly on tokens and nominal Provider cost. There were no failed Provider Attempts and no failed billed Provider costs.

Per-Logical-Request ACU-versus-New-API token/cost absolute error is zero for all nineteen rows. A per-request Lucen-page comparison is unavailable because the supplied Provider evidence was aggregate-only; only the aggregate 40-token discrepancy can be measured.

## New API charge reconciliation

- Billing basis: `final_user_cost_usd = nominal_provider_cost_usd + judge_cost_usd + failed_billed_cost_usd`.
- Persisted Provider cost: USD 0.1393600.
- Persisted/charged Judge cost: USD 0.00713715 (six live Judges).
- Failed Provider Attempt cost: USD 0.
- New API declared user charge: USD 0.14649715.
- Actual quota decrease: 73,247 / 500,000 = USD 0.146494.
- Finalized-ledger rounding difference: USD 0.00000315, 0.002150%; this portion meets 1%.
- Unpersisted failed-segment Judges: USD 0.00124605 + USD 0.00124515 = USD 0.00249120. These were live, reported-usage calls present in Judge cache but absent from Judge Evaluation, Usage Report and New API finalize tables.
- Full incurred nominal cost: USD 0.14898835. Difference versus New API declared charge: USD 0.00249120, 1.672077%. Difference versus actual quota decrease: USD 0.00249435, 1.674191%. Full-session target fails.

The Lucen 0.06 multiplier is not duplicated; it is not applied to the New API user charge at all. The CNY/USD recharge ratio is not applied in New API billing. Cached input uses USD 0.10/M correctly. Reasoning is not double-counted. Persisted Judges are charged once; two failed-route Judges are omitted. Failed New API/ACU admission requests have zero user charge.

Judge effective cash uses the configured CloseAI settlement ratio CNY 7.2 per USD credit. All eight live Judge calls cost USD 0.00962835 balance, equivalent to CNY 0.06932412. Total actual cash including Lucen is CNY 0.07768572.

## BlackAI isolation

BlackAI Provider Attempts in this Session and audit window: `0`. The earlier 00:38-01:32 +08:00 Profile tests are not included in any Task, Provider-cost or cash-cost total here.

## Final 502

The final human input entered New API at 18:50:46 UTC and created `seg_30f71b9ce3bf41ce82dfe6f88d17e40f`, but no Logical Request, Step ID, Route Decision, selected model/profile/channel or Attempt was created. Within the strict window there were eight 502 requests through 18:51:00; Codex continued retrying outside the window to 18:51:26, for thirty New API 502 responses total.

- Endpoint reaching New API: `POST /v1/responses`; Nginx upstream `127.0.0.1:3200`; ACU execution endpoint is internal.
- HTTP status: 502 from New API, carrying the ACU error `No compatible Alpha execution profile supports required tool capabilities: function, local_tool`.
- Provider endpoint/status: none; no Provider request was sent.
- SSE bytes: none. Nginx returned a 180-byte JSON error response, not an established Provider SSE stream.
- Provider Usage / charge: none / zero.
- Attempts/fallback: zero Attempts, so same-model Channel fallback did not trigger.
- Circuit/cooldown: selected circuit does not exist; the last used Lucen channel remained healthy and no cooldown was created.
- Pending: zero Logical Requests and zero Usage Reports pending.

Root source is ACU Router admission. Cloudflare and Nginx transported the 502; New API surfaced it. The persisted Nginx format does not record `CF-Ray`, so `a22e50a16caecf58-FRA` cannot be mapped to one exact retry row, but every request in the terminal retry cluster has the same ACU error and zero Provider activity.

The high-confidence exclusion cause is context-window exhaustion: all thirteen Responses Profiles have a 32,768 window, the last successful Provider input was 32,222 tokens, and routing checks the larger next raw request using `ceil(rawBytes/4)`. The error branch reports required tool types whenever the eligible set is empty, masking `context_window`. This is not `potential_router_defect` under the requested definition because no first Provider 502 occurred and no replay/fallback opportunity was reached. It is nevertheless a router admission defect for continuous use.

Nginx also returned ten `limit_conn` 503 responses during concurrent client requests: one at 18:43:20 and nine at 18:48:17-18:48:22. The client recovered and the later Provider steps succeeded. These requests never entered New API/ACU and incurred no cost.

## Model plaza audit

| ID | Display name | Pricing | Founder `/v1/models` | Active Responses channels |
| --- | --- | --- | --- | --- |
| `acu-auto` | ACU Auto Router | visible | visible | routes dynamically |
| `gpt-5.4-mini` | GPT-5.4 Mini | visible | missing | 2 |
| `gpt-5.6-luna` | GPT-5.6 Luna | visible | missing | 5 |
| `gpt-5.6-terra` | GPT-5.6 Terra | visible | missing | 3 |
| `gpt-5.5` | GPT-5.5 | visible | missing | 1 |
| `gpt-5.6-sol` | GPT-5.6 Sol | visible | missing | 2 |

The Pricing backend returns the expected six-entry structure and channel 1 advertises all six IDs. The Founder token has `model_limits_enabled=true` with `model_limits=acu-auto`, so authenticated `/v1/models` returns only `acu-auto`. The New API `models` table contains none of the five fixed canonical rows. ClawRouter curves and actual `acu-auto` routing contain all five fixed canonical models. Thus Pricing, `/v1/models`, token permissions and Router visibility are inconsistent.

## Findings

### P0

None found.

### P1

1. Continuous-use context ceiling: every active Responses Profile is capped at 32,768; the Session exhausted the entire pool and failed before Logical Request creation. The error incorrectly reports tool capability instead of context window.
2. Failed-route Judge leakage: two live Judge calls (USD 0.0024912) were incurred but never persisted, charged or attached to the failed Segment. Full reconciliation misses the 1% goal.
3. The final human Segment's live Judge results remained focused on the old design task, so the new Gitee/DNS/server goal was not represented correctly before route admission failed.
4. Model visibility mismatch: Pricing shows six models while the Founder Key `/v1/models` exposes one and the New API model table exposes none of the fixed five.

### P2

1. New API labels and charges nominal Provider cost even though metadata separately knows Provider balance and effective cash cost; the billing basis is not the actual Lucen cash-cost basis.
2. Origin IP and CF-Ray are not durably correlated in Nginx/New API records, limiting exact edge-request forensics.
3. Nginx `limit_conn=1` caused ten transient 503 responses during normal Codex concurrency, although the client recovered.
4. Production Route rows store `webIntent` but not `webIntentSource` for this Session.

## Audit controls

During evidence collection, no Provider request, Preflight, health mutation, configuration/database change, main merge, force push or product-code commit was performed. Only these two report artifacts were created. Their later Git commit and push are delivery actions requested after the audit and do not alter the audited production state.
