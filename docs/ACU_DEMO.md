# ACU Phase 2B 价值路由 Demo

ACU Demo 把一次 OpenAI-compatible API 请求的完整可见上下文转换为四档最低充分能力需求概率，再将概率与公开 Benchmark 约束生成的模型档位充分率结合，给出预计模型得分、预计综合成本与价值路由建议。

> 预计模型得分基于任务能力需求、公开Benchmark及受约束能力模型，用于展示模型与当前任务的相对匹配程度，不代表逐请求实测成功率。

## 启用

默认仍使用 `RulesStrategy`。仅在显式设置以下变量时启用 ACU 路由：

```bash
export ACU_DEMO_ROUTER_ENABLED=true
export ACU_JUDGE_API_KEY='...'
export ACU_JUDGE_MODEL=deepseek-v4-flash
export ACU_JUDGE_BASE_URL=https://api.deepseek.com
export ACU_JUDGE_MODE=non-thinking
export ACU_JUDGE_PROMPT_VERSION=acu-tier-requirement-v1
export ACU_JUDGE_TIMEOUT_MS=8000
export ACU_JUDGE_MAX_CONTEXT_TOKENS=6000
npm run build
```

密钥只从 `ACU_JUDGE_API_KEY` 或 `DEEPSEEK_API_KEY` 读取。Judge 请求最大输出 300 tokens，关闭 thinking，并要求 JSON object。缓存默认位于 `~/.claw-router/acu-judge-cache-v1.json`，仅保存上下文 SHA-256、版本、结果和时间，不保存完整请求或密钥。可以用 `ACU_JUDGE_CACHE_PATH` 改变位置。

启动 ClawRouter 后访问：

- 页面：`GET /acu`（反向代理前缀下为 `GET /acu-router/acu`）
- 目录：`GET /acu/api/catalog`
- 评估：`POST /acu/api/evaluate`

当前隔离的公网 dev 部署：

- 交互式页面：`https://eu.jerrypsy.top/acu-router-dev/`
- 静态曲线图集：`https://eu.jerrypsy.top/acu-router-dev/acu/curves/`
- 三张原始 PNG 位于 `/acu-router-dev/public/acu-curves/`

公网 dev 实例使用独立端口和发布目录，不会重启或替换原 `/acu-router/` 实例。访问控制与原 Demo 一致。

评估请求示例：

```json
{
  "messages": [
    { "role": "system", "content": "Keep changes scoped." },
    { "role": "user", "content": "Inspect the failure and fix it." }
  ],
  "tools": [],
  "quality_target": 0.8,
  "expected_output_tokens": 800
}
```

自动聊天路由继续使用 `model: "auto"`，可额外传 `acu_quality_target`。该字段只用于本地选模，转发前会删除。

## 计算边界

Judge 返回 `pLow`、`pMid`、`pMidHigh`、`pHigh`。展示难度是四档中心的期望值；选模不使用该标量，而是直接计算：

```text
estimatedQuality = Σ p(tier) × sufficient(model, tier)
```

模型档位充分率来自四类受约束 Profile：`frontier_resilient`、`balanced_frontier`、`efficient_fast` 和 `coding_specialist`。每个 Profile 只改变曲线形状；构建器会重新求解 ability parameter，使 Twin 970 条发布标签分布下的加权均值保持 ability anchor。这是产品 Demo 的受约束估算，不是跨 Benchmark 的严格统计等价。

默认质量偏好为 80 分。选模先删除被严格支配候选，再在有效前沿上计算连续价值效用：风险调整得分相对用户偏好做幂效用转换，成本按前沿内的对数相对成本转换为成本效用。最终价值是质量效用与成本调整因子的乘积，因此低价不能补偿近乎为零的任务匹配。偏好越高，质量权重、幂指数和不确定性惩罚连续增加；整个决策不存在固定分差或硬过线。

当 Judge 失败、超时、缺少密钥或返回无效 JSON 时，聊天请求维持原 `RulesStrategy` 决策；streaming、tool calls、thinking blocks 与 session pinning 不因失败而中断。评估接口仍返回带 `rules_fallback` 标记的估算，便于页面说明降级状态。

## 重建目录

构建器不调用模型 API，不执行 Benchmark：

```bash
research/quality-curves/.cache/venv/bin/python \
  scripts/build-acu-phase2b-catalog.py
```

它以 Phase 2A 冻结表为输入，不运行 Benchmark 或模型 API；重建 v2 运行目录、四类 Profile、8 个 Twin 预置案例、研究 CSV 和三张图。Phase 2A 研究结果不会被改写。
