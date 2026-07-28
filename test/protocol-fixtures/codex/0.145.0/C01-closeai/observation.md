# C01 observation — CloseAI Responses

- 状态：实测确认（原生 Codex 直达 CloseAI 的文本链路）；New API/ACU 产品链路未执行。
- 客户端：Codex CLI 0.145.0。
- 链路：Codex → Capture A → CloseAI OpenAI-compatible endpoint (`/v1`).
- Fixture：`codex-0.145.0-C01-closeai-001`。
- 生产规则适用性：只能证明该客户端、模型和时间点的 Responses Streaming 文本成功；不可外推 Tool Calling、多 Step 或其他模型。

## Measured result

The native client completed successfully against `gpt-5.6-terra` and received the requested text. It first called `GET /v1/models?client_version=0.145.0`; CloseAI returned an OpenAI-style `{object, data}` model list, while Codex 0.145.0 expected a different metadata envelope and logged a non-fatal decode error. The model call still proceeded.

The actual call was `POST /v1/responses`, returned HTTP 200 with `text/event-stream`, and produced 13 ordered events:

`response.created` → `response.in_progress` → output/content start → five `response.output_text.delta` events → text/content/item done → `response.completed`.

The completed event reported `model = gpt-5.6-terra`, matching the requested model. Usage included input, cached-input details, output, output details and total tokens; the client reported 10,203 input tokens, 9 output tokens and 0 reasoning output tokens.

The request carried the same family of session/thread/correlation headers seen in the Mock run, plus `x-openai-internal-codex-responses-lite`. In this call the body contained no `tools` and no `instructions`; it did contain `input`, `reasoning`, `text`, `include`, `prompt_cache_key`, `store`, `stream`, `tool_choice`, and `parallel_tool_calls`. This differs from the Mock fallback-metadata request, showing that Codex request shape can depend on resolved model metadata.

## Limitations

- Capture A observed the direct client/provider link; New API and ACU were absent, so transformation diffs are not computable.
- No Tool Calling, multi-Step continuation, Planning, retry, resume, or cancellation occurred.
- Provider-reported model identity matched the request, but no independent Provider log was available to prove physical backend identity.
