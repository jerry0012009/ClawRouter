# C03/C04 observation — CloseAI Tool Calling and multi-Step

- 状态：实测确认（原生 Codex 直达 CloseAI）。
- 客户端：Codex CLI 0.145.0。
- 链路：Codex → Capture A → CloseAI `/v1/responses`。
- Fixture：`codex-0.145.0-C03-C04-closeai-001`。
- 生产规则适用性：Tool Call/Result 因果字段可作为该版本强关联候选；跨 New API/ACU 保真仍未确认。

## Measured result

Codex completed a real local file-read task in the disposable sandbox. CloseAI `gpt-5.5` emitted a shell `function_call`; Codex executed `/bin/bash -lc "sed -n '1,120p' notes/hello.txt"` locally, returned the synthetic Tool Result, made a second model request, and produced `ORBIT-LANTERN`.

Two successful `POST /v1/responses` Steps used the same deterministically redacted `session-id`, `thread-id`, and `x-client-request-id` value. This single trace makes them strong correlation candidates, not yet a proven precedence rule.

The first response contained a Reasoning output item followed by a Function Call. Function arguments arrived through many `response.function_call_arguments.delta` events and a done event. The second request did not use `previous_response_id`; instead its `input` contained the prior `reasoning` item, `function_call`, and matching `function_call_output` in addition to the message items. The call/output causal identifier was preserved in the sanitized capture.

The second completed Usage reported 12,672 cached input tokens. Across the two Steps the native client summarized 26,074 input tokens, 89 output tokens, and 17 reasoning output tokens. Both completed responses reported `model = gpt-5.5`.

The request declared `update_plan`, but this simple task never called it. Declaration remains a weak availability signal; an actual `update_plan` Function Call is the stronger Planning signal to test in C06.

## Limitations

- New API and ACU were absent; Tool IDs may still be rewritten in the intended product chain.
- One successful file read does not prove arbitrary shell tools, mutations, tests, or all models.
- Resume, new human input, cancellation, retries, Plan updates and Repair were not exercised.
