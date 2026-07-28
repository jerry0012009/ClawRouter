# Observation

状态：实测确认（真实 Provider，A/B）。Codex 经 New API 发起多次 Shell Function Call 并回送 Function Call Output；所有 `call_id` 在 A/B 逐值相同，New API 未修改 Tool ID。三次请求 Body JSON 语义、Model 与 SSE 事件顺序保持。任务中的文件不存在是原生 Tool 环境错误，链路仍正常完成。
