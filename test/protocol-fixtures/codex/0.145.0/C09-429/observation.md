# Observation

状态：实测确认（受控 Mock）。带 `Retry-After: 0` 的 429 只产生 1 次 POST，Codex 直接报告超过 retry limit。该结果与 500/503 不同，Retry 规则必须按错误分类，不能统一假设五次重试。
