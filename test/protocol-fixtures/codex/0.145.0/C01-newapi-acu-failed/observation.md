# Observation

状态：实测确认（失败链路）。New API 将 `/v1/responses` 原样转给当前 ACU，但 ACU 返回 404，Provider 未到达。客户端共发 6 次、New API 上游也为 6 次（Retry=0）；失败是有效协议基线，不表示 New API 或 Provider 不支持 Responses。
