# Observation

状态：实测确认（受控慢流 Mock）。Provider 立即发送 SSE Headers、延迟首事件 3 秒；Codex `stream_idle_timeout_ms=1000` 后取消，并在五级 reconnect 后失败。共 6 次 POST，6 次均记录客户端主动中止、无 SSE Event。
