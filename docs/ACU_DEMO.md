# ACU Phase 2A Demo

ACU Demo 把一次 OpenAI-compatible API 请求的完整可见上下文转换为四档最低充分能力需求概率，再将概率与公开 Benchmark 约束生成的模型档位充分率结合，给出模型与成本建议。

> 请求难度基于TwinRouterBench最低充分档位体系；模型曲线由公开Benchmark能力锚点和受约束能力模型生成，用于产品演示，不代表具体模型对当前请求的逐题实测成功率。

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
  "quality_target": 0.9,
  "expected_output_tokens": 800
}
```

自动聊天路由继续使用 `model: "auto"`，可额外传 `acu_quality_target`。该字段只用于本地选模，转发前会删除。

## 计算边界

Judge 返回 `pLow`、`pMid`、`pMidHigh`、`pHigh`。展示难度是四档中心的期望值；选模不使用该标量，而是直接计算：

```text
estimatedQuality = Σ p(tier) × sufficient(model, tier)
```

模型档位充分率来自共享斜率 Logistic 模型。TwinRouterBench 970 条发布标签只提供档位分布和 few-shot 上下文，OpenHands Index SWE-bench 聚合分数只作为模型位置锚点。两者的连接是产品 Demo 的受约束估算，不是跨 Benchmark 的严格统计等价，也不是当前请求的实测成功率。

当 Judge 失败、超时、缺少密钥或返回无效 JSON 时，聊天请求维持原 `RulesStrategy` 决策；streaming、tool calls、thinking blocks 与 session pinning 不因失败而中断。评估接口仍返回带 `rules_fallback` 标记的估算，便于页面说明降级状态。

## 重建目录

构建器不调用模型 API，不执行 Benchmark：

```bash
research/quality-curves/twinrouterbench/phase1d-foundation/.cache/venv/bin/python \
  scripts/build-acu-model-catalog.py
```

它读取 Phase 1D Parquet、已有 OpenHands 官方数据审计输出及 `src/models.ts`，重建运行时目录、固定 few-shot 和 Phase 2A 研究表。MiniMax M3 只有 Benchmark 证据，仓库没有可调用文本模型 ID，因此不会进入路由候选。
