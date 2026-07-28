# Observation

状态：实测确认（真实 Provider，A/B）。Codex 0.145.0 的 `/v1/responses`、Model 和请求 Body JSON 语义经 New API 保持；没有转为 Chat Completions。13 个 SSE 事件的名称、顺序、脱敏后原始字节数与 Usage 在两跳相同。New API 只替换鉴权/Host并加入压缩协商；结果仅约束该版本、渠道和模型。
