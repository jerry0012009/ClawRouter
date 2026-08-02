# ACU next-phase read-only audit

## Baselines

- ClawRouter local/remote/deployed: `55638ea9e0886a8a219444560c94b32c18d0fdb8`
- New API local/deployed: `3d950908fe13bbf7449410199c6b76fd71d4d91f`; fork branch contains this commit. New API had an unrelated untracked screenshot before the audit and was not modified.
- Router image: `sha256:466db6127da3c331ebd0504f95c0f74be0567e4d1e803ce5023685793ee05761`
- New API image: `sha256:7880828f1699e5a3f6ee3c065814847bf4f2cfd7c0dca120814801e979b94a7d`
- Databases: PostgreSQL `acu_alpha` and `newapi_alpha` on the isolated Compose network. All SQL used read-only mode.
- Services observed: Router, New API and both PostgreSQL containers running/healthy. Nothing was restarted or rebuilt.

## Main findings

1. Judge is materially unstable: auditable 7d New Judge rules fallback is 21.053%; latest 24h is 23.077%, and the last two 1h New calls both failed three attempts and reused recent evaluation.
2. Judge shares Profile catalog and reads Channel/Profile runtime eligibility, but does not share failure classification, health writes, circuit updates or probe scheduling. Its Profile ranking is preferred-ID then lexical, not cost/latency/success.
3. Public Pricing is canonical-only, while Corridor already carries complete Luna Max identity. New API proxies those fields, but frontend types/rendering collapse candidates by `modelId`.
4. Timeline's intended scroller is its root; document ancestors are overflow-hidden. ECharts deliberately consumes wheel over the chart for zoom. Exact live DOM truncation outside the chart could not be tested without a safe Dashboard session.
5. Router Trace contains most desired observability fields; New API Timeline and Session Trace DTOs discard many of them.

## Evidence index

- `commit-history.md`
- `judge-health-architecture.md`
- `judge-audit-summary.md` and five CSV files
- `judge-controlled-probes.md`
- `pricing-luna-max.md` and two sanitized JSON samples
- `timeline-scroll-analysis.md`, `timeline-scroll-dom.json`
- `timeline-data-gap.md`, `timeline-sample-traces.md`
- `router-trace-field-sample.json`
- all read-only SQL under `sql/`
- five anonymous Pricing PNGs under `screenshots/pricing/`

No Timeline PNG is present because a safely authorized Dashboard session was unavailable. No source, test, configuration, environment variable, database row, container or deployed artifact was changed.

## Candidate directions

**待第二轮设计确认，不是本轮实施建议。** Candidate topics are a shared Judge outcome-to-health contract, Judge-aware error scope, candidateId-aware Pricing UI, and explicit Timeline scroll/wheel ownership plus richer Trace projection.
