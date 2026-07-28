# Observation

状态：实测确认（受控 Mock）。固定 503 且 New API Retry=0 时 A/B 各 30 次 POST，证明 New API 未增加 Attempt；大量请求由 Codex 的嵌套 HTTP/reconnect 行为产生。单一 Client Request ID 下存在多 Body，具有重复计费风险。
