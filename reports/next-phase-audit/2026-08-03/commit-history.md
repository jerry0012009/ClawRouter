# ACU health and Judge history

Audit baseline: ClawRouter `55638ea9e0886a8a219444560c94b32c18d0fdb8` (2026-08-02). The requested path log and case-insensitive commit-message searches were run across all refs.

| Commit | Date | Message | Material files | Current meaning |
|---|---|---|---|---|
| `9f737cb6` | 2026-07-27 | Fix ACU quality fallback and runtime health | `src/acu/storage.ts`, `src/acu/execution-profile.ts` | Original SQLite/demo `execution_profile_health`: consecutive timeouts, recent rate, cooldown and priority penalty. Historical ancestor only; superseded by PostgreSQL health. |
| `f001fa3f` | 2026-07-29 | feat: add PostgreSQL persistence foundation | migrations, `src/alpha/repository.ts` | Established durable Alpha records. Still foundational. |
| `a9c4342e` | 2026-07-29 | feat: add provider attempt and recovery control | `execution.ts`, `processor.ts`, repository | Introduced provider Attempt/recovery ownership. Still the main-call recovery foundation. |
| `753c4b77` | 2026-07-29 | feat: add provider channel registry and health recovery | `channel-health.ts`, `channel-registry.ts`, `processor.ts`, `routing.ts`, migration `0002` | Replaced the demo model with PostgreSQL Channel and Profile circuit state, outcome classification and runtime routing filters. Current architecture. |
| `24fe6f14` | 2026-07-29 | fix: admit one half-open channel probe | processor, repository | Atomic half-open claim/release. Still active. |
| `54156257` | 2026-07-30 | fix(alpha): close idempotency and channel recovery gaps | processor, repository, migration `0008` | Hardened request persistence and recovery. Still active, later extended. |
| `9494f35c` | 2026-07-30 | feat(alpha): expand verified supply and channel observability | server, repository, execution profiles, migration `0010` | Added supply/runtime observability and verified profile metadata. Still active. |
| `9cbf8833` | 2026-07-30 | feat(alpha): add verified model pool and adaptive probes | `adaptive-probe.ts`, server, repository, migration `0011` | Added demand-aware probes, probe queue and recovery writes. Still active. |
| `1c98b129` | 2026-07-31 | fix(alpha): retain supply profiles and recover probes | adaptive probe, health, registry, routing, server | Kept temporarily unavailable supply visible and made recovered profiles eligible after freshness checks. Still active, refined below. |
| `32188e83` | 2026-07-31 | fix(alpha): improve routing health and plan reasoning | processor, routing | Integrated runtime success rate/latency into main Profile selection. Health semantics remain active; planning behavior was later replaced by Work Phase. |
| `86d59f14` | 2026-08-01 | fix(alpha): classify delivery and tighten profile recovery | health, adaptive probe, execution, processor | Refined failure scope and neutral client cancellation. Still active. |
| `e9c7edf2` | 2026-08-01 | fix(alpha): bound Judge and preserve native context policy | `judge-runner.ts`, judge context policy | Added bounded Judge deadline and native-context behavior. Still active. |
| `f3a24432` | 2026-08-01 | fix(alpha): fail over Judge across Luna channels | `judge-profile-selector.ts`, `judge-runner.ts`, server, migrations `0014/0015` | Added Judge-specific Luna Profile eligibility and up to three same-model Profile attempts. Still active; it consumes shared health snapshots but does not write them. |
| `98770881` | 2026-08-01 | fix(alpha): restore profile-scoped supply recovery | adaptive probe, health, execution, processor, repository | Corrected Profile-scoped cooldown/probe recovery. Still active. |
| `9f18298e` | 2026-08-01 | fix(alpha): bound targeted recovery freshness | adaptive probe, processor, server | Bounded targeted probe demand/freshness. Still active. |
| `4340947c` / `0c5604bf` | 2026-08-01 | context overflow reroute fixes | execution, processor | Main Router context recovery across models and trace classification. Active; Judge uses a separate terminal context path. |
| `4691b063` | 2026-08-02 | feat(router): add work-phase routing and luna max preset | processor, routing, decision, catalogs | Current Work Phase/Preset observability baseline; unrelated health machinery unchanged. |
| `55638ea9` | 2026-08-02 | fix(router): preserve explicit reasoning effort semantics | processor, execution, repository | Current deployed head. No Judge health unification. |

## Evolution finding

`9f737cb6` must not be read as the present design. Its local SQLite timeout/recent-rate view was replaced by `753c4b77`'s durable `acu_channel_health` and `acu_provider_model_profile_health`, then extended with half-open claims (`24fe6f14`), adaptive queue/probes (`9cbf8833`) and recovery/freshness corrections (`1c98b129`, `98770881`, `9f18298e`). Judge Profile failover arrived later as a parallel consumer (`f3a24432`): it reads the current PostgreSQL snapshots, but its failures do not pass through their update pipeline.

## Commands

The full path-scoped command and message searches requested by the audit were executed. Relevant changes were verified with `git show`, `git diff-tree`, migration history and current call sites; generated `dist` changes were not treated as independent semantics.
