# ACU Router Judge 与触发策略

> 状态：产品设计基线，关键策略已确认  
> 版本：v0.5  
> 日期：2026-07-29  
> 依赖：`02-native-protocol-observations.md`、`04-session-task-routing-segment-state-machine-v2.md`、`04a-alpha-state-machine-implementation-profile.md`

## 1. 文档目的

本文定义 Judge 何时调用、读取什么、输出什么，以及如何在未知 Agent 行为下避免 Evaluation 永久陈旧。模型选择公式和 Provider 恢复由 `08-routing-and-upstream-recovery-policy.md` 定义。

## 2. 核心原则

### 2.1 Judge 评估下一 Routing Segment

Judge 不回答“最新一句 Prompt 难不难”，而回答：

> 基于完整 Task、原生上下文、Plan、执行进展、失败、用户反馈和当前 Profile，下一 Routing Segment 所需的能力分布、风险和不确定性是什么？

“继续”“执行吧”“好的”等短输入必须与完整 Task 一起评估。

### 2.2 Trigger Engine 与 Judge 分离

- Trigger Engine 使用确定性协议事件、状态和预算决定是否 Judge；
- Judge 不决定 Session / Task 身份；
- Judge 不直接选择模型、Provider 或价格；
- Route Decision Engine 使用 Judge 输出和版本化连续价值公式选 Profile。

### 2.3 不每请求 Judge，也不允许无限不 Judge

普通 Tool 循环复用当前 Evaluation。语义事件、重复失败和 10 分钟 Routing Lease共同提供有界兜底，不按固定 Step / Response 数刷新。

### 2.4 显式模型跳过 Judge

用户指定具体模型时 Judge = 0，不执行 ACU 模型选择，也不自动替换模型；状态、Attempt、Usage、成本和错误仍完整记录。

## 3. Judge 职责

### Q-Context

识别 Task 延续、阶段、HumanMessage 类型、Plan、Tool / Test / Build 进展、失败来源和用户反馈。

### Q-Difficulty

输出下一 Segment 的推理深度、任务范围、约束密度、Tool 依赖、验证负担、上下文负担、能力档位概率和置信度。

Judge 只提供 Evaluation，不输出具体模型。

## 4. 模式行为

```text
显式模型
→ Judge = 0
→ 按指定模型执行

acu-auto / acu-high
→ Trigger
→ JudgeContextEnvelope
→ Judge Evaluation
→ Route Decision Engine
→ 当前 ACU 连续价值公式
```

`acu-high` 只提高质量偏好与不确定性惩罚，不等于固定使用最贵模型。

## 5. P0 Judge 触发器

P0 实现六类 Trigger。

### 5.1 新 Task

新 Session 首个自动路由请求、高置信度 New Goal / Reset，或连续性无法确认而拆分时，创建 Task、Segment、Evaluation 和 Route Decision。

### 5.2 所有高置信度 HumanMessage

包括“继续”、补充约束、修改范围、拒绝、不满意、重做和新目标。Judge 必须读取完整 Task。

Claude Messages 必须先剥离 `tool_result`；仅有 Tool Result 的 `role=user` 不触发 Judge。

### 5.3 PlanStarted

Codex 实际 `update_plan`，或 Claude 命中版本门控 Plan-only 指纹。

动作：创建 Planning Segment、Judge，并设置：

```text
temporary_phase_override = 88
```

88 是后续连续价值公式的质量偏好锚点，不是“候选模型必须高于 88”的硬阈值。

### 5.4 PlanFinished

PlanFinished 创建 Execution Segment并撤销 Planning 临时锚点。普通阶段切换复用已有 Judge Evaluation；只有完成事件同时提供新目标、范围扩大、新约束、Replanning 或高置信度能力阻塞证据时重新 Judge。

动作：

- 撤销 Planning 88 锚点；
- 复用 Evaluation 时仍可用恢复后的质量目标重新计算 Route；
- 有 Rejudge Evidence 时 Judge 读取完成后的 Plan、Task、当前 Profile 和执行要求；
- 同一 PlanFinished 重放只产生一次 Evaluation。

### 5.5 重复核心失败

```text
同一标准化核心 Failure Signature 第二次出现
+ 中间无明确进展
+ 不是 Provider / 协议 / 权限 / 依赖 / 环境错误
→ 重新 Judge
```

第一次失败只记录 Evidence。触发后创建 `capability_recovery` Segment，Route 只允许保持或升级。

### 5.6 Routing Lease

不得按每 N Step 或每 N Response 周期性运行 Judge。普通连续 Step 复用；10 分钟 Routing Lease 到期后，在下一次可处理请求边界创建 Segment并 Judge。

## 6. P0 不触发 Judge

- 普通 Model Response；
- Agent 自动继续；
- ToolCall / 成功 ToolResult；
- 历史重发和 Streaming 增量；
- 第一次 ExecutionFailure；
- Failure Signature 改变或已有进展；
- Plan 内部更新；
- Provider 429、5xx、Timeout、Overload；
- Client / New API / Provider Retry；
- 单纯协议、上下文、Tool 或模态硬兼容变化。

硬兼容变化只使用最近 Evaluation 重筛 Profile；必要时创建 compatibility-recovery Segment，但不重新解释任务难度。

## 7. Trigger 去重与优先级

```text
new_task
> human_message / user_rejected
> plan_started
> plan_finished
> repeated_failure
> compatibility_recovery
> no_trigger
```

一个原生请求可产生多个 Event，但每个逻辑状态变化只执行一次。Client / New API Retry 或历史重发不得重复生成 Evaluation。

## 8. JudgeContextEnvelope

包含：

- System / Developer / Instructions；
- Responses Items 或 Anthropic Messages；
- Tool Schema、Tool Call、Tool Result；
- 可见 Reasoning / Thinking；
- 最新 HumanMessage；
- Task 初始目标和当前阶段；
- 当前或最近 Plan；
- 上次 Evaluation、Route 和 Profile；
- 基础质量偏好、能力升级下限、临时覆盖；
- 最近 Tool / Test / Build；
- Failure、拒绝、Retry、成功和进展 Evidence；
- 当前硬兼容要求；
- 自上次 Judge 后的 accepted Model Response 数。

第一阶段不使用额外 LLM 摘要替换原生上下文。超限时确定性裁剪，并记录内容 Hash、Token 估计和原因。

## 9. Judge 输出契约

严格 JSON：

```json
{
  "schema_version": "acu-judge-v1",
  "task_phase": "execution",
  "difficulty_score_raw": 0,
  "factors": {
    "reasoning_depth": 0,
    "task_scope": 0,
    "constraint_density": 0,
    "tool_dependency": 0,
    "verification_burden": 0,
    "context_burden": 0
  },
  "p_low": 0,
  "p_mid": 0,
  "p_mid_high": 0,
  "p_high": 0,
  "confidence": 0,
  "evidence_tags": [],
  "explanation": ""
}
```

Judge 不输出模型名、Provider、价格或节省率。后端计算 Difficulty Index、不确定性惩罚和 Evaluation Hash。

## 10. 与路由公式的边界

Judge 产生 Difficulty 与能力分布。Route Decision Engine 再使用当前实现：

- 模型质量曲线 `Q_m(d)`；
- 不确定性和 Judge Entropy 惩罚；
- 调用成本与预期 fallback 成本；
- 成本—质量 Pareto 前沿；
- `effective_quality_target` 驱动的质量权重、风险权重和指数；
- `valueUtility` 最大化。

`effective_quality_target` 是公式偏好锚点，不是候选预测分的硬过滤线。`meetsQualityTarget` 只用于解释和展示。

## 11. 幂等

```text
judge_idempotency_key = SHA256(
  policy_version
  + prompt_version
  + judge_model
  + trigger_event_id
  + context_hash
)
```

不得只依赖 Client Request ID、New API Request ID 或 Provider Request ID。

## 12. Judge 失败与安全降级

顺序：

1. 当前 Task 最近有效 Evaluation，且 Trigger 不涉及明显新目标时，带风险惩罚复用；
2. 确定性 Rules Strategy；
3. 管理员配置的安全性价比 Profile；
4. 记录 Fallback 来源、风险、Attempt 和成本。

安全 Profile 必须满足协议、Tool / Thinking / 模态、上下文和健康硬要求，并达到管理员安全档；在候选组中选择性价比更高者，而非自动使用最贵模型。

## 13. 成本与账本

每次真实 Judge 调用记录模型、Provider、Prompt / Policy Version、Trigger、Context Hash、Token、延迟、实际成本、Usage 来源、状态、Cache / Fallback 和真实 Attempt。

Judge 实际成本按 1.0 倍计入总成本。同一逻辑 Evaluation 的网络重放不得重复计逻辑费用。

## 14. P1 与延期

P1：10 分钟 Routing Lease、上下文增长 Trigger、低比例 Shadow Judge、OpenClaw / Hermes 侦察、更复杂进展判断和 Judge 健康切换。

未来 Learned Trigger Model 用于提高兼容性和召回率，但不能取代新 Task、HumanMessage、PlanStarted、带 Rejudge Evidence 的 PlanFinished、重复失败和 Routing Lease 等确定性安全触发器。

## 15. P0 验收

1. 显式模型 Judge = 0；
2. 新 Task 恰好 Judge 一次；
3. Tool 循环不重复 Judge；
4. Claude ToolResult 不误判 HumanMessage；
5. “继续”读取完整上下文并 Judge；
6. PlanStarted Judge；普通 PlanFinished 复用，带 Rejudge Evidence 时重新 Judge；
7. 重复核心失败第二次无进展 Judge；
8. 连续 20 个普通 Tool Step 不因固定次数重新 Judge；
9. Provider 503 与 Retry 不 Judge；
10. 88 作为连续公式偏好锚点而非硬阈值；
11. 非法 Judge 输出进入 Fallback；
12. Judge Token、延迟和成本完整入账。
