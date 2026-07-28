# Observation

状态：实测确认（真实 Provider，Capture A）。同一会话依次执行“继续”、新约束、新任务、不满意和重做；每次请求重发增长的完整 Messages 历史，并保持同一 `x-claude-code-session-id`。同目录 `--resume` 成功。换到父目录恢复在客户端本地报“找不到会话”，没有生成 HTTP 请求；该失败不伪造链路文件。
