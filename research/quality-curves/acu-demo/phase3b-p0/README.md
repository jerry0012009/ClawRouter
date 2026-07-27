# Phase 3B P0：动态曲线、延迟与成本审计

本目录记录 2026-07-27 在 `acu-router-dev` 上进行的产品级审计。它不修改 Judge 算法、既有模型能力锚点或价值函数。

## 结论

- 图表集合由推荐模型、实际模型、逐次 attempt 和四类参照模型动态组成，去重后最多 8 条。推荐与实际模型始终可见。
- `routing_attempts` 逐次保存模型、上游、状态、错误类别和耗时；切换不再统一描述为“升级”。
- Router 和 Always Strong 在浏览器中独立计时、独立渲染；Router 完成后无需等待 Baseline。
- 成本优先采用上游明确费用或 usage；无 usage 时按实际可见响应估算，只有响应也不可解析时才用 `max_token_estimate`，并在页面明确标注“上限估算，不是实际成本”。
- Dev 的第一个 ACU 非推理模型 attempt 在输出上限不超过 1200 tokens 时采用 15 秒超时。生产环境未配置此参数。

## Qwen → Gemini 切换

旧请求 `959ab5c9-9e0b-4c45-aa65-2ea09bc31885` 产生于逐次 attempt 尚未持久化之前，因此不能从旧 SQLite 行严格恢复原因。修复后使用同类低难度长输出请求复现：

1. `qwen3.6-plus`：15,004 ms，`timeout`；
2. `gpt-5.6-sol`：915 ms，`config_error`；
3. `gemini-2.5-flash`：9,626 ms，成功。

请求 `db198bf6-fb63-4d00-83a4-0495611feaf7` 的最终模型是 Gemini 2.5 Flash。因此此类切换的准确文案是“推荐模型调用失败（超时），已切换”，不是“升级”。

## 成本口径

`ACU total = Judge actual cost + final model call cost + earlier attempts with explicit billed usage`。

超时或错误响应没有明确计费信息时不虚构费用。SQLite 同时保存输入、可见输出、completion、reasoning、cached input、价格和 usage 来源。旧版把输出上限当作实际输出，是 Qwen 与 Opus 显示成本仅差约 18.5% 的主要原因；新实测写作案例在上游 usage 口径下分别为 US$0.000762 与 US$0.01336，ACU 低 94.3%。

## Qwen Thinking

同一礼貌改写任务的最小 A/B：

| 参数 | 延迟 | completion | reasoning | 模型成本 | 输出质量 |
|---|---:|---:|---:|---:|---|
| 默认 | 22,360 ms | 1,120 | 1,105 | US$0.0019681 | 正确、简洁 |
| `enable_thinking=false` | 2,373 ms | 10 | 0 | US$0.0000262 | 正确、简洁 |

关闭 Thinking 将延迟降低约 89.4%、模型成本降低约 98.7%，且该简单任务的可见答案质量无明显下降。因此 Dev 中仅对 Judge 判定为 Low/Mid 的 Qwen 3.6 Plus 自动关闭 Thinking；更复杂任务保持原行为。

## 公网验收

四类结果见 `validation_results.json`。截图：

- `screenshots/dynamic_recommended_actual_curves.png`
- `screenshots/latency_and_cost_breakdown.png`
- `screenshots/independent_baseline_router_latency.png`

部署仅更新 `https://eu.jerrypsy.top/acu-router-dev/`。生产 `clawrouter` PID 在两次部署前后均为 `1791893`。
