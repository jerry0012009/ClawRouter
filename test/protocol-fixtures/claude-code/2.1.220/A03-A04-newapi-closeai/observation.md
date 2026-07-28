# Observation

状态：实测确认（真实 Provider，A/B）。原生 Tool Use 和后续 Tool Result 通过 New API 成功完成；`tool_use.id` 与 `tool_result.tool_use_id` 在客户端请求和 Provider 请求中逐值相同。`tool_result` 位于 `role=user`，因此 `role=user` 不能单独作为新人类输入信号。Body JSON 语义和 Model 未变；Claude Session Header 未转发。
