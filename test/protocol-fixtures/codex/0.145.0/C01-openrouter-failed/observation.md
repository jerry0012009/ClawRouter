# C01 observation — OpenRouter Responses failure

- 状态：实测确认（真实失败）。
- 客户端：Codex CLI 0.145.0。
- 链路：Codex → Capture A → OpenRouter `/api/v1/responses`。
- Fixture：`codex-0.145.0-C01-openrouter-001`。
- 生产规则适用性：可证明当前链路失败和客户端 Retry Ownership；不可证明模型或 Responses 支持。

## Measured result

OpenRouter accepted `GET /api/v1/models?client_version=0.145.0` with HTTP 200. The native model request to `POST /api/v1/responses` failed with HTTP 403 and the Provider message classified the request as prohibited by Provider Terms of Service. No model output, Usage or Actual Model was returned.

Codex owned the visible retry loop: it displayed “Reconnecting 1/5” through “5/5”, made six total POST attempts, and then failed the turn. The six POSTs occurred over approximately nine seconds. Observed start gaps were about 0.62s, 0.76s, 1.09s, 1.74s and 4.77s. All attempts reused one `x-client-request-id`; full request-body hashes differed, so they are not byte-identical and must not be deduplicated solely by that header. The exact differing fields remain an inspection item.

No New API or ACU component participated, so this fixture does not establish their retry behavior and cannot be used to size combined retry budgets. It does demonstrate duplicate-attempt/cost risk if downstream layers independently retry the same class of error, although these 403 attempts returned no Usage and no billed cost was observable.

## Limitations

- Failure may depend on Provider policy, account, region, request shape, or selected model; the fixture does not isolate which.
- This is a 403 failure, not the requested controlled 429/5xx/timeout matrix.
- Actual backend model is unconfirmed because inference never started.
