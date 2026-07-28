# Observation

状态：实测确认（真实 Provider，Capture A）。同一线程完成五种新人类输入并持续重发增长的 Responses `input` 历史；没有 `previous_response_id`。`session-id`、`thread-id` 和 `x-client-request-id` 为同一稳定值。退出后同目录及不同目录按 Thread ID 恢复均成功，说明显式 Resume 不受 cwd 查找限制。
