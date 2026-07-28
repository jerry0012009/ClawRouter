# Observation

状态：实测确认（受控 Mock）。首请求在 SSE 首事件前被 Ctrl-C，Capture 精确记录取消时间和 upstream abort；同一 Thread ID Resume 后第二请求收到 8 个事件并完成，且不再被误标取消。Mock 不代表真实 Provider 兼容。
