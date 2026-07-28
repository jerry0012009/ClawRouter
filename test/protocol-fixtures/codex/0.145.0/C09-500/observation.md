# Observation

状态：实测确认（受控 Mock）。固定 500 产生 30 次 POST；CLI 只显示五级 reconnect，但每一级内部还有约 5 个 HTTP Attempt。仅有一个 `x-client-request-id`，却有 6 组不同 Body；该 ID 不能作为 Attempt 或计费幂等键。
