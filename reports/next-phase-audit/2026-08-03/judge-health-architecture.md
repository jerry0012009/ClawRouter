# Judge versus main Router health architecture

| Capability | Main model call | Judge | Shared implementation | Code location |
|---|---|---|---|---|
| Profile Catalog | Full execution profiles | Same catalog, Luna/Responses subset | Yes, catalog | `server.ts:180-255`, `judge-profile-selector.ts:10-24` |
| Channel Health | Reads and writes PostgreSQL snapshot | Reads snapshot for eligibility | Read only | `processor.ts:545-588`, `server.ts:267-292` |
| Profile Health | Reads/writes Profile snapshot | Reads Profile snapshot | Read only | same |
| Runtime Eligibility | `deriveRuntimeEligibility`, then route exclusions | Same derived object, simpler Judge exclusions | Partial | `processor.ts:565`, `server.ts:286`, selector |
| Cooldown/open | Blocks normal route | Blocks Judge candidate | Yes for filtering | selector lines 19-23 |
| Half-open | Atomic claim for eligible probe | Excluded from Judge | No execution sharing | repository `claimHalfOpenProbe`; selector line 21 |
| Adaptive Probe | Demand/queue worker | No Judge enqueue | No | `adaptive-probe.ts`; `processor.ts:2044-2052` |
| Probe Recovery | Updates runtime, re-enters catalog | Re-enters on next `loadProfiles` | Indirect | server lines 267-292 |
| Profile ordering | Effective cost, health penalty, success rate, latency, web | Preferred ID first, rest lexicographic ID | No | `routing.ts:265-277,485-492`; selector lines 26-32 |
| Provider cost ordering | Yes | No | No | routing score versus selector |
| Latency ordering | Small penalty | No | No | routing line 271 |
| Recent success ordering | Divides score by success rate | No | No | routing lines 270-277 |
| Same-model Profile retry | Recovery targets after classified failure | Sequential Luna candidates | Separate | `execution.ts`; `judge-runner.ts:288-307` |
| Network endpoint retry | Main + `networkFallbackBaseUrlEnvs` | Primary Base URL only | No | `server.ts:229-253,295-307` |
| Failure -> Profile health | `classifyAttemptOutcome` + `applyAttemptOutcome` | Not called | No | `processor.ts:2020-2056` |
| Failure -> Channel health | Same, when channel-scoped | Not called | No | same |
| Judge format errors | Normalized as `invalid_response`, parser detail in in-memory `judgeRun` | Judge-only | No shared health effect | `acu/judge.ts:559-614` |
| Context errors | Main context admission/re-route | Judge terminal rules strategy | No | `execution.ts`; `judge-runner.ts:390-440` |
| Backup model | Main Router chooses candidates | Configured synchronous Judge backup on eligible failures | Judge-specific | `judge-runner.ts:316-329` |

## Direct answers

1. Judge failure does **not** call `applyAttemptOutcome`, `classifyAttemptOutcome`, Channel/Profile runtime writes, `wakeProbe`, or `adaptiveProbe.enqueue`. Those calls are in the Provider Attempt path only.
2. Normalized Judge attempts are saved to `acu_judge_attempts`; the richer attempt chain is also embedded in Segment `metadata_json.judgeRun`. Judge failures do not change `profile_runtime`, `channel_runtime`, cooldown or probe scheduling.
3. Judge eligibility filters model/provider-model, Responses protocol, enabled/admin/verification/auto-route/usage-trusted, health and context ceiling. Ordering is configured `preferredProfileId` first, then `executionProfileId` lexical order. It does not rank cost, latency or recent success rate.
4. Yes. A preferred Profile that remains eligible is always first even if degraded: `degraded` is not excluded. Its Judge-only timeout/JSON failures never update shared health, so it can remain first indefinitely.
5. Judge clients are constructed with each Profile's primary `judgeBaseUrl`. Main adapters construct all `networkFallbackBaseUrlEnvs`; Judge does not use those alternate endpoints.
6. Yes, indirectly. A probe-recovered Profile is seen by Judge on the next dynamic `loadProfiles`, subject to Luna/Responses and all Judge filters. Judge itself does not trigger that probe.
7. Main-call success can keep a Profile `healthy` while Judge JSON/schema parsing repeatedly fails. Current evidence: both BlackAI Judge failover Profiles have 17 `SyntaxError/invalid_response` failures but runtime state `healthy`, zero consecutive failures, and no queued probe.
8. Judge distinguishes HTTP/context/network/timeout/invalid response at its own level. JSON and schema/content parsing are collapsed to `invalid_response`; parser exception type exists only in Segment `judgeRun`, not normalized `acu_judge_attempts`. This distinction does not feed shared runtime health.

`safe_profile_fallback` is present in the TypeScript union but has no production return path or persisted row in the audited code/data.

## Evidence for unification

There is strong evidence that the current split hides operational failures: 34 BlackAI Judge format failures and 17 preferred Lucen timeout/502 failures coexist with healthy main-call runtime snapshots. This is evidence supporting a second-round design discussion, not an implementation decision in this audit.
