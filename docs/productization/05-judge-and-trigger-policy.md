# ACU Router Judge 与触发策略

> 状态：产品设计基线，关键策略已确认  
> 版本：v0.4  
> 日期：2026-07-29  
> 依赖：`02-native-protocol-observations.md`、`04-session-task-routing-segment-state-machine-v2.md`、`04a-alpha-state-machine-implementation-profile.md`

## 1. 文档目的

本文定义：

1. 何时调用 Judge；
2. Judge 评估什么、读取什么、输出什么；
3. 普通 Agent 循环如何复用 Evaluation；
4. 未知 Agent 行为下如何避免 Evaluation 永久陈旧；
5. Judge 失败时如何安全继续；
6. Alpha P0、P1 与延期边界。

具体模型选择和 Provider 恢复由 `08-routing-and-recovery-policy.md` 定义。

## 2. 核心原则

### 2.1 Judge 评估下一 Routing Segment

Judge 不回答“最新一句话难不难”，而回答：

> 基于完整 Task、原生上下文、Plan、执行进展、失败、用户反馈和当前 Profile，下一 Routing Segment 所需的最低充分能力与风险水平是什么？

“继续”“执行吧”“好的”等短输入必须与完整 Task 一起评估。

### 2.2 Trigger Engine 与 Judge 分离

- Trigger Engine 使用确定性协议事件、状态和预算决定是否调用 Judge；
- Judge 只评估能力需求；
- Judge 不决定 Session / Task 身份；
- Judge 不直接选择模型、Provider、价格或 Route；
- Judge 不修改状态。

### 2.3 不每请求 Judge，也不允许无限不 Judge

普通 Tool 循环复用当前 Evaluation。与此同时，系统使用事件 Trigger 和 Judge 陈旧预算，为未知 Agent 行为提供有界兜底。

### 2.4 显式模型完全跳过 Judge

用户指定具体模型时 Judge 调用数为 0，不执行 ACU 模型选择，不自动替换模型，但仍记录完整状态、Attempt、Usage、成本和错误。

## 3. Judge 的逻辑职责

第一阶段由一个 LLM Judge 同时承担：

### 3.1 Q-Context

识别 Task 延续、当前阶段、最新 HumanMessage 类型、Plan 状态、Tool / Test / Build 进展、失败来源和用户反馈。

### 3.2 Q-Difficulty

评估下一 Segment 的：

- 推理深度；
- 任务范围；
- 约束密度；
- Tool 依赖；
- 验证负担；
- 上下文负担；
- 能力档位概率；
- 置信度。

未来可拆成独立模型，但不属于五日 Alpha。

## 4. 模式行为

### 4.1 显式模型

```text
具体模型
→ Judge = 0
→ 按用户指定模型执行
```

### 4.2 acu-auto

```text
Trigger 成立
→ 构造 JudgeContextEnvelope
→ 调用并校验 Judge
→ Route Decision Engine 选择满足质量要求的最高性价比 Profile
```

### 4.3 acu-high

与 `acu-auto` 使用相同 Trigger 和 Judge，只提高基础质量偏好和不确定性惩罚；不等于固定使用最贵模型，也不作为五日上线阻断项。

## 5. P0 Judge 触发器

P0 必须实现六类 Trigger。

### 5.1 新 Task

新 Session 首个自动路由请求、高置信度 New Goal / Reset、或连续性无法确认而安全拆分时，创建 Task、Segment、Evaluation 和 Route Decision。

### 5.2 所有高置信度 HumanMessage

所有真实人类新输入默认新建 Segment并重新 Judge，包括：

- “继续”“执行吧”“好的，继续”；
- 补充约束；
- 修改范围；
- 明确拒绝或不满意；
- 要求重做；
- 明显新目标。

Judge 必须读取完整 Task。Claude Messages 必须先拆出 `tool_result`；仅有 Tool Result 的 `role=user` 不触发 Judge。

### 5.3 PlanStarted

强信号：Codex 实际 `update_plan`，或 Claude 命中版本门控 Plan-only 指纹。

动作：创建 Planning Segment、调用 Judge、设置：

```text
temporary_phase_override = 88
```

### 5.4 PlanFinished

PlanFinished 创建新的 Execution Segment，并**重新 Judge**。

理由：已完成 Plan 比 Planning 开始时更具体，能够暴露真实文件范围、验证负担、上下文需求和硬能力要求。一次额外 Judge 通常比在执行阶段长期使用错误 Profile 更便宜。

动作：

- 撤销 Planning 临时覆盖；
- Judge 读取完整 Task、完成后的 Plan、当前 Profile 和执行要求；
- 新 Segment 允许保持、升级或降至不低于基础质量与能力下限的 Profile；
- 同一 PlanFinished 重放通过幂等键只产生一次 Evaluation。

### 5.5 重复核心失败

```text
同一标准化核心 Failure Signature 第二次出现
+ 中间无明确进展
+ 不是 Provider / 协议 / 权限 / 依赖 / 环境错误
→ 重新 Judge
```

第一次失败只记录 Evidence。触发后创建 `capability_recovery` Segment，Route 只允许保持或升级。

### 5.6 Judge 陈旧预算

为覆盖 OpenClaw、Hermes、未知 Agent 或未识别 Planning，P0 增加客户端无关兜底：

```text
accepted_model_responses_since_judge >= max_unjudged_model_responses
→ safety_refresh Segment
→ 重新 Judge
```

默认：

```text
max_unjudged_model_responses = 8
```

计数口径：只统计被接受的逻辑 Model Response；不统计 Provider Attempt、Retry、Streaming Event 或历史重发。

这是一项“有界陈旧”策略：不会每次请求 Judge，也不会让长自治任务永久复用最初 Evaluation。

## 6. P0 不触发 Judge

- 普通 Model Response；
- Agent 自动继续；
- 普通 ToolCall；
- 成功 ToolResult；
- 历史重发；
- Streaming 增量；
- 第一次 ExecutionFailure；
- Failure Signature 改变或有明确进展；
- Plan 内部更新；
- Provider 429、5xx、Timeout、Overload；
- Client / New API / Provider Retry；
- 单纯协议、上下文、Tool 或模态硬兼容变化。

硬兼容变化只使用最近 Evaluation 重筛候选。若必须换模型，创建 compatibility-recovery Segment，但不重新解释任务难度。

## 7. Trigger 去重与优先级

建议优先级：

```text
new_task
> human_message / user_rejected
> plan_started
> plan_finished
> repeated_failure
> safety_refresh
> compatibility_recovery
> no_trigger
```

同一请求可产生多个 Event，但每个逻辑状态变化只执行一次。同一 Trigger 因 Client / New API Retry 或历史重放重复送达时，只生成一个 Evaluation。

## 8. Trigger Engine 输入

Trigger Engine 仅使用确定性事实：

- 协议和客户端版本；
- 原生请求及规范化历史增量；
- HumanMessage / ToolCall / ToolResult；
- Plan 信号；
- 当前 Session、Task、Segment；
- 被接受的 Model Response 计数；
- Failure Signature 与进展状态；
- 当前 Profile 硬兼容状态；
- 是否 Retry、重放或重复事件。

Trigger Engine 不调用额外 LLM、不使用 Embedding，也不根据单词匹配直接推断复杂状态。

## 9. JudgeContextEnvelope

每次 Judge 请求包含：

### 9.1 原生上下文

- System / Developer / Instructions；
- Responses Input Items 或 Anthropic Messages；
- Tool Schema、Tool Call、Tool Result；
- 可见 Reasoning / Thinking；
- 最新 HumanMessage；
- 影响能力的请求参数。

### 9.2 ACU 确定性状态

- Trigger Reason；
- Task 初始目标、当前阶段；
- 当前或最近 Plan；
- 上次 Evaluation、Route、Profile；
- 基础质量、能力下限、临时覆盖；
- 最近 Tool / Test / Build；
- Failure、用户拒绝、重试、成功与进展 Evidence；
- 当前协议、上下文、Tool 和模态硬要求；
- 自上次 Judge 后的被接受 Model Response 数。

## 10. 上下文超限

第一阶段不调用额外摘要模型。

始终保留：System / Developer、最新 HumanMessage、Task 根目标、当前 Plan、上次 Evaluation 与 Route、上次 Judge 后的错误和拒绝、最近 Tool 对、Test / Build、最近 Model Response 和当前请求尾部。

优先删除：完全重复历史、重复 Tool Schema、已完成且未引用的大段 Read、重复错误正文和被后续结果覆盖的中间输出。

裁剪必须记录内容 Hash、类型、Token 估计和原因。

## 11. Judge 输出契约

Judge 只输出严格 JSON，包含：

- `task_phase`；
- `difficulty_score_raw`；
- 六项因子；
- `p_low / p_mid / p_mid_high / p_high`；
- `confidence`；
- `evidence_tags`；
- 简短 `explanation`。

Judge 不输出模型名、Provider、价格或节省率。后端以版本化公式计算 Difficulty Index、不确定性惩罚和 Evaluation Hash。

## 12. 幂等

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

## 13. Judge 失败与安全降级

处理顺序：

1. 当前 Task 最近有效 Evaluation，且 Trigger 不涉及明显新目标时，带风险惩罚复用；
2. 使用确定性 Rules Strategy；
3. 选择管理员配置的安全性价比 Profile；
4. 记录 Fallback 来源、风险标记、Attempt 和成本；
5. 不低于基础质量或能力升级下限。

安全 Profile 必须满足原生协议、Tool / Thinking / 模态、上下文容量、Channel 健康和安全质量下限；在合格候选中优先预计总成本较低者。可以配置 DeepSeek V4 Pro 级别的长上下文性价比模型作为候选，但不得写死具体模型。

无合格候选时返回明确错误，不自动使用最贵模型，也不静默降级。

## 14. 成本与账本

每次真实 Judge 调用记录模型、Provider、Prompt / Policy Version、Trigger、Context Hash、Token、延迟、实际成本、Usage 来源、状态、Cache / Fallback 和真实 Attempt。

Judge 实际成本按 1.0 倍计入总成本。同一逻辑 Evaluation 的网络重放不得重复收取逻辑费用；真实发生的上游计费 Attempt必须进入账本。

## 15. P1 与学习型触发器

P1 增加：

- 10 分钟 Routing Lease；
- 上下文增长阈值；
- 低比例 Shadow Judge；
- OpenClaw / Hermes 触发器侦察；
- 更复杂进展判断；
- Judge 健康度切换。

Shadow Judge 不改变 Route、不向用户计费，用于估算漏触发率并积累未来 Learned Trigger Model 的训练数据。

未来 Learned Trigger Model 用于提高兼容性和召回率，但不能取代新 Task、HumanMessage、PlanStarted、PlanFinished、重复失败和陈旧预算等确定性安全触发器。

## 16. P0 验收

1. 显式模型 Judge = 0；
2. 新 Task 恰好 Judge 一次；
3. Tool 循环不重复 Judge；
4. Claude ToolResult 不误判为 HumanMessage；
5. “继续”读取完整上下文并 Judge；
6. PlanStarted Judge；
7. PlanFinished Judge；
8. 重复核心失败第二次无进展 Judge；
9. 连续 8 个被接受 Model Response 触发 safety refresh；
10. Provider 503 与 Retry 不 Judge；
11. 重放 Trigger 只产生一个 Evaluation；
12. 非法 Judge 输出进入 Fallback；
13. Judge 不直接选择模型；
14. Judge Token、延迟和成本完整入账。
