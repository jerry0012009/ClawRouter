# Observation

状态：实测确认（受控 Mock）。New API Retry=1 时客户端侧 2 次 POST（辅助 Haiku 与主请求），上游侧 3 次；首个 503 的同一 Body 被 New API 无感知重发一次并成功。两个上游 Attempt 具有不同 Provider Request ID，存在重复 Provider 计费风险；本测试未启用 ACU Retry。
