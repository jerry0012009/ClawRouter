# ACU Router Pass-through Responsibility Audit

Date: 2026-07-30  
Code baseline: ClawRouter `1e111dcc6e37ee6f69fc1ba82090118645944ed8`; New API `f860a89a422c15c1c295fe8800189eb0a0ef8709`

## Classification

- **A**: upstream model, Provider, or protocol capability.
- **B**: security, authentication, secret handling, or tenant isolation.
- **C**: bounded recovery, idempotency, cancellation, or resource protection.
- **D**: local restriction without sufficient capability or safety evidence.
- **E**: external platform restriction not controlled by ACU code.

## Executive findings

The active Founder path is `Codex -> Cloudflare -> Nginx :8443 -> New API -> acu-router -> Judge/execution Provider`. The Alpha Router itself has no execution-provider total timeout and relays streaming chunks as they arrive. Five active D-class restrictions were found: a local approximate Judge context rejection at 262,144 tokens, a unified 20-second Judge total timeout, a 32 MiB Router body limit below the adjacent safety boundary, intent-based removal of a user-declared Web tool, and an automatic Router workspace gate requiring Git plus `workspace-write`. They are removed or made observational in this patch.

MiMo-V2.5-Pro and the current DeepSeek V4 family both publish 1M context specifications. The Xiaomi Token Plan endpoint has historical exact-model and protocol evidence but no paid 700K/1M boundary test; CloseAI has exact `deepseek-v4-flash` evidence but no verified 1M boundary test. The metadata therefore separates official declared capability from endpoint observation. Local token estimates no longer reject Judge input.

## Request body and persistence

| Layer | Location | Before / setter | Upstream basis | Impact | Class | Decision and post-change behavior |
|---|---|---|---|---|---|---|
| Cloudflare | proxied `eu.jerrypsy.top:8443` | plan-dependent request/body limits; `server: cloudflare` observed | external platform | may reject before origin | E | Observe and report Cloudflare error; ACU cannot raise it. |
| Nginx | `/etc/nginx/sites-available/acu-founder-alpha.conf`; versioned `deploy/alpha/nginx-founder-alpha.conf` | 16 MiB, operator config | no model basis | first local 413 for bodies over 16 MiB | D -> B | Align to New API's 128 MiB decompressed safety boundary. It is explicitly a resource boundary, not context capability. |
| New API compressed input | `middleware/gzip.go`, `common/init.go` | `MAX_REQUEST_BODY_MB`, default 128 MiB after gzip/br decode | security/resource basis | rejects decompression bombs with 413 | B | Keep configurable 128 MiB decompressed boundary. |
| New API request storage | `common/gin.go`, `common/body_storage.go` | same 128 MiB; spills large bodies to disk | security/resource basis | bounded disk/memory use | B | Keep. ACU body remains byte-preserved after storage. |
| New API anonymous input | `middleware/request_body_limit.go` | 512 KiB anonymous only | tenant/security basis | unauthenticated request protection | B | Keep; Founder API is authenticated. |
| Router HTTP body | `src/alpha/gateway.ts`, `ACU_MAX_REQUEST_BODY_MB` | 32 MiB hard-coded | no independent basis | could reject a request accepted by New API | D -> B | Align to configurable 128 MiB. 33 MiB fixture reaches the adapter. |
| Router JSON parser | `src/alpha/gateway.ts` | full `JSON.parse` after body read | protocol requirement | malformed JSON returns 400 | B | Keep; no history/item-count filtering. |
| Judge request payload | `src/alpha/processor.ts`, `acu_payloads` | complete raw request, 90-day retention | audit requirement | storage grows with native request | C | Keep complete payload with secret sanitization; no payload character truncation. |
| Provider/Judge response audit | `src/alpha/stream-relay.ts`, `acu_payloads` | full response buffered/persisted | audit requirement | memory scales with response | C/observe | Keep for Alpha evidence; monitor memory. No arbitrary response-size rejection added. |

## Token and context

| Layer | Location | Before / setter | Capability evidence | Impact | Class | Decision and post-change behavior |
|---|---|---|---|---|---|---|
| Codex metadata | isolated `/root/.local/share/codex-acu/config.toml` and catalog | context 1,050,000; auto compact 900,000 | Canonical ACU contract | client compacts near 900K | A | Keep; original `~/.codex` is untouched. |
| Judge Primary | Xiaomi public MiMo-V2.5-Pro model page; `src/acu/catalog/model-catalog.json` | Router used 262,144; production exact model `mimo-v2.5-pro` | official 1M context, 128K max output; endpoint boundary not paid-tested | Router rejected well before public capability | D -> A/observe | Metadata is 1,000,000 with official source. Full raw request is sent; estimate is metrics only. |
| Judge Backup | DeepSeek official Models & Pricing; CloseAI evidence | shared 262,144 value | official DeepSeek V4 1M; CloseAI 1M boundary unverified | shared value obscured independent capability | D -> A/observe | Separate backup metadata at 1,000,000 with endpoint verification caveat. A Primary context error does not trigger Backup because Backup is not verified larger. |
| Judge estimate | `src/acu/judge.ts` | ASCII/4 plus non-ASCII estimate used as hard gate | approximation only | false 400 before Provider | D | Estimate remains in trace/cost metrics but never blocks. `contextTruncated=false`; raw section is unchanged. |
| Judge output | `src/acu/judge.ts` | internal `max_tokens=300` | bounded JSON classifier contract | limits Judge output, not user output | C | Keep as Judge protocol/runtime protection. No explanation/reason character limit or evidence-array count limit. |
| Canonical execution context | `src/alpha/context-admission.ts`, execution profile catalog | canonical advertised window plus explicit Provider hard caps | Canonical/provider metadata | admission may reject execution model | A/observe | Keep existing RC2 admission unchanged by scope. Estimates remain a known residual risk; explicit hard caps take precedence and errors are differentiated. |
| Auto compact | Codex isolated config | 900,000 | client behavior | client may compact before 1.05M | A | Keep client-declared behavior; Router does not compact or reorder. |

## Time limits and streaming

| Layer | Location | Current value / setter | Basis | Impact | Class | Decision and post-change behavior |
|---|---|---|---|---|---|---|
| Cloudflare connection | external proxy | plan/platform-dependent | external | may terminate origin connection | E | Record as external; do not present as Router policy. |
| Nginx read/send idle | Founder Nginx site | 600 s between I/O operations | operational proxy protection | silent stream longer than 600 s can close; active chunks reset idle | C | Keep. It is not a fixed total request deadline. |
| Nginx Founder concurrency | `/etc/nginx/conf.d/acu-founder-alpha-limits.conf` | one concurrent connection per source IP on `/v1/responses` | five-day Founder isolation | a second truly concurrent request from the same IP is rejected/delayed | B/C | Keep for the single-Founder Alpha; record as tenant isolation, not model capability. Re-audit before multi-user rollout. |
| New API connect/TLS | Go `http.Transport` in `service/http_client.go` | Go transport defaults; TLS handshake 10 s | connection failure protection | failed connection terminates promptly | C | Keep; distinct from total response time. |
| New API total relay | `RELAY_TIMEOUT` | production unset/default 0 | pass-through | no fixed total client timeout | C | Keep disabled for ACU. |
| New API SSE idle | `STREAMING_TIMEOUT` and `stream_scanner.go` | default 300 s, reset for every valid data event | stalled-stream protection | five minutes without data ends relay | C | Keep configurable idle timeout. Continuous data is not interrupted. |
| New API ping helper | `stream_scanner.go` | ping helper stops after 30 minutes | goroutine protection | keepalive pings stop; data relay continues | C/observe | Keep, document distinction; not a total stream cutoff. |
| Router execution Provider | `src/alpha/provider.ts`, gateway abort signal | no local total/idle timer | native pass-through | Provider may run while client remains connected | C | Keep; client cancellation propagates to fetch. |
| Judge first byte | `src/acu/config.ts`, `src/acu/judge.ts` | before: part of 20 s total; after: `ACU_JUDGE_FIRST_BYTE_TIMEOUT_MS`, default 0 | no verified long-context threshold | false timeout on long-context classification | D -> observe | Disabled by default; independently configurable and error category remains `timeout` if enabled. Runtime connect failure protection remains. |
| Judge total | same | before: `ACU_JUDGE_TIMEOUT_MS=20000`; after: `ACU_JUDGE_TOTAL_TIMEOUT_MS`, default 0 | no verified capability basis | aborted valid long request | D | Disabled by default; no unified 20 s deadline. |
| Logical request lease | processor/repository state | 10 minutes | stale-lock/idempotency protection | stale requests become recoverable | C | Keep; not a task execution timeout and does not cancel an active Provider stream. |

## Output and protocol transparency

| Item | Location / current behavior | User impact | Class | Decision |
|---|---|---|---|---|
| `max_tokens` / `max_output_tokens` | raw Alpha body forwarded; only `model` is replaced | user output request preserved | A | Keep pass-through. Internal Judge uses its separate 300-token contract. |
| SSE buffering | Nginx proxy buffering/request buffering off; Router chunk relay honors backpressure | first byte and deltas are forwarded | C | Keep. Long active SSE fixture passes; client cancellation closes upstream. |
| SSE audit body | `stream-relay.ts` also accumulates all chunks | no semantic change; memory observation | C/observe | Keep for current audit requirements; monitor. |
| Encoding | fetch decodes upstream gzip; Router removes stale `content-encoding` | prevents double-decompression | A/protocol | Keep. |
| Reasoning/tool/usage/errors | Router relays native bytes and events | preserves native client semantics | A | Keep; no event aggregation or injection. |
| Instructions/messages/tools/tool choice/response format/reasoning/parallel tools/images/files/cache/stream options | Alpha Provider path forwards raw JSON after model replacement | fields remain present | A | Keep raw pass-through. Protocol adapters may structurally convert only when selected Channel requires it. |
| Safe native Headers | New API ACU Channel `header_override` | previously empty, so only baseline Content-Type/Accept reached Router | protocol metadata could be lost | D | Set the existing `*` safe passthrough rule. New API's denylist still removes credentials, cookies, Host, hop-by-hop and forged `x-acu-*`. |
| Credentials and hop-by-hop headers | `src/alpha/provider.ts`; New API ACU identity | client credentials/cookies removed; Provider credential and signed identity injected | security without semantic content loss | B | Keep. |
| Web Tool pruning | `prepareProviderBody` | explicit `web_search` was removed when Router judged it unnecessary and profile declaration was unverified | D | Removed. User-declared tools are retained; Web Intent calculation itself is unchanged. |
| Field removals | no current Alpha semantic field deletion after this patch | silent capability loss avoided | A/B | Any future adapter removal must carry `removedField`, reason, Provider and Channel in trace evidence. |
| Workspace/Sandbox | `resolveExecution` previously called `verifyWritableWorkspace` and rejected read-only/non-Git requests | overrode native Codex sandbox and blocked valid read-only tasks | D | Automatic gate removed. `codex-acu workspace` remains an explicit user-invoked diagnostic only. |

## Retry and state protections

| Protection | Current behavior | Class | Decision |
|---|---|---|---|
| Provider attempts | one Logical Request, maximum 3 serial attempts; pre-visible-SSE only | C | Keep to bound duplicate cost and loops. |
| Judge attempts | MiMo once, DeepSeek Backup once only for transport/429/5xx/critical parse/schema failures | C | Keep. Context failure does not use a Backup not verified larger. |
| 409 idempotency | trusted request/log identity plus active processing state/lease | B/C | Keep scoped concurrency protection; terminal/stale requests do not permanently lock identical text. |
| Cooldown/circuit breaker | Channel health drives bounded reroute without Rejudge | C | Keep; prevents repeated calls to failing supply. |
| Client retry | identity/status determines reuse vs new Logical Request | C | Keep to avoid duplicate charge; body hash alone is not permanent identity. |
| Client cancellation | request/response close aborts Router fetch | C | Keep and verified. |

## Non-content internal bounds

These values do not truncate or reject the native request: the last 16 tool call IDs retained in session metadata (`processor.ts`) are only failure-correlation state; route explanation summaries are capped at 240 characters while the full Judge explanation and Route Decision payload remain stored; event-derived diagnostic text is capped at 2,000 characters while the raw payload remains complete; Judge disk cache is bounded to 2,000 entries; payload retention is 90 days; and the usage outbox send call uses a 10-second delivery timeout with durable retry. They are C-class storage/operational bounds and remain. None substitutes for the raw request, raw Judge output, or Provider stream.

## Legacy non-Founder route

`src/proxy.ts` is a separate legacy OpenClaw/chat-completions route and is not used by `codex-acu -> New API -> acu-router`. It still has `MAX_MESSAGES=200` head/history truncation, a 300-second total request timeout, 60/180-second per-attempt timeouts, default `max_tokens=4096` when absent, and up to five fallback attempts. The message truncation and fixed total timeout are D-class pass-through concerns; per-attempt and fallback bounds are C-class; protocol-specific `max_tokens` to `max_completion_tokens` conversion is A-class. They were not modified because this task forbids changing the Provider main routing recovery mechanism and the Founder Alpha request path does not execute this code. They must be addressed in a separately scoped legacy-router migration before that path can claim the same pass-through contract.

## Judge failure evidence after patch

Every failed Judge attempt now carries and persists the attempt role, Provider/model, endpoint host, HTTP status, upstream request ID, sanitized response headers, complete raw response body, parser exception type/message, token usage, latency, backup eligibility and exact backup reason. Authorization, cookies, API keys, signed internal identity and secret-shaped payload fields are removed or redacted by the existing persistence sanitizer.

`context_length_exceeded` is a dedicated upstream category, not `invalid_response`. It is persisted before a clear HTTP 400 `judge_context_length_exceeded` is returned. HTTP 200 invalid JSON retains the body and `SyntaxError`, then permits exactly one Backup. Historical failures without raw bodies remain unavailable and were not reinterpreted.

## Verification

- Roughly 700K-token Raw Native Request: complete early/latest content and identical raw section reached the mock Judge adapter; no local context rejection; `contextTruncated=false`.
- Upstream context error: exact body/request ID preserved; category `context_length_exceeded`; Backup calls `0` because it is not verified larger.
- HTTP 200 invalid JSON: exact body and parser exception preserved; one Backup call.
- Body: a 33 MiB JSON request passes the Router's former 32 MiB boundary.
- Streaming: repeated delayed SSE chunks reach completion; client cancellation closes upstream.
- Targeted Vitest: 35 passed. TypeScript typecheck and production build passed.

## Residual external and operational limits

Cloudflare plan limits remain E-class and may be lower than the 128 MiB origin boundary. Provider-specific request/token/rate limits remain A-class and are returned as upstream errors. The Alpha path buffers full response evidence in memory and stores complete request/response payloads for 90 days; these are observable resource risks, not content truncation policies. No paid 700K/1M Provider boundary call was made, so public 1M capability must not be mislabeled as observed endpoint success.
