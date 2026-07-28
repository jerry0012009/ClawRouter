# C01 observation — current ACU ingress failure

- 状态：实测确认（真实失败）。
- 客户端：Codex CLI 0.145.0。
- 链路：Codex → Capture A → current local ClawRouter service on port 8402；Provider 未到达。
- Fixture：`codex-0.145.0-C01-acu-current-001`。
- 生产规则适用性：可作为当前运行服务不支持 Responses ingress 的回归证据；不是正式产品实现结论。

## Measured result

The running local service returned its OpenAI-style `GET /v1/models` list with HTTP 200. Codex could not decode that list as its richer model-metadata envelope, but continued with fallback metadata.

Every `POST /v1/responses` returned the service's HTTP 404 JSON body: `Not found: /v1/responses`. Codex performed the same visible reconnect loop (five reconnect messages, six total POSTs) and then failed. No Provider request, model output, Usage, Judge, route, Attempt Ledger, or Actual Model was produced.

The runtime process uses this checkout's previously built `dist/`, but its loaded artifact Commit cannot be proven after the process started; the manifest intentionally records `runtime-dist-commit-unverified` rather than inventing a SHA.

## Limitations

- The intended architecture requires New API before ACU; New API was absent here.
- This fixture validates the current implementation gap only. It does not justify adding permanent Responses logic to the old monolithic route during reconnaissance.
- Retry behavior is owned by Codex in this trace; ACU returned one 404 per attempt and did not perform an observable upstream retry.
