# Phase 2B 起始状态审计

审计基线：`ec4197ed8fbf4410df1aca2ec292500c492e3e84`，日期 2026-07-27。

| 项目 | Phase 2A 起始状态 |
|---|---|
| 运行时模型目录 | `src/acu/catalog/model-catalog.json`，v1，13 个条目，12 个可路由 |
| 旧默认展示 | 11 个模型 |
| 仓库模型注册 | `src/models.ts` 已有 `glm-5.2` 和 `kimi-k2.7-code`，ACU 目录仍为 5.1/2.6 |
| 曲线参数 | 全部共享 temperature 0.12、floor 0.03、ceiling 0.99 |
| 连续曲线 | 档位阈值 0.275/0.525/0.765，temperature 0.08 |
| 质量目标 | 0.90 |
| 推荐逻辑 | 保守估计达标后直接选 expected total cost 最低者 |
| 原服务 | `127.0.0.1:8402`，`/acu-router/` |
| Dev 服务 | `127.0.0.1:8403`，`/acu-router-dev/` |

当前上游 `/models` 查询对 Phase 2B 目标 12 个 ID 全部返回存在。`glm-5.2` 与 `kimi-k2.7-code` 额外完成 8-token 短文本请求，HTTP 200。GPT-5.6 详细结果见 `gpt56_preflight.json`。密钥、上游 URL 实值和响应正文均未写入 Git。
