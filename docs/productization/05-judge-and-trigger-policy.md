# ACU Router Judge 与触发策略

> 状态：产品设计初稿，待创始人审阅  
> 版本：v0.1  
> 日期：2026-07-29  
> 依赖：`02-native-protocol-observations.md`、`04-session-task-routing-segment-state-machine-v2.md`、`04a-alpha-state-machine-implementation-profile.md`

## 1. 文档目的

本文定义 ACU Router：

1. 什么情况下调用 Judge；
2. Judge 需要看到什么上下文；
3. Judge 输出什么、不输出什么；
4. 普通 Tool 循环如何复用已有 Evaluation；
5. Judge 超时、失败、重试和重复请求如何处理；
6. 五日 Alpha 的 P0、P1 与延期边界。

本文不定义具体模型曲线和最终价值路由公式，相关内容由 `08-routing-and-recovery-policy.md` 负责。

## 2. 核心原则

### 2.1 Judge 评估“下一段工作所需能力”

Judge 的问题不是：

> 最新一句 Prompt 看起来难不难？

而是：

> 基于当前 Task 目标、完整原生上下文、计划、进展、失败、用户反馈和当前执行状态，下一 Routing Segment 所需的最低充分能力与风险水平是什么？

### 2.2 Trigger Engine 与 Judge 分离

- Trigger Engine 使用确定性协议事件和状态规则，决定“是否调用 Judge”；
- Judge 只负责在已触发时评估上下文和能力需求；
- Judge 不自行决定 Session、Task 或 Segment 身份；
- Judge 不直接调用 Provider、不执行路由、不修改状态。

### 2.3 Judge 不选择具体模型

Judge 不输出：

- 具体模型名称；
- Provider / Channel；
- 价格；
- 成本节省率；
- 最终 Route Decision。

Judge 输出难度、能力概率、阶段和证据；Route Decision Engine 再结合模型曲线、兼容性、健康度和成本选择 Execution Profile。

### 2.4 原生请求是第一事实来源

JudgeContextEnvelope 以原生 Codex Responses 或 Claude Messages 请求为主，不用本地小模型替换、总结或改写用户上下文。

### 2.5 一个 Routing Segment 默认只 Judge 一次

Segment 创建时产生或继承 Judge Evaluation。普通 Step、ToolCall、ToolResult、Streaming 和 Retry 不重复调用 Judge。

### 2.6 显式模型完全跳过 Judge

用户指定具体模型时：

- Judge 调用数必须为 0；
- 不因 HumanMessage、Planning 或 Failure 自动改变模型；
- 仍记录状态、轨迹、Usage、Attempt 和成本。

## 3. 第一阶段 Judge 职责

第一阶段由一个 LLM Judge 同时承担两个逻辑职责：

### 3.1 Q-Context

识别当前上下文状态：

- 当前 Task 是否延续；
- 当前阶段：理解、Planning、Execution、Verification、Recovery 或 Unknown；
- 当前输入是继续、补充约束、拒绝、重做还是新目标；
- 最近 Tool 与测试结果表示进展、失败还是环境问题；
- 当前 Plan 是否暴露新的范围或约束。

### 3.2 Q-Difficulty

评估下一 Routing Segment 的最低充分能力需求：

- 推理深度；
- 任务范围；
- 约束密度；
- 工具依赖；
- 验证负担；
- 上下文负担；
- 能力档位概率；
- 评估置信度。

未来可以拆成独立 Q-Context 与 Q-Difficulty 模型，但不属于五日 Alpha。

## 4. 模式行为

### 4.1 显式模型

```text
request.model = 具体模型
→ 不调用 Judge
→ 不执行 ACU 模型选择
→ 按用户指定模型执行
```

### 4.2 acu-auto

```text
触发器成立
→ 构造 JudgeContextEnvelope
→ 调用 Judge
→ 生成 Evaluation
→ Route Decision Engine 选择性价比最高的合格 Profile
```

### 4.3 acu-high

与 `acu-auto` 使用同一 Trigger 和 Judge，只提高基础质量偏好与不确定性惩罚。`acu-high` 不代表固定最贵模型，且不作为五日上线阻断项。

## 5. P0 Judge 触发器

五日 Alpha 只实现三类重新 Judge 事件。

### 5.1 新 Task 首次请求

适用：

- 新 Session 的首个 `acu-auto` / `acu-high` 请求；
- 高置信度新 Goal / Reset；
- 连续性无法确认而安全拆分的新 Task。

动作：

- 创建 Task 与首个 Segment；
- 构造完整 JudgeContextEnvelope；
- 调用 Judge；
- 生成首个 Route Decision。

### 5.2 高置信度 HumanMessage

所有被确认的人类新输入默认创建新 Segment并重新 Judge，包括：

- “继续”“执行吧”“好的，继续”；
- 补充约束；
- 修改目标范围；
- 明确拒绝或不满意；
- 要求重做；
- 明显新目标。

Judge 必须读取完整 Task 上下文，不能只评估最新短文本。

Claude Messages 必须先拆出 `tool_result`；仅有 Tool Result 的 `role=user` 不触发 Judge。混合 Tool Result + Text 时，只有高置信度确认的人类 Text 才触发。

### 5.3 PlanStarted

强信号：

- Codex 实际调用 `update_plan`；
- Claude 命中版本门控的 Plan-only 指纹；
- 后续 P1 中的 Replanning 强信号。

动作：

- 创建 Planning Segment；
- 调用 Judge；
- `temporary_phase_override` 暂定为 88；
- 由 Route Decision Engine 根据 Planning 阶段重新选择 Profile。

## 6. P0 不触发 Judge 的事件

以下事件复用当前 Evaluation：

- 普通 Model Response；
- Agent 自动继续；
- 普通 ToolCall；
- 成功 ToolResult；
- 单纯 Tool Result 历史重发；
- Streaming 增量；
- Plan 内部状态更新；
- PlanFinished 且没有新范围或能力需求；
- Provider 429、5xx、Timeout、Overload；
- Client / New API / Provider Retry；
- 单纯硬兼容或上下文能力变化。

硬兼容变化只重筛候选 Profile，不重新解释任务难度。若实际模型必须变化，创建 compatibility Segment并继承最近 Evaluation。

## 7. P1 触发器

P0 全链路稳定后补充：

### 7.1 重复核心失败且无进展

当同一标准化 Failure Signature 第二次出现，且策略、错误数量和结果均无明确改善：

- 创建 capability-block Segment；
- 重新 Judge；
- Route Decision 只允许保持或升级；
- 由新 Evaluation 决定是否提高 `capability_escalation_floor`。

第一次失败不重新 Judge。

### 7.2 10 分钟 Routing Lease 过期

下一次请求到达时惰性检查：

```text
now - segment.last_activity_at > 10 分钟
```

若过期：

- 保留 Session 与 Task；
- 创建新 Segment；
- 重新 Judge。

### 7.3 长期 Resume

Session 不设置身份过期。强连续性证据成立时保留 Session / Task；若旧 Segment Lease 已过期，创建 resume Segment并重新 Judge。

## 8. Trigger Engine 输入

Trigger Engine 只使用确定性事实：

- 协议类型与客户端版本；
- 当前原生请求；
- 规范化历史增量；
- HumanMessage / ToolCall / ToolResult；
- Codex `update_plan`；
- Claude Plan-only 指纹与 `ExitPlanMode`；
- 当前 Session、Task、Segment；
- 最近活动时间；
- Failure Signature 与重复次数；
- 当前 Execution Profile 的硬兼容状态；
- 请求是否为重试或历史重放。

Trigger Engine 不调用额外 LLM，不使用 Embedding，不根据单词匹配直接推断复杂任务状态。

## 9. JudgeContextEnvelope

每次 Judge 请求由两部分组成。

### 9.1 当前原生 API 上下文

尽可能保留：

- System / Developer / Instructions；
- Responses Input Items 或 Anthropic Messages；
- Tool Schema；
- Function / Tool Call；
- Function Call Output / Tool Result；
- 可见 Reasoning / Thinking；
- 最新人类输入；
- 当前请求参数中影响任务能力的字段。

### 9.2 ACU 确定性状态补充

不经过额外模型总结，直接从 PostgreSQL 与事件规则读取：

- `session_id`、`task_id`、`segment_id`；
- Trigger Reason；
- Task 初始目标；
- 当前 Task Phase；
- 当前或最近活动 Plan；
- 上一次 Judge Evaluation；
- 上一次 Route Decision；
- 当前 Execution Profile；
- `task_base_quality_target`；
- `capability_escalation_floor`；
- `temporary_phase_override`；
- 最近 Tool / Test / Build 结果；
- 最近 Failure Signature 和重复次数；
- 用户拒绝或重试 Evidence；
- 最近成功与进展 Evidence；
- 当前上下文、Tool、模态和协议硬要求。

### 9.3 Envelope 建议结构

```json
{
  "schema_version": "judge-context-v1",
  "trigger": {
    "reason": "human_message",
    "event_id": "evt_...",
    "occurred_at": "ISO-8601"
  },
  "state": {
    "session_id": "ses_...",
    "task_id": "task_...",
    "segment_id": "seg_...",
    "task_phase": "execution",
    "task_base_quality_target": 80,
    "capability_escalation_floor": 0,
    "temporary_phase_override": 0
  },
  "previous": {
    "judge_evaluation_id": "judge_...",
    "route_decision_id": "route_...",
    "execution_profile_id": "profile_..."
  },
  "evidence": {
    "active_plan": null,
    "recent_failures": [],
    "recent_successes": [],
    "user_feedback": []
  },
  "native_request": {}
}
```

数据库 ID 只用于追踪，不应让 Judge 根据随机 ID 推断难度。

## 10. 上下文超限处理

第一阶段不使用本地模型或额外 LLM 做摘要。

### 10.1 始终保留

1. System / Developer / Instructions；
2. 最新高置信度 HumanMessage；
3. Task 初始目标；
4. 当前活动 Plan；
5. 上一次 Judge 与 Route Decision；
6. 上次 Judge 后的错误和用户拒绝 Evidence；
7. 最近 Tool Call / Result 对；
8. 最近 Test / Build 结果；
9. 最近若干 Model Response；
10. 当前原生请求尾部。

### 10.2 优先删除

- 完全重复的历史 Item；
- 重复 Tool Schema；
- 已完成且未被后续引用的大段 Read 输出；
- 重复错误正文，只保留一次正文和计数；
- 已被后续结果覆盖的早期中间输出。

### 10.3 裁剪审计

每个被省略内容记录：

- 原始数据库 ID；
- 内容 Hash；
- 类型；
- 原始 Token 估计；
- 删除原因。

Judge 最大上下文长度必须可配置，并优先使用长上下文 Judge 模型。

## 11. Judge 输出契约

Judge 只输出严格 JSON。

### 11.1 P0 输出字段

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
- 四档概率之和为 1；
- `confidence`：0—1；
- `evidence_tags`：最多 8 个结构化标签；
- `explanation`：简短、可审计，不输出思维过程；
- 不得输出具体模型或价格。

### 11.2 后端派生字段

后端根据版本化公式计算：

- `factor_composite`；
- `difficulty_index`；
- 主能力档位；
- 不确定性惩罚；
- Evaluation Hash。

当前已有六因子和确定性 Difficulty Index 代码可以复用。公式必须带版本号，后续校准不得覆盖历史结果。

## 12. Evidence Tags

P0 建议支持：

- `new_task`；
- `goal_continuation`；
- `goal_changed`；
- `new_constraint`；
- `user_rejected`；
- `planning`；
- `replanning`；
- `tool_heavy`；
- `verification_heavy`；
- `context_heavy`；
- `repeated_failure`；
- `environment_blocked`；
- `progress_observed`；
- `ambiguity_high`。

这些标签是 Judge 对证据的结构化解释，不直接按固定分值加减难度。

## 13. Evaluation 复用与幂等

### 13.1 Segment 复用

当前 Segment 没有新 Trigger 时，直接复用其 Judge Evaluation 和 Route Decision。

### 13.2 Judge 请求幂等键

建议：

```text
judge_idempotency_key = SHA256(
  policy_version
  + prompt_version
  + judge_model
  + trigger_event_id
  + context_hash
)
```

同一 Trigger Event 因客户端或 New API Retry 被重复送达时，只产生一次 Judge Evaluation。

不得只依赖：

- `x-client-request-id`；
- New API Request ID；
- Provider Request ID。

02 已实测客户端重试可能复用 Client Request ID。

### 13.3 Cache 边界

允许复用：

- 同一 Trigger Event 的网络重试；
- 同一逻辑请求的并发去重；
- 完全相同的 Evaluation Key。

不得用旧 Cache 跳过：

- 新 HumanMessage；
- 新 PlanStarted；
- P1 的 capability block；
- Lease 过期后的重新评估。

即使最新文本相同，只要 Trigger Event 或 Task 状态不同，也应形成新 Evaluation。

## 14. Judge 失败与降级

Judge 故障不能让所有用户请求直接不可用。

处理顺序：

1. 若当前 Task 有最近有效 Evaluation，且 Trigger 不涉及明显新目标，带风险惩罚复用；
2. 否则使用现有确定性 Rules Strategy 生成 fallback Evaluation；
3. Rules Strategy 也不可用时，选择管理员配置的保守安全 Profile；
4. 记录 `judge_status`、错误类别、Fallback 来源和风险标记；
5. 不在故障时静默选择低于基础质量下限的模型。

用户显式指定模型时不受 Judge 故障影响。

Judge Fallback 的具体保守 Profile 与预算由 `08` 定义。

## 15. Judge 调用与响应校验

每次 Judge 调用至少校验：

- HTTP 成功；
- 严格 JSON 可解析；
- Schema Version 支持；
- 数值范围合法；
- 概率归一化；
- 六项因子完整；
- Explanation 长度受限；
- 不包含模型推荐或未允许字段。

失败时不得直接使用部分损坏结果，应进入第 14 节 Fallback。

Judge 模型、Provider、超时、最大 Token 和 Prompt Version 均为配置项。五日 Alpha 不把某个 Judge 模型写死为产品语义。

## 16. 成本、延迟与账本

每次真实 Judge 调用记录：

- Judge 模型与 Provider；
- Prompt Version；
- Trigger Reason；
- Context Hash；
- 输入、缓存、输出 Token；
- 延迟；
- 实际成本；
- Usage 来源；
- Evaluation 状态；
- 是否 Cache Hit / Fallback。

Alpha 按实际 Judge 成本 1.0 倍计入用户总成本。相同 Trigger Event 的重复网络传输不得重复扣除逻辑 Judge 成本；若上游实际产生多次计费 Attempt，则每个 Attempt 必须进入账本并标明原因。

## 17. P0 实施范围

五日内必须实现：

1. 显式模型跳过 Judge；
2. 新 Task 首次 Judge；
3. 高置信度 HumanMessage Judge；
4. PlanStarted Judge；
5. Segment 内 Evaluation 复用；
6. Codex / Claude 原生上下文解析；
7. ToolResult 与 HumanMessage 区分；
8. JudgeContextEnvelope；
9. 严格 JSON Schema 校验；
10. Evaluation 幂等；
11. Rules Fallback；
12. Judge Token、成本和延迟记录。

## 18. P1 实施范围

- 重复 Failure Signature 后重新 Judge；
- 10 分钟 Segment Lease；
- 长期 Resume 后重新 Judge；
- UserRejected 的临时风险权重；
- 更完整的 Success / Progress Evidence；
- 管理员查看 Judge Context 裁剪记录；
- Judge 模型健康度和自动切换。

## 19. 延期项

- 独立 Q-Context 模型；
- 独立 Q-Difficulty 模型；
- 本地 Router 模型；
- Embedding / 语义 Session 匹配；
- LLM 上下文摘要器；
- 弱信号 Planning 自动识别；
- 复杂 Failure 分类器；
- 用户自定义连续质量分；
- 在线学习和自动更新 Prompt；
- 9B Router 训练。

## 20. P0 验收场景

1. 显式模型请求 Judge 调用数为 0；
2. 新 `acu-auto` Task 恰好调用一次 Judge；
3. 普通 Tool Call / Result 循环不重复 Judge；
4. Claude 仅含 Tool Result 的 `role=user` 不触发 Judge；
5. Claude Tool Result +真实 Human Text 正确拆分并触发一次 Judge；
6. “继续”触发新 Evaluation，且 Context 包含原 Task、Plan、最近 Tool 和当前 Profile；
7. Codex 实际 `update_plan` 触发 Planning Evaluation；
8. Claude Plan-only 触发 Planning Evaluation；
9. PlanFinished 无新约束时不再次 Judge；
10. Provider 503 与 Retry 不触发 Judge；
11. 相同 Trigger Event 经 New API Retry 只生成一个逻辑 Evaluation；
12. Judge 输出非法 JSON 时进入 Fallback；
13. Judge 不输出具体模型，Route Decision 由独立模块完成；
14. Judge 成本、Token、延迟和状态均进入账本；
15. 硬兼容变化只重筛候选，不重新 Judge。

## 21. 待审阅参数

以下属于可配置参数，不阻断本文结构审阅：

- `acu-auto` 基础质量偏好；
- `acu-high` 基础质量偏好；
- Planning 临时覆盖 88 是否在 Alpha 保持不变；
- Judge 默认超时；
- Judge 最大上下文 Token；
- Rules Fallback 后的保守 Profile；
- 六因子权重与 Difficulty Index 版本。
