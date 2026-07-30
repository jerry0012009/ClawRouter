# ACU Router 路由与上游恢复策略

> 状态：产品设计基线，P0 公式已与当前代码对齐  
> 版本：v0.2  
> 日期：2026-07-29  
> 依赖：`03-system-architecture.md`、`04-session-task-routing-segment-state-machine-v2.md`、`04a-alpha-state-machine-implementation-profile.md`、`05-judge-and-trigger-policy.md`、`06-planning-detection.md`、`07-failure-taxonomy-and-blockage-rules.md`  
> 当前实现依据：`src/acu/decision.ts`、`src/acu/catalog.ts`、`src/acu/math.ts`

## 1. 文档目的

本文定义显式模型、`acu-auto`、`acu-high` 的执行方式，当前 ACU 质量—成本公式，Segment Route 锁定，以及 Provider、兼容性和 Judge 故障的恢复。

## 2. 核心原则

### 2.1 硬兼容过滤与连续价值选择分离

先过滤无法执行请求的 Profile：

- 原生协议不兼容；
- Tool / Thinking / 模态 / 结构化输出不兼容；
- 上下文或最大输出容量不足；
- Model / Channel 不可用；
- 管理员策略禁止；
- 价格或必要元数据不可计算。

质量目标不是 P0 的硬过滤线。硬条件通过后，所有候选进入成本—质量估计和 Pareto 价值选择。

### 2.2 88 是偏好锚点，不是达标线

`temporary_phase_override = 88` 表示 Planning 阶段更偏重质量和风险，不表示：

```text
predicted_score < 88
→ 候选淘汰
```

所有模型低于 88 时仍需选择相对最合理的 Profile；所有模型高于 88 时仍需比较成本。

### 2.3 复用当前公式，而不是改成最低成本硬阈值

P0 继续复用 `src/acu/decision.ts` 的 Pareto 前沿与连续 `valueUtility`。不得把产品规则改写成“达到 88 的候选中选最便宜”。

### 2.4 Segment 内稳定

普通 Tool 循环复用当前 Segment Profile。没有新 Segment 边界时，不因价格波动、一次成功或普通进展切换模型。

### 2.5 可用性恢复不改变 Difficulty

Provider 429、5xx、Timeout 和 Channel 故障只触发恢复；协议、上下文或 Tool 硬条件变化只重新过滤候选，不重新解释任务难度。

## 3. Execution Profile

至少包含：

```text
model
provider
channel
native_protocol
reasoning / thinking mode
context_window
max_output
supported_tools
supported_modalities
structured_output_capabilities
input_price
output_price
price_version
quality_curve_version
uncertainty_width
health_state
```

同一模型在不同 Channel、协议配置、上下文或推理配置下属于不同 Profile。

## 4. 模式行为

### 4.1 显式模型

```text
用户指定具体模型
→ Judge = 0
→ 不进行 ACU 模型选择
→ P0 不自动替换模型或跨 Channel Failover
```

请求仍经过 ACU 执行和账本，保留原生协议、Streaming、Tool ID 和 Thinking。

### 4.2 acu-auto

```text
有效 Evaluation
→ 计算质量偏好锚点 T
→ 硬兼容过滤
→ 模型曲线和风险成本估计
→ 成本—质量 Pareto 前沿
→ 连续 valueUtility
→ 选择最大值 Profile
```

### 4.3 acu-high

使用同一公式，只提高基础质量偏好和不确定性惩罚，不等于固定使用最贵模型。

## 5. 质量偏好锚点

```text
T = effective_quality_target = max(
  task_base_quality_target,
  capability_escalation_floor,
  temporary_phase_override
)
```

字段含义：

- `task_base_quality_target`：模式基础质量偏好；
- `capability_escalation_floor`：能力阻塞后，后续目标偏好的最低值；
- `temporary_phase_override`：阶段性偏好；Planning P0 为 88。

这里的“floor”是目标参数的下限，不是候选预测质量的硬淘汰线。

当前代码默认 `qualityTarget = 0.8`，进入价值公式时转为 0—100 分。P0 必须保存最终 T 和公式版本。

## 6. 模型质量曲线

当前代码先根据 Difficulty 构造连续能力档位概率，再计算模型质量：

```text
Q_m(d)
= P_low(d)      × S_m,low
+ P_mid(d)      × S_m,mid
+ P_mid_high(d) × S_m,mid_high
+ P_high(d)     × S_m,high
```

其中：

- `P_t(d)` 来自 Difficulty 的连续 sigmoid 分布；
- `S_m,t` 来自模型 Catalog 的分档 sufficiency；
- `Q_m(d)` 是公开 Benchmark 与受约束能力模型形成的估计，不是逐请求真实成功率。

对 Difficulty 非整数点使用线性插值。

## 7. 单候选风险与成本估计

当前实现对每个模型计算：

```text
predicted_score_m = 100 × Q_m(d)
```

```text
conservative_quality_m
= clamp(
    Q_m(d)
    - uncertainty_width_m
    - judge_entropy_penalty / 100
  )
```

调用成本：

```text
call_cost_m
= input_tokens  × input_price_m
+ output_tokens × output_price_m
```

按每百万 Token 价格换算。

P0 当前预期 fallback 成本：

```text
expected_fallback_cost_m
= (1 - conservative_quality_m)
  × (flagship_fallback_call_cost + switch_cost)
```

总风险调整成本：

```text
risk_adjusted_cost_m
= judge_cost
+ call_cost_m
+ expected_fallback_cost_m
```

说明：P0 忠实复用当前以 Catalog flagship 作为预期 fallback 的估计。真实 Provider recovery Profile 与账单校准列入后续版本，不能在文档中把现有估计描述成已实测真实 fallback 概率。

## 8. Pareto 前沿

候选 A 被候选 B 支配，当且仅当：

```text
score_B >= score_A
and cost_B <= cost_A
and 至少一项严格更优
```

只有未被支配的候选进入连续价值比较。

Pareto 过滤不是 88 过滤。一个预测分低于 T 的候选，只要没有被其他候选同时以更高质量和更低成本支配，仍可进入前沿。

## 9. 当前连续价值公式

设目标锚点为 `T`，当前代码计算：

```text
preference = clamp((T - 60) / 35)
```

```text
quality_weight   = 0.58 + 0.24 × preference
risk_weight      = 0.20 + 0.25 × preference
quality_exponent = 0.80 + 1.20 × preference
```

风险调整分数：

```text
risk_adjusted_score_m
= predicted_score_m
- risk_weight
  × max(0, predicted_score_m - conservative_score_m)
```

质量效用：

```text
quality_utility_m
= (max(0, risk_adjusted_score_m) / max(1, T))
  ^ quality_exponent
```

成本效用在 Pareto 前沿内做对数归一化：

```text
cost_utility_m
= 1 - log(cost_m / min_cost)
      / log(max_cost / min_cost)
```

若前沿成本相同，则 `cost_utility = 1`。

最终价值效用：

```text
value_utility_m
= quality_utility_m
  × [
      quality_weight
      + (1 - quality_weight) × cost_utility_m
    ]
```

选择：

```text
selected_profile = argmax(value_utility_m)
```

### 9.1 T 的真实作用

T 越高：

- 质量权重更高；
- 风险惩罚更强；
- 质量效用曲线更强调高分模型；
- 但成本效用不会消失。

因此 T=88 是公式中的偏好参数，不是横向硬线。

### 9.2 `meetsQualityTarget`

当前代码仍计算：

```text
meetsQualityTarget = estimatedQuality >= qualityTarget
```

P0 将其视为解释、展示和分析字段，不作为 `selectValueRoute` 的硬过滤条件。

## 10. 质量与硬安全边界

质量连续效用不意味着取消所有安全边界。以下仍是硬条件：协议、Tool、Thinking、模态、上下文、管理员白名单和健康状态。

Judge 故障时的管理员安全候选组也可以设置独立安全档，但该安全档不应与正常路由的 T=80 / 88 混为一条硬线。

## 11. PlanFinished 路由

PlanStarted：T 至少为 88，运行 Planning Judge和连续价值公式。

PlanFinished：撤销 88。普通完成复用已有 Difficulty 与能力分布，并允许使用恢复后的 T 重跑同一公式；只有新目标、范围扩大、新约束、Replanning 或能力阻塞证据才重新 Judge。Execution Profile 可保持、升级或下降；重复能力失败 recovery 仍只允许保持或升级。

## 12. Segment Route 锁定

Segment 创建时保存：

- Evaluation 和 Trigger；
- T 及其三个组成值；
- routing model / formula version；
- quality curve / price version；
- 每个候选的曲线质量、保守质量、风险成本；
- Pareto 标记；
- quality / cost / value utility；
- selected Profile 和 Route Explanation。

普通 Step 复用当前 Profile。

新 Segment 边界包括 HumanMessage、PlanStarted、PlanFinished、重复失败、compatibility / availability recovery，以及 Lease / Resume。不得按固定 Step 或 Response 数创建周期刷新 Segment。

## 13. Judge 失败时的安全 Profile

顺序：最近有效 Evaluation + 风险惩罚 → Rules Strategy → 管理员安全性价比候选组。

安全候选必须满足协议、Tool、上下文、健康和管理员安全档。在该候选组中仍按性价比选，不自动使用最贵模型。可以配置 DeepSeek V4 Pro 级别的长上下文性价比模型，但不得写死具体模型。

## 14. Retry Ownership

New API 对 ACU 执行 Channel：

```text
retry = 0
```

ACU 是网关侧 Retry Owner。Codex / Claude Code 仍可能自行 Retry；ACU 通过逻辑请求 Hash、历史增量、Event 幂等和 Attempt 记录识别重复请求，不能只依赖 `x-client-request-id`。

## 15. P0 上游恢复预算

```text
max_provider_attempts_per_logical_request = 3
```

即初始 Attempt + 最多两次 ACU 控制的恢复 Attempt。

恢复顺序：

1. 初始 Profile 首选 Channel；
2. 同模型、同协议与等价能力配置的健康备用 Channel；
3. 前两个 Channel 同属一个 Provider 且均失败时，第三个优先选择另一 Provider 的同模型健康 Channel；
4. 无同模型备用时，使用最近 Evaluation 和当前 T 重跑硬过滤、Pareto 与连续价值公式，并限制 recovery Route 不低于当前 recovery policy；
5. 预算耗尽则返回明确错误。

模型变化时创建 availability / compatibility recovery Segment，不重新 Judge。

## 16. Provider 与 Compatibility Recovery

Provider Error 不改变 Difficulty，不触发 Judge，不计入能力失败。

Compatibility Error 使用最近 Evaluation 重跑硬条件过滤。无兼容候选时返回明确错误。

同一核心执行失败第二次无进展时，由 `07` 触发 `05` 重新 Judge，创建 capability recovery Segment，并只允许保持或升级。

## 17. Streaming 边界

Route 必须在响应 Header 和首个 SSE Event 前确定。已经向客户端输出可见内容后，不在同一响应中静默拼接其他模型或 Provider 结果。

Streaming 中断记录 Attempt、已输出字节、Usage 可见性和取消来源，后续由客户端 Retry。

## 18. Usage 与计费

每个真实 Attempt 独立记录请求 / 实际模型、Provider / Channel、Token、Provider Usage、实际成本、状态和 Retry Owner。

用户总成本包括成功 Attempt、Judge 实际成本，以及 Provider 实际收费的失败 Attempt。不得重复收费。

## 19. Route Decision 记录

至少保存：

```text
route_decision_id
segment_id
judge_evaluation_id
policy_version
routing_model_version
quality_curve_version
price_version
effective_quality_target
eligible_profiles
excluded_profiles_and_reasons
candidate_estimates
pareto_frontier
selected_profile
expected_quality
conservative_quality
risk_adjusted_cost
quality_utility
cost_utility
value_utility
fallback_source
route_explanation
created_at
```

## 20. 成本节省口径

自动路由可以记录实际总成本、质量上限反事实成本、相对成本下降和质量差距。均须标明基准与版本；显式模型不宣称 ACU 节省。

## 21. P0 实施范围

1. 显式模型不替换；
2. 硬兼容过滤；
3. 当前质量曲线、风险成本、Pareto 与 `valueUtility`；
4. T=80 / 88 等参数作为连续偏好锚点；
5. Segment Route 锁定；
6. PlanFinished 复用 Evaluation 或基于明确 Evidence Judge 后重选 Profile；
7. Judge 故障安全性价比 Profile；
8. New API Retry = 0；
9. ACU Attempt 预算 = 2；
10. Provider / Compatibility Recovery；
11. Streaming 开始后不静默拼接切换；
12. Attempt 与 Route Decision 可审计。

## 22. P1 与延期

P1：实时 Channel Health、真实 recovery 风险成本、Provider 账单对账、Shadow / Dual Run、OpenClaw / Hermes 兼容矩阵和管理员 Route 模拟器。

延期：Learned Router、在线质量曲线更新、自动用户偏好学习、多 Agent 路由、speculative execution 和无限级联 Failover。

## 23. P0 验收

1. 协议、Tool 或上下文不兼容候选被硬排除；
2. 正常路由不使用“低于 88 即淘汰”的规则；
3. 所有候选低于 T 时仍能按 Pareto + `valueUtility` 选择；
4. 所有候选高于 T 时成本效用仍影响选择；
5. 公式输出与当前 `src/acu/decision.ts` 在固定 Fixture 上一致；
6. `meetsQualityTarget` 不参与 P0 硬过滤；
7. PlanFinished 可选择新的 Execution Profile；
8. Provider 503 不触发 Judge；
9. 同模型备用 Channel 优先；
10. 每个逻辑请求最多两次 Provider Attempt；
11. Streaming 输出后不静默换模型拼接；
12. Route Decision 可解释、可重放、可审计。
