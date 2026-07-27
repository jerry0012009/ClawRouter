# Phase 3B P1：Validator、质量 Fallback 与运行配置健康层

本目录记录 2026-07-27 在 `acu-router-dev` 上完成的 P0/P1 修复。基础 Commit 为
`7cc802ddfa3ba610ad5bba7f962a9e00f527fcf9`。本阶段未修改 Judge 难度算法、公开
Benchmark 能力锚点、价值函数或基础曲线。

## 原因与修复

旧版 `promptNeedsJsonValidation` 将所有 system/user 消息拼接后匹配
`structured/结构化/fields/schema`。页面给每个任务追加的通用 Quality Contract 含有
“若存在结构化格式要求”，因此普通代码修复也会触发 JSON Validator；第一次文本回答被判
“未找到 JSON 对象”，随后旧 premium chain 又可能选择预测分更低的模型。

现在只有以下输入会触发 JSON/Schema 校验：明确的 `response_format`、
`expected_schema`、user 消息明确要求 JSON，或 user 明确列出提取字段并要求结构化输出。
隐式判断只读取 user 消息，不扫描 Quality Contract system 模板。

确定性的 JSON/Schema 格式失败会先由同一模型进行一次 Non-thinking 格式修复，最多 384
tokens。只有修复仍失败时，才从 ACU estimates 中选择预测分不低于当前模型、保守分未明显
下降、满足工具/视觉/上下文、未尝试且健康可用的候选。不存在合格候选时保留当前输出并标记
“当前结果需要复核”，不会把低分切换描述为升级。

## Execution Profile 与被动健康

运行实例使用 `executionProfileId`，例如：

- `qwen3.6-plus:non-thinking`
- `qwen3.6-plus:thinking`
- `claude-opus-4-8:default`

`routing_requests`、`routing_attempts`、`execution_outcomes` 均保存该字段。Qwen Low/Mid
实际请求带 `enable_thinking=false`；Trace 与 SQLite 同时记录 `thinkingMode=disabled`、
`requestParameterApplied=true`、真实 upstream model 和 reasoning tokens。

健康层只消费真实 `routing_attempts`，不会在用户请求前发额外探测。每个 profile 保存最近
20 次成功率、连续失败/超时、P50/P95、错误比例、最后成功时间与 cooldown。连续两次超时冷却
60 秒；最近五次成功率低于 60% 标记 degraded。健康度只影响首选可用性和质量 Fallback
排序，不改写能力曲线。按 profile 的产品数据汇总在少于 30 条时明确禁止拟合独立曲线。

## Dev 真实性复测

脱敏结果在 `validation_results.json`。关键结果：

| 案例 | Judge | 难度 | 推荐/实际 | Validator | Attempts | Reasoning | Router 总耗时 | ACU 成本 |
|---|---|---:|---|---|---:|---:|---:|---:|
| Low JSON 抽取 | live | 5.0 | Qwen / Qwen | pass, json | 1 | 0 | 6,038 ms | US$0.0004416 |
| 原 `avg([])` 修复 | live | 25.0 | Qwen / Qwen | not applicable | 1 | 0 | 7,586 ms | US$0.00060225 |
| Mid 边界代码修复 | live | 35.0 | Qwen / Qwen | not applicable | 1 | 0 | 11,155 ms | US$0.001086 |
| High 长程系统推理 | live | 88.5 | Opus / Opus | not applicable | 1 | 0 | 23,758 ms | US$0.0313145 |

`avg([])` 相比旧约 18 秒路径缩短到 7.586 秒；未触发 JSON Validator、未调用 Gemini、
Qwen 为 Non-thinking、reasoning tokens 为 0，SQLite 只有一个成功 attempt。

公网截图：`screenshots/avg-code-fix-validation.png`。截图来自
`https://eu.jerrypsy.top/acu-router-dev/acu` 的公开 Dev 路径；其中重复案例命中 Judge 缓存，
模型仍进行一次真实 Qwen Non-thinking 调用。生产 `clawrouter` PID 在部署前后均为
`1791893`，未重启或修改。
