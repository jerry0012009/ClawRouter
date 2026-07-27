# ACU Phase 2C / 3A Shadow 价值路由

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
export ACU_JUDGE_PROMPT_VERSION=acu-tier-requirement-v2
export ACU_JUDGE_TIMEOUT_MS=8000
export ACU_JUDGE_MAX_CONTEXT_TOKENS=6000
export ACU_SHADOW_MODE=true
export ACU_ALLOW_MOCK=false
export ACU_DATABASE_PATH=/var/lib/clawrouter-dev/acu-routing.db
npm run build
```

密钥只从 `ACU_JUDGE_API_KEY` 或 `DEEPSEEK_API_KEY` 读取。Judge 请求最大输出 300 tokens，关闭 thinking，并要求 JSON object。v2 缓存默认位于 `~/.claw-router/acu-judge-cache-v2.json`；旧 v1 文件不会被复用。缓存只保存上下文 SHA-256、版本、结果、usage 和来源证明，不保存完整请求或密钥。

启动 ClawRouter 后访问：

- 页面：`GET /acu`（反向代理前缀下为 `GET /acu-router/acu`）
- 目录：`GET /acu/api/catalog`
- 评估：`POST /acu/api/evaluate`
- 数据汇总：`GET /acu/api/data-summary`
- 用户反馈：`POST /acu/api/feedback`
- Debug 页面：`GET /acu-debug/`

当前隔离的公网 dev 部署：

- 交互式页面：`https://eu.jerrypsy.top/acu-router-dev/`
- Debug 页面：`https://eu.jerrypsy.top/acu-router-dev/acu-debug/`
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

自动聊天路由继续使用 `model: "auto"`，可额外传 `acu_quality_target`。Dev 默认 Shadow：原路由模型正常执行，ACU 建议写入 trace 和 SQLite；只有显式传 `acu_execute_recommended: true` 才执行建议模型。这些字段转发前都会删除。

## 计算边界

Judge v2 直接返回连续 `difficultyScore` 与 `pLow`、`pMid`、`pMidHigh`、`pHigh`。模型得分统一取冻结曲线在连续难度处的线性插值：

```text
predictedScore(model) = interpolate(fittedModelCurve[model], difficultyScore)
```

四档概率只表达 Judge 不确定性并计算归一化熵，不再直接生成模型分数。模型曲线仍是 Phase 2B 冻结的 `acu-routing-model-v0.1`，Curve Profile 与能力锚点没有在本阶段修改。

默认质量偏好为 80 分。选模先删除被严格支配候选，再在有效前沿上计算连续价值效用：风险调整得分相对用户偏好做幂效用转换，成本按前沿内的对数相对成本转换为成本效用。最终价值是质量效用与成本调整因子的乘积，因此低价不能补偿近乎为零的任务匹配。偏好越高，质量权重、幂指数和不确定性惩罚连续增加；整个决策不存在固定分差或硬过线。

当 Judge 失败、超时、缺少密钥或返回无效 JSON 时，聊天请求维持原 `RulesStrategy` 决策；streaming、tool calls、thinking blocks 与 session pinning 不因失败而中断。评估接口仍返回带 `rules_fallback` 标记的估算，便于页面说明降级状态。

## 重建目录

构建器不调用模型 API，不执行 Benchmark：

```bash
research/quality-curves/.cache/venv/bin/python \
  scripts/build-acu-phase2b-catalog.py
```

它以 Phase 2A 冻结表为输入，不运行 Benchmark 或模型 API；重建 v2 运行目录、四类 Profile、8 个 Twin 预置案例、研究 CSV 和三张图。Phase 2A 研究结果不会被改写。
