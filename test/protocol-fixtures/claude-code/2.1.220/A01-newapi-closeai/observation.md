# Observation

状态：实测确认（真实 Provider，A/B）。New API 保持 Messages Path、Query、Model 和请求 Body 的 JSON 语义；把客户端 Authorization 改为上游 `x-api-key`，删除 `x-claude-code-session-id`。上游原始 Anthropic 事件顺序保持，但 New API 在客户端侧追加一个无 event name 的终止帧（`data: [DONE]`），因此不是 SSE 字节级无损。
