# ACU Router Judge 与触发策略

> 状态：产品设计基线，关键策略已确认  
> 版本：v0.3  
> 日期：2026-07-29  
> 依赖：`02-native-protocol-observations.md`、`04-session-task-routing-segment-state-machine-v2.md`、`04a-alpha-state-machine-implementation-profile.md`

## 1. 文档目的

本文定义：

1. 何时调用 Judge；
2. Judge 评估什么；
3. Judge 读取什么上下文；
4. Judge 输出什么；
5. 普通 Agent 循环如何复用 Evaluation；
6. 自治任务如何避免永远不再触发 Judge；
7. Judge 失败时如何安全继续；
8. 五日 Alpha 的 P0、P1 与延期边界。

具体模型选择和 Provider 恢复由 `08-routing-and-recovery-policy.md` 定义。

## 2. 核心原则

### 2.1 评估下一 Routing Segment

Judge 不回答“最新一句话难不难”，而回答：

> 基于完整 Task、原生上下文、当前 Plan、执行进展、失败、用户反馈和现有 Profile，下一 Routing Segment 所需的最低充分能力与风险水平是什么？

“继续”“执行吧”“好的”等短输入必须和完整 Task 上下文一起评估。

### 2.2 Trigger Engine 与 Judge 分离

- Trigger Engine 使用确定性协议事件和状态规则，决定是否调用 Judge；
- Judge 只评估上下文和能力需求；
- Judge 不决定 Session / Task / Segment 身份；
- Judge 不调用 Provider、不直接选择模型、不修改状态。

### 2.3 Judge 不推荐具体模型

Judge 不输出模型名、Provider、价格、节省率或 Route Decision。Route Decision Engine 再结合 Evaluation、质量曲线、硬兼容、健康度和成本选择 Execution Profile。

### 2.4 原生上下文优先

JudgeContextEnvelope 以 Codex Responses 或 Claude Messages 为第一事实来源。第一阶段不使用额外 LLM 对上下文做摘要替换。

### 2.5 一个 Segment 默认只 Judge 一次

普通 Model Response、ToolCall、ToolResult、Streaming 和 Retry 不重复 Judge。只有明确 Trigger 创建新 Segment 或新 Evaluation。

### 2.6 显式模型完全跳过 Judge

用户指定具体模型时：

- Judge 调用数为 0；
- 不执行 ACU 模型选择；
- 不因 Planning、Failure 或 HumanMessage 替换模型；
- 仍记录状态、Attempt、Usage、成本和错误。

## 3. Judge 的逻辑职责

第一阶段由一个 LLM Judge 同时承担：

### 3.1 Q-Context

识别：

- Task 是否延续；
- 当前阶段：理解、Planning、Execution、Verification、Recovery 或 Unknown；
- 最新 HumanMessage 是继续、补充约束、拒绝、重做还是新目标；
- 最近 Tool、Test、Build 和错误表示进展、失败还是环境问题；
- 当前 Plan 是否暴露新的范围、约束或能力需求。

Q-Context 只提供 Evaluation Evidence，不替代 Trigger Engine 的确定性身份判断。

### 3.2 Q-Difficulty

评估下一 Segment 的最低充分能力：

- 推理深度；
- 任务范围；
- 约束密度；
- 工具依赖；
- 验证负担；
- 上下文负担；
- 能力档位概率；
- 评估置信度。

## 4. 模式行为

### 4.1 显式模型

```text
具体模型
→ Judge = 0
→ 不进行 ACU 模型选择
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

P0 必须实现四类 Trigger，不是只有用户新消息。

### 5.1 新 Task 首次请求

适用：

- 新 Session 的首个 `acu-auto` / `acu-high` 请求；
- 高置信度 New Goal / Reset；
- 连续性无法确认而安全拆分的新 Task。

动作：创建 Task、首个 Segment、Evaluation 和 Route Decision。

### 5.2 所有高置信度 HumanMessage

所有真实人类新输入默认创建新 Segment并重新 Judge，包括：

- “继续”“执行吧”“好的，继续”；
- 补充约束；
- 修改范围；
- 明确拒绝或不满意；
- 要求重做；
- 明显新目标。

Judge 必须读取完整 Task 上下文，不得只评估最新文本。

Claude Messages 必须先拆出 `tool_result`：

- 仅有 Tool Result 的 `role=user` 不触发 Judge；
- Tool Result + Text 混合时，只有高置信度确认的人类 Text 触发一次 Judge。

### 5.3 PlanStarted

强信号：

- Codex 实际调用 `update_plan`；
- Claude 命中版本门控 Plan-only 指纹；
- Recovery 后再次出现强 Replanning 信号。

动作：

- 创建 Planning Segment；
- 调用 Judge；
- `temporary_phase_override = 88`；
- 重新选择适合 Planning 的 Profile。

### 5.4 自治任务安全 Trigger：重复核心失败

为避免 Agent 在没有新 HumanMessage、也没有 Planning 强信号时永久复用错误 Route，P0 增加一个最小安全 Trigger：

```text
同一标准化核心 Failure Signature 第二次出现
+ 中间没有明确进展
+ 不是 Provider / 协议 / 权限 / 依赖 / 环境错误
→ 重新 Judge
```

动作：

- 创建 `capability_recovery` Segment；
- 新 Evaluation 读取两次失败及中间策略；
- Route Decision 只允许保持或升级；
- 是否提高 `capability_escalation_floor` 由新 Evaluation 决定。

第一次失败只记录 Evidence，不重新 Judge。具体分类和 Signature 规则见 `07-failure-taxonomy-and-blockage-rules.md`。

## 6. P0 不触发 Judge

以下事件复用当前 Evaluation：

- 普通 Model Response；
- Agent 自动继续；
- 普通 ToolCall；
- 成功 ToolResult；
- 单纯 Tool Result 历史重发；
- Streaming 增量；
- 第一次 ExecutionFailure；
- Failure Signature 改变或存在明确进展；
- Plan 内部状态更新；
- PlanFinished 且没有新范围或能力需求；
- Provider 429、5xx、Timeout、Overload；
- Client / New API / Provider Retry；
- 协议、上下文、Tool 或模态硬兼容变化。

硬兼容变化只使用最近 Evaluation 重筛候选。若必须换模型，创建 `compatibility_recovery` Segment，但不重新解释任务难度。

## 7. P1 触发器

P0 全链路稳定后补充：

- 语义相近但文本不同的重复失败；
- 复杂“有进展 / 无进展”判断；
- 10 分钟 Routing Lease 过期；
- 长期 Resume 且旧 Segment Lease 已过期；
- UserRejected 的更细粒度风险覆盖；
- Judge 模型健康度和自动切换。

Session 不设置固定身份过期。

## 8. Trigger 去重与优先级

一个原生请求可产生多个 Event，但每个逻辑状态变化只能执行一次。

建议优先级：

```text
new_task
> human_message / user_rejected
> plan_started / replanning
> repeated_failure
> compatibility_recovery
> no_trigger
```

同一请求同时包含 ToolResult 和 HumanMessage时：先归档 ToolResult，再由 HumanMessage 触发一次 Judge。

同一 Trigger 因 Client / New API Retry 重复送达时，只生成一个逻辑 Evaluation。

## 9. Trigger Engine 输入

Trigger Engine 仅使用确定性事实：

- 协议和客户端版本；
- 原生请求及规范化历史增量；
- HumanMessage / ToolCall / ToolResult；
- Codex `update_plan`；
- Claude Plan-only 指纹与 `ExitPlanMode`；
- 当前 Session、Task、Segment；
- Failure Signature、类别、重复次数和进展 Evidence；
- 当前 Profile 的硬兼容状态；
- 是否为重试、重放或重复事件。

Trigger Engine 不调用额外 LLM、不使用 Embedding，也不根据单词匹配直接推断 Planning 或能力阻塞。

## 10. JudgeContextEnvelope

每次 Judge 请求包含两部分。

### 10.1 原生 API 上下文

尽可能保留：

- System / Developer / Instructions；
- Responses Input Items 或 Anthropic Messages；
- Tool Schema；
- Tool Call / Tool Result；
- 可见 Reasoning / Thinking；
- 最新 HumanMessage；
- 影响能力需求的请求参数。

### 10.2 ACU 确定性状态

从 PostgreSQL 和事件规则读取：

- Trigger Reason；
- Task 初始目标和当前阶段；
- 当前或最近活动 Plan；
- 上一次 Evaluation 和 Route Decision；
- 当前 Execution Profile；
- `task_base_quality_target`；
- `capability_escalation_floor`；
- `temporary_phase_override`；
- 最近 Tool / Test / Build；
- Failure Signature、类别、重复次数和进展 Evidence；
- 用户拒绝、成功和重试 Evidence；
- 当前上下文、Tool、模态和协议硬要求。

数据库随机 ID 只用于追踪，不应作为难度语义输入。

## 11. 上下文超限

第一阶段不调用额外摘要模型。

始终优先保留：

1. System / Developer / Instructions；
2. 最新 HumanMessage；
3. Task 初始目标；
4. 当前 Plan；
5. 上次 Evaluation 与 Route；
6. 上次 Judge 后的错误和拒绝；
7. 最近 Tool Call / Result；
8. 最近 Test / Build；
9. 最近 Model Response；
10. 当前原生请求尾部。

优先删除重复历史、重复 Tool Schema、已完成的大段 Read 输出、重复错误正文和被后续结果覆盖的中间输出。每次裁剪记录内容 Hash、类型、Token 估计和删除原因。

## 12. Judge 输出契约

Judge 只输出严格 JSON：

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

约束：

- `difficulty_score_raw`：0—100；
- 六项因子：0—10；
- 四档概率和为 1；
- `confidence`：0—1；
- `explanation` 简短、可审计，不输出思维过程；
- 不得输出具体模型、Provider 或价格。

后端以版本化公式计算 Difficulty Index、主档位、不确定性惩罚和 Evaluation Hash。

## 13. Evaluation 复用与幂等

建议幂等键：

```text
SHA256(
  policy_version
  + prompt_version
  + judge_model
  + trigger_event_id
  + context_hash
)
```

允许复用同一 Trigger 的网络重试、并发去重和完全相同 Evaluation Key。不得用旧 Cache 跳过新 HumanMessage、新 PlanStarted、重复失败 Trigger 或 Lease 过期后的评估。

不得只依赖 `x-client-request-id`、New API Request ID 或 Provider Request ID。

## 14. Judge 失败与安全降级

处理顺序：

1. 当前 Task 的最近有效 Evaluation，且本次 Trigger 不涉及明显新目标或重大范围变化；
2. Rules Strategy；
3. 管理员配置的安全性价比 Profile；
4. 无安全候选时返回明确错误。

安全性价比 Profile 必须：

- 原生协议、Tool、Thinking、模态兼容；
- 上下文容量覆盖当前请求和预期输出，并保留安全余量；
- Channel 健康；
- 不低于安全质量下限；
- 在合格候选中优先预计总成本较低者。

可配置 DeepSeek V4 Pro 级别的长上下文性价比模型作为候选，但不把具体模型名写死。Judge 故障时不自动选择最顶尖、最贵模型，也不静默选择低质量模型。

## 15. 调用校验与账本

每次 Judge 调用校验 HTTP、严格 JSON、Schema Version、数值范围、概率、六项因子和非法字段。损坏结果进入 Fallback。

每次真实调用记录 Judge 模型、Provider、Prompt / Policy Version、Trigger、Context Hash、Token、延迟、成本、Usage 来源、Evaluation 状态、Cache / Fallback 和每个真实 Attempt。

Judge 实际成本按 1.0 倍计入用户总成本；同一逻辑 Evaluation 不重复扣费，但实际上游重复计费 Attempt 必须进入账本。

## 16. P0 实施范围

- 显式模型跳过 Judge；
- 新 Task、HumanMessage、PlanStarted、重复核心失败 Trigger；
- Segment 内 Evaluation 复用；
- Codex / Claude 原生上下文解析；
- ToolResult 与 HumanMessage 区分；
- JudgeContextEnvelope；
- 严格 Schema 校验；
- Evaluation 幂等；
- Rules Fallback；
- Judge Token、成本和延迟记录。

## 17. P0 验收场景

1. 显式模型 Judge 调用数为 0；
2. 新 `acu-auto` Task 恰好 Judge 一次；
3. 普通 Tool 循环不重复 Judge；
4. Claude 仅 Tool Result 的 `role=user` 不触发；
5. Claude Tool Result +真实 Text 触发一次；
6. “继续”使用完整上下文生成新 Evaluation；
7. Codex `update_plan` 与 Claude Plan-only 触发 Planning Evaluation；
8. PlanFinished 无新约束时不再次 Judge；
9. 第一次核心失败不触发，第二次相同核心失败且无进展时触发一次；
10. Provider 503、权限错误、依赖错误和 Retry 不触发能力 Judge；
11. 同一 Trigger 经 New API Retry 只生成一个逻辑 Evaluation；
12. Judge 非法 JSON 进入 Fallback；
13. Judge 不输出具体模型；
14. Judge 成本、Token、延迟和 Attempt 可审计。
