# Observation

状态：实测确认（真实 Provider，单一模型样本）。Claude Code 2.1.220 向 CloseAI Anthropic 发送原生 `/v1/messages?beta=true` Streaming 请求并成功结束。HTTP 请求含稳定的 `x-claude-code-session-id`；该值已脱敏。此 Fixture 未经过 New API/ACU，不能外推网关透传行为。
