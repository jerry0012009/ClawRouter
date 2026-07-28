# Observation

状态：实测确认（受控 Mock）。在 Streaming 首事件前 Ctrl-C，Capture 记录客户端取消且 Claude JSON 输出 `aborted_streaming`。使用同一 Session ID 恢复后请求成功并收到 completed/stop。Mock 只证明取消与恢复行为，不证明真实 Provider 能力。
