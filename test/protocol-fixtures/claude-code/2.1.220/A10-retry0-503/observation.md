# Observation

状态：实测确认（受控 Mock，不代表 Provider 支持）。New API Retry=0 时 A、B 各观察到 22 次 POST；New API 没有增加上游尝试。请求的 `x-stainless-retry-count` 均为 0，说明这些是 Claude Code 高层循环新建的 SDK 调用，而不是单次 SDK 内部 retry-count 递增。最终约 180 秒后返回 503。
