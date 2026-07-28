# C01 observation — controlled Mock

- 状态：实测确认（仅原生客户端 → Capture → 受控 Mock）；完整产品链路未执行。
- 客户端：Codex CLI 0.145.0。
- 链路：Codex → Capture A → controlled Responses Mock。
- Fixture：`codex-0.145.0-C01-mock-001`。
- 生产规则适用性：仅可作为客户端版本绑定的侦察线索；Provider/New API/ACU 规则不可使用。

## Measured result

The native `codex exec` process completed successfully and printed the Mock text. Before the model request, it also issued an auxiliary `GET /v1/models?client_version=0.145.0`, received 404, warned about missing model metadata, and continued.

The model call was `POST /v1/responses` with `stream: true`. Request headers included version-specific correlation candidates named `session-id`, `thread-id`, `x-client-request-id`, `x-codex-turn-metadata`, and `x-codex-window-id`. One sample does not establish stability, resume behavior, or safe production precedence.

The request body contained `instructions`, `input`, `tools`, `reasoning`, `include`, `prompt_cache_key`, `store`, `stream`, `tool_choice`, and `parallel_tool_calls`. A declared `update_plan` tool was present even though this trivial scenario did not plan or invoke it. Therefore tool declaration is not evidence of Tool Calling, and `update_plan` availability alone is not a strong Planning-start signal.

Eight raw Responses SSE events were received and relayed. The final usage was accepted by Codex. No New API, ACU, OpenRouter, or CloseAI component participated, so cross-hop Header/Body diffs are explicitly not computable.

## Limitations

- Controlled Mock behavior cannot establish real Provider support.
- No function call, tool result, reasoning delta, retry, resume, cancellation, or multi-Step behavior was exercised.
- Connector/tool declarations injected by this Codex runtime may differ in another installation.
