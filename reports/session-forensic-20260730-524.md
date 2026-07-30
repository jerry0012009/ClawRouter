# ACU Session Forensic: 2026-07-30 HTTP 524

## Scope and production identity

This is a read-only reconstruction of New API request
`202607301407205904956958268d9d6PdNvxwnv`. No provider call was made.

| Component | Running commit | Health |
| --- | --- | --- |
| ClawRouter | `64f06b6ae6b7f84acd1c19b0e847c507ce9ac269` | healthy |
| New API | `f860a89a422c15c1c295fe8800189eb0a0ef8709` | healthy |

Latest applied Router migration: `0009_raw_judge_context`.

The production Router was behind the requested source baseline
`41057d13b68890b1ba71ba2e528a6ab492638c1a`; all conclusions below use the
running build and durable production evidence.

## Correlation

| Record | Value |
| --- | --- |
| Logical request | `req_4fb0f1b607cb47e9831daf6c15eda523` |
| Session | `ses_8b6f42cb864943cbbe9acfb0912f5c33` |
| Task | `task_277cb68ae15c449e909024a5584d2cd7` |
| Segment | `seg_0accfb9402b74510b18ef588ae6b6454` |
| New API consume log | `509` |
| New API error log | `512` |
| Usage finalize | `392` |
| Finalize idempotency key | `a51b36...` |

The consume/finalize row and error row have the same New API request ID. They
are two durable events for one logical request, not two user requests.

## Time waterfall

All timestamps are UTC on 2026-07-30.

| Stage | Start | End | Duration | Result |
| --- | --- | --- | ---: | --- |
| New API ingress | 14:07:20 | 14:10:01 | about 161 s | HTTP 524 logged |
| Router ingress/state/segment | 14:07:21.040 | about 14:07:21.223 | about 0.18 s | reused task, created/resolved segment state |
| MiMo primary Judge | about 14:07:21.223 | 14:07:55.420 | 34.197 s | success; no backup |
| Route decision | 14:07:55.420 | 14:07:55.589 | 0.169 s | selected Luna/Lucen |
| Provider attempt 1 | 14:07:55.743 | 14:10:00.961 | 125.218 s | HTTP 524 |
| Logical request finalize | 14:10:00.961 | 14:10:01.011 | 0.050 s | failed, Judge-only charge |
| New API finalize | 14:10:01 | 14:10:02 | about 1 s | durable settlement recorded |

The 2m40s wall time consists primarily of 34.197s Judge latency and 125.218s
waiting on the execution provider. Local state and routing consumed less than
one second.

## Judge and route

- Primary Judge: `mimo-v2.5-pro` via `xiaomi_mimo`.
- Judge calls: 1; status: success.
- Backup Judge: not called.
- Judge input/output: 115,301 / 269 tokens.
- Difficulty/confidence: 49.4 / 0.82.
- Judge charge: CNY 0.1737585.
- Selected canonical model: `gpt-5.6-luna`.
- Selected Provider/channel: `lucen` / `lucen-cx006-plus`.
- Selection reason: Luna had the highest Economy value utility and an expected
  cost about 27% below the quality ceiling. The Pareto set was Luna, Terra and
  Sol.

## Provider failure and visible output

There was one execution attempt. `lucen.cc` returned a Cloudflare HTML 524
page after 125.218 seconds:

- `server: cloudflare`
- `cf-ray: a234eeb64dda025d-CDG`
- `retry-after: 120`
- response content type: `text/html`
- persisted response body size: 7,710 bytes

No model SSE token or other user-visible model output was emitted before the
failure. The persisted `visible_output_bytes=7710` counts the Cloudflare HTML
error body, so it must not be interpreted as model output or a successful
first byte.

## Unique primary cause

The user-visible failure was an **entry Cloudflare connection timeout while
New API was still waiting for the first model SSE byte**. The underlying delay
was the Lucen execution channel's first-byte wait. After the entry connection
had already closed, Lucen's own Cloudflare independently returned HTTP 524 to
the Router.

Evidence:

- Local Nginx `proxy_read_timeout` is 600 seconds, excluding the local reverse
  proxy as the 160-second limit.
- Nginx recorded 499 at 16:09:25 +0200, about 125 seconds after ingress,
  showing the outer client/Cloudflare connection closed before Router
  completion.
- Router and New API continued until the provider-side Cloudflare 524 arrived
  at 14:10:00 UTC.
- The provider response carried `server=cloudflare` and the CDG CF-Ray above.
- There was no model SSE first byte before either timeout.

No evidence indicates a Router fixed total timeout, New API timeout, Judge
failure, DeepSeek fallback, or local Nginx timeout.

## Why channel recovery did not run

The running Router recognizes 429, 500, 502, 503 and 504 as recoverable
provider statuses. It does not recognize 524, so no second channel was tried.
The database also records `visible_output_bytes=7710`. Although those bytes
are the non-SSE Cloudflare error page, the explicit patch condition for this
task requires the stored value to be zero. Therefore this change does not add
524 recovery.

## Billing

The provider billed cost was zero. The logical request settled only the
successful Judge charge, CNY 0.1737585. There was no duplicate charge: the raw
error event and finalize event share one logical request and one idempotent
usage report.

## Minimal external remediation

The outer timeout is outside Router recovery policy. A DNS-only long-connection
API hostname that bypasses the entry Cloudflare proxy is the smallest targeted
remediation. Native Codex SSE semantics should remain unchanged; no custom SSE
business event should be injected without separate compatibility evidence.
