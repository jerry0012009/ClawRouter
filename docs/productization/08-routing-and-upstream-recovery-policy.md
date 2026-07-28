# ACU Router 路由与上游恢复策略

> 状态：产品设计初稿，待创始人审阅  
> 版本：v0.1  
> 日期：2026-07-29  
> 依赖：`03-system-architecture.md`、`04-session-task-routing-segment-state-machine-v2.md`、`04a-alpha-state-machine-implementation-profile.md`、`05-judge-and-trigger-policy.md`、`06-planning-detection.md`、`07-failure-taxonomy-and-blockage-rules.md`

## 1. 文档目的

本文定义：

1. 显式模型、`acu-auto`、`acu-high` 如何执行；
2. 如何从候选 Execution Profile 中选择模型与 Channel；
3. Routing Segment 如何锁定和复用 Route；
4. Provider 故障、协议不兼容和 Judge 故障如何恢复；
5. 谁负责 Retry，如何避免多层重试放大；
6. P0、P1 与延期边界。

## 2. 核心原则

### 2.1 先满足硬条件，再谈性价比

候选 Profile 必须先满足：

- 原生协议；
- Tool / Thinking / 模态能力；
- 上下文和预期输出容量；
- 结构化输出要求；
- Model / Channel 健康；
- 管理员白名单；
- 当前 Task 的质量下限。

不满足硬条件的 Profile 不参与成本比较。

### 2.2 Judge 不直接选模型

Judge 输出能力需求和风险分布。Route Decision Engine 再结合质量曲线、价格、健康度、上下文余量和不确定性选择 Profile。

### 2.3 选择“最低充分能力”，不是最低价格

`acu-auto` 的目标：

> 在预计达到当前质量要求的候选中，选择预计总成本最低的 Execution Profile。

总成本应包括输入、输出、缓存、Reasoning、Judge、实际失败 Attempt 和必要恢复成本。

### 2.4 Segment 内稳定

普通 Tool 循环复用当前 Segment 的 Profile。没有新 Segment 边界时，不因单次成功、价格波动或普通进展切换模型。

### 2.5 可用性恢复不等于重新判断任务难度

Provider 429、5xx、Timeout 和 Channel 故障只触发上游恢复，不触发 Judge。协议、Tool、上下文等硬兼容变化只重筛候选。

## 3. Execution Profile

Execution Profile 至少包含：

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
price_version
quality_curve_version
health_state
```

同一模型但不同 Provider / Channel、协议能力、上下文或推理配置，属于不同 Profile。

## 4. 模式行为

### 4.1 显式模型

```text
用户指定具体模型
→ Judge = 0
→ 不执行 ACU 模型选择
→ 不用其他模型替代
```

P0：

- 所有请求仍经过 ACU 执行和账本；
- 保留原生协议、Streaming、Tool ID 和 Thinking；
- 第一阶段不自动跨 Channel Failover；
- Provider 失败时返回原生兼容错误；
- 不展示“ACU 节省成本”。

### 4.2 acu-auto

```text
有效 Evaluation
→ 计算 effective_quality_target
→ 硬条件过滤
→ 质量曲线与不确定性过滤
→ 计算预计总成本
→ 选择最高性价比的合格 Profile
```

### 4.3 acu-high

使用相同流程，但提高基础质量偏好和不确定性惩罚。它不等于固定调用最贵模型，也不作为五日 P0 阻断项。

## 5. 有效质量目标

```text
effective_quality_target = max(
  task_base_quality_target,
  capability_escalation_floor,
  temporary_phase_override
)
```

- `task_base_quality_target`：模式基础质量；
- `capability_escalation_floor`：能力阻塞形成的 Task 下限；
- `temporary_phase_override`：Planning 等阶段覆盖。

PlanFinished Judge 创建 Execution Segment后，88 覆盖已经撤销，再根据完成后的 Plan 选择执行 Profile。

## 6. 候选过滤顺序

建议固定顺序：

1. Model / Channel 已启用；
2. 原生协议兼容；
3. Tool、Thinking、模态和结构化输出兼容；
4. 上下文容量满足：
   
   ```text
   estimated_input
   + expected_output
   + configured_safety_margin
   <= usable_context_window
   ```

5. 当前健康状态可用；
6. 质量曲线在当前 Difficulty / Quality Target 下达到最低成功概率；
7. 不低于能力升级下限；
8. 价格和 Usage 来源可计算；
9. 管理员 Route Policy 允许。

任何硬条件失败都必须保存排除原因。

## 7. 质量与成本排序

P0 不要求训练新 Router 模型，复用现有质量曲线、公开 Benchmark 先验和确定性策略。

建议对每个合格 Profile 计算：

```text
expected_total_cost
= expected_input_cost
+ expected_output_cost
+ expected_reasoning_cost
+ expected_cache_cost
+ expected_recovery_risk_cost
```

同时计算：

- 预计质量 / 成功概率；
- 不确定性惩罚；
- 上下文余量；
- Channel 健康惩罚；
- Route Explanation。

选择规则：

```text
满足质量下限的候选
→ 预计总成本最低
→ 成本近似时优先更高健康度和更大上下文余量
```

P0 不把单一 Benchmark 分数描述成单请求真实成功概率；所有数值必须标记来源和曲线版本。

## 8. Segment Route 锁定

Segment 创建时保存：

- Evaluation；
- Route Decision；
- Execution Profile；
- effective quality snapshot；
- 质量曲线和价格版本；
- 候选列表与排除原因；
- Route Explanation。

普通 Step 复用当前 Profile。

创建新 Segment 的主要路由边界：

- HumanMessage；
- PlanStarted；
- PlanFinished；
- repeated failure；
- Judge safety refresh；
- compatibility recovery；
- availability recovery；
- P1 Lease / Resume。

## 9. Judge 失败时的安全 Profile

按 `05` 顺序：

1. 最近有效 Evaluation + 风险惩罚；
2. Rules Strategy；
3. 管理员配置的安全性价比候选组。

安全候选必须：

- 支持当前原生协议和 Tool；
- 上下文容量足够并留安全余量；
- 当前健康；
- 不低于安全质量下限；
- 在合格候选中预计总成本较低。

可以配置 DeepSeek V4 Pro 级别的长上下文性价比模型作为候选，但不得写死具体模型。无合格候选时返回明确错误，不自动使用最贵模型，也不静默使用低质量模型。

## 10. Retry Ownership

02 已实测 Client 与 New API 可能同时大量 Retry。P0 必须明确单一网关 Retry Owner。

### 10.1 New API

对 ACU 执行 Channel：

```text
New API retry = 0
```

New API 只负责鉴权、额度和请求转交，不在 ACU 不知情时透明重试 Provider 调用。

### 10.2 ACU

ACU 负责记录和控制网关侧 Provider Attempt。每个 Attempt 有独立 `attempt_id`、Provider Request ID、Usage、成本和错误。

### 10.3 Client

Codex / Claude Code 仍可能自行 Retry。ACU 必须使用逻辑请求 Hash、历史增量、Trigger / Event 幂等键和 Attempt 记录识别重复请求，不能只依赖 `x-client-request-id`。

## 11. P0 上游恢复预算

P0 默认：

```text
max_provider_attempts_per_logical_request = 2
```

即一次初始 Attempt + 一次 ACU 控制的恢复 Attempt。该值可配置，但 Alpha 不允许无界级联重试。

恢复顺序：

1. 初始 Profile 的首选 Channel；
2. 同一模型、同等协议和能力配置的健康备用 Channel；
3. 若没有同模型备用 Channel，使用最近 Evaluation 重筛一个不低于当前质量下限的兼容 Profile。

第三步会改变实际模型，因此必须创建 `availability_recovery` 或 `compatibility_recovery` Segment，但不重新 Judge。

若恢复预算耗尽，返回明确错误。Client 后续 Retry 作为新的入站请求处理，但不得重复扣除已缓存的逻辑 Judge Evaluation。

## 12. Provider Error 恢复

适用：429、5xx、Timeout、Overload、网络错误。

动作：

- 记录失败 Attempt；
- 不改变 Difficulty；
- 不触发 Judge；
- 按恢复预算尝试同模型备用 Channel；
- 无备用时重筛等质或更高 Profile；
- 不因成本压力降级。

## 13. Compatibility Recovery

适用：

- Responses / Messages 不支持；
- Tool / Thinking / 模态不支持；
- 上下文不足；
- 必要字段被删除；
- 结构化输出能力不满足。

动作：

- 不将错误计入能力失败；
- 使用最近 Evaluation 重新执行硬条件过滤；
- 选择不低于当前质量下限的兼容 Profile；
- 实际模型变化时创建 compatibility Segment；
- 无合格候选时返回明确错误。

## 14. Failure Capability Recovery

同一核心失败第二次无进展时：

- `07` 产生 capability Trigger；
- `05` 重新 Judge；
- 创建新的 capability recovery Segment；
- Route 只允许保持或升级；
- 是否提高能力下限由新 Evaluation 决定。

这与 Provider / Compatibility Recovery 严格分离。

## 15. Streaming 与恢复边界

Route 必须在向客户端发送响应 Header 和首个 SSE Event 前确定。

一旦已经向客户端输出可见内容，P0 不在同一响应中静默换 Provider 或模型继续拼接，以免产生混合响应、重复 Tool Call 和不可审计账本。

Streaming 中断后：

- 记录 Attempt 的已输出字节、Usage 可见性和取消来源；
- 返回原生兼容错误或连接中断；
- 后续由客户端发起 Retry；
- 不把新 Retry 误认为新的 HumanMessage 或新 Task。

## 16. Usage 与计费

每个真实 Attempt 单独记录：

- 请求和实际模型；
- Provider / Channel；
- 输入、缓存、输出、Reasoning Token；
- Provider 返回的 Usage；
- 实际成本；
- 是否成功、失败、取消；
- Retry Owner。

用户总成本包括：

- 成功执行 Attempt；
- Judge 实际成本；
- Provider 实际计费的失败 Attempt。

只在 Provider 实际收费时向用户计入失败 Attempt 成本。ACU 不对同一逻辑 Attempt 重复收费。

## 17. Route Decision 记录

至少保存：

```text
route_decision_id
segment_id
judge_evaluation_id
policy_version
quality_curve_version
price_version
effective_quality_target
eligible_profiles
excluded_profiles_and_reasons
selected_profile
expected_quality
expected_total_cost
fallback_source
route_explanation
created_at
```

用户前台只展示实际模型、Channel、Usage、成本和简要路由说明；完整候选和内部轨迹仅管理员可见。

## 18. 成本节省口径

自动路由可以记录：

- `actual_total_cost`；
- `quality_ceiling_counterfactual_cost`；
- `cost_reduction_vs_ceiling`；
- `quality_gap_vs_ceiling`。

这些是反事实估算，必须标明基准和版本。显式模型不宣称 ACU 节省。

## 19. P0 实施范围

1. 显式模型不替换；
2. `acu-auto` 硬条件过滤；
3. 质量曲线和成本排序；
4. Segment Route 锁定；
5. PlanFinished 新 Judge 后重选 Profile；
6. Judge 故障安全性价比 Profile；
7. New API Retry = 0；
8. ACU Attempt 预算；
9. Provider / Compatibility Recovery；
10. Streaming 开始后不静默拼接切换；
11. Attempt Usage 与成本账本；
12. Route Decision 可审计。

## 20. P1

- 实时 Channel Health Score；
- Context Growth 风险估计；
- 多备用 Channel；
- Provider 账单自动对账；
- 低比例 Shadow / Dual Run；
- OpenClaw / Hermes Profile 兼容矩阵；
- 更精确的恢复风险成本；
- 管理员 Route 模拟器。

## 21. 延期项

- Learned Router；
- 在线质量曲线更新；
- 自动用户偏好学习；
- 多 Agent 协同路由；
- 跨请求 speculative execution；
- 无限制级联 Failover；
- 自动修改客户端 Tool / Prompt。

## 22. P0 验收

1. 显式模型失败时不替换为其他模型；
2. `acu-auto` 排除协议或 Tool 不兼容 Profile；
3. 上下文不足候选被排除；
4. 满足质量下限的候选中选择预计成本较低者；
5. 普通 Tool 循环 Route 不变化；
6. PlanFinished Judge 后可以选择新的 Execution Profile；
7. Judge 故障不调用最贵模型且不低于安全下限；
8. New API 不透明 Retry；
9. Provider 503 不触发 Judge；
10. 同模型备用 Channel 优先；
11. 模型变化创建 recovery Segment；
12. 最多两次 Provider Attempt；
13. Streaming 输出后不静默换模型拼接；
14. 每个 Attempt Usage 与成本独立记录；
15. Route Decision 可解释、可重放、可审计。
