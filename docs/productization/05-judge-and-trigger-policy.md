# ACU Router Judge 与触发策略

> 状态：产品设计基线，关键策略已确认  
> 版本：v0.2  
> 日期：2026-07-29  
> 依赖：`02-native-protocol-observations.md`、`04-session-task-routing-segment-state-machine-v2.md`、`04a-alpha-state-machine-implementation-profile.md`

## 1. 文档目的

本文定义：

1. 何时调用 Judge；
2. Judge 评估什么；
3. Judge 读取什么上下文；
4. Judge 输出什么；
5. 普通 Agent 循环如何复用 Evaluation；
6. Judge 失败时如何安全继续；
7. 五日 Alpha 的 P0、P1 与延期边界。

本文不负责具体模型选择公式和 Provider 恢复顺序，相关内容由 `08-routing-and-recovery-policy.md` 定义。

## 2. 核心原则

### 2.1 评估下一 Routing Segment

Judge 不回答“最新一句话难不难”，而回答：

> 基于完整 Task 目标、原生上下文、当前 Plan、执行进展、失败、用户反馈和现有 Profile，下一 Routing Segment 所需的最低充分能力与风险水平是什么？

“继续”“执行吧”“好的”等短输入必须与完整 Task 上下文一起评估。

### 2.2 Trigger Engine 与 Judge 分离

- Trigger Engine 使用确定性协议事件和状态规则，决定是否调用 Judge；
- Judge 只评估上下文和能力需求；
- Judge 不决定 Session、Task 或 Segment 身份；
- Judge 不调用 Provider、不直接选择模型、不修改状态。

### 2.3 Judge 不推荐具体模型

Judge 不输出：

- 模型名称；
- Provider / Channel；
- 价格；
- 节省率；
- 最终 Route Decision。

Route Decision Engine 根据 Evaluation、质量曲线、硬兼容、健康度和成本选择 Execution Profile。

### 2.4 原生上下文优先

JudgeContextEnvelope 以原生 Codex Responses 或 Claude Messages 为第一事实来源。第一阶段不使用本地模型或额外 LLM 对上下文做摘要替换。

### 2.5 一个 Segment 默认只 Judge 一次

Segment 创建时产生或继承 Judge Evaluation。普通 Model Response、ToolCall、ToolResult、Streaming 和 Retry 不重复 Judge。

### 2.6 显式模型完全跳过 Judge

用户指定具体模型时：

- Judge 调用数必须为 0；
- 不执行 ACU 模型选择；
- 不因 Planning、Failure 或 HumanMessage 自动替换模型；
- 仍记录完整状态、Attempt、Usage、成本和错误。

## 3. Judge 的逻辑职责

第一阶段由一个 LLM Judge 同时承担两个逻辑职责。

### 3.1 Q-Context

识别：

- Task 是否延续；
- 当前阶段：理解、Planning、Execution、Verification、Recovery 或 Unknown；
- 最新 HumanMessage 是继续、补充约束、拒绝、重做还是新目标；
- 最近 Tool、Test、Build 和错误表示进展、失败还是环境问题；
- 当前 Plan 是否暴露新的范围、约束或能力需求。

Q-Context 的输出是 Evaluation Evidence，不替代 Trigger Engine 的确定性身份判断。

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

未来可以拆分为独立模型，但不属于五日 Alpha。

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
→ 调用 Judge
→ 校验 Evaluation
→ Route Decision Engine 选择满足质量要求的最高性价比 Profile
```

### 4.3 acu-high

使用相同 Trigger 和 Judge，只提高基础质量偏好和不确定性惩罚。`acu-high` 不等于固定使用最贵模型，也不作为五日上线阻断项。

## 5. P0 Judge 触发器

五日 Alpha 只实现三类触发器。

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
- Claude 命中版本门控的 Plan-only 指纹；
- P1 中 Recovery 后出现强 Replanning 信号。

动作：

- 创建 Planning Segment；
- 调用 Judge；
- `temporary_phase_override = 88`；
- Route Decision Engine 重新选择适合 Planning 的 Profile。

## 6. P0 不触发 Judge

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
- 单纯协议、上下文、Tool 或模态硬兼容变化。

硬兼容变化只使用最近 Evaluation 重筛候选。若必须换模型，创建 compatibility-recovery Segment，但不重新解释任务难度。

## 7. P1 触发器

P0 全链路稳定后补充：

### 7.1 重复核心失败且无进展

同一标准化 Failure Signature 第二次出现，且错误和结果没有明确改善时：

- 创建 capability-block Segment；
- 重新 Judge；
- 只允许保持或升级；
- 由新 Evaluation 决定是否提高 `capability_escalation_floor`。

第一次失败不重新 Judge。

### 7.2 10 分钟 Routing Lease 过期

下一请求到达时惰性检查：

```text
now - segment.last_activity_at > 10 分钟
```

若过期，保留 Session / Task，创建新 Segment并重新 Judge。

### 7.3 长期 Resume

Session 不设置固定身份过期。强连续性证据成立时保留原 Session / Task；旧 Segment Lease 已过期时创建 resume Segment并重新 Judge。

## 8. Trigger Engine 输入

Trigger Engine 仅使用确定性事实：

- 协议和客户端版本；
- 原生请求及规范化历史增量；
- HumanMessage / ToolCall / ToolResult；
- Codex `update_plan`；
- Claude Plan-only 指纹与 `ExitPlanMode`；
- 当前 Session、Task、Segment；
- Failure Signature 与重复次数；
- 当前 Profile 的硬兼容状态；
- 是否为重试、重放或重复事件。

Trigger Engine 不调用额外 LLM、不使用 Embedding，也不根据单词匹配直接推断 Planning 或新 Task。

## 9. JudgeContextEnvelope

每次 Judge 请求包含两部分。

### 9.1 原生 API 上下文

尽可能保留：

- System / Developer / Instructions；
- Responses Input Items 或 Anthropic Messages；
- Tool Schema；
- Tool Call / Tool Result；
- 可见 Reasoning / Thinking；
- 最新 HumanMessage；
- 影响任务能力的请求参数。

### 9.2 ACU 确定性状态

从 PostgreSQL 和事件规则读取：

- Trigger Reason；
- Task 初始目标和当前阶段；
- 当前或最近活动 Plan；
- 上一次 Evaluation 和 Route Decision；
- 当前 Execution Profile；
- `task_base_quality_target`；
- `capability_escalation_floor`；
- `temporary_phase_override`；
- 最近 Tool / Test / Build 结果；
- Failure Signature 和重复次数；
- 用户拒绝、重试、成功和进展 Evidence；
- 当前上下文、Tool、模态和协议硬要求。

数据库随机 ID 只用于追踪，不应作为 Judge 推断难度的语义输入。

## 10. 上下文超限

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

优先删除：

- 完全重复的历史 Item；
- 重复 Tool Schema；
- 已完成且未被引用的大段 Read 输出；
- 重复错误正文，只保留一次正文和计数；
- 已被后续结果覆盖的中间输出。

每次裁剪记录内容 Hash、类型、Token 估计和删除原因。Judge 最大上下文可配置，并优先使用长上下文 Judge 模型。

## 11. Judge 输出契约

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
- `evidence_tags` 最多 8 个；
- `explanation` 简短、可审计，不输出思维过程；
- 不得输出具体模型、Provider 或价格。

后端以版本化公式计算 `factor_composite`、`difficulty_index`、主档位、不确定性惩罚和 Evaluation Hash。

## 12. Evaluation 复用与幂等

### 12.1 Segment 复用

没有新 Trigger 时，直接复用当前 Segment 的 Evaluation 和 Route Decision。

### 12.2 Judge 幂等键

```text
SHA256(
  policy_version
  + prompt_version
  + judge_model
  + trigger_event_id
  + context_hash
)
```

同一 Trigger Event 因 Client 或 New API Retry 重复送达时，只产生一个逻辑 Evaluation。

不得只依赖 `x-client-request-id`、New API Request ID 或 Provider Request ID。

### 12.3 Cache 边界

允许复用同一 Trigger Event 的网络重试、并发去重和完全相同的 Evaluation Key。

不得用旧 Cache 跳过新 HumanMessage、新 PlanStarted、P1 capability block 或 Lease 过期后的评估。

## 13. Judge 失败与安全降级

Judge 故障不能让所有 Coding Agent 请求直接不可用，也不能静默切到最顶尖、最昂贵的模型。

处理顺序：

1. **最近有效 Evaluation**：若当前 Task 连续，且本次 Trigger 不涉及明显新目标或重大范围变化，则带风险惩罚复用；
2. **Rules Strategy**：根据确定性任务特征、历史 Evaluation、Planning 状态和硬要求生成 fallback Evaluation；
3. **管理员配置的安全性价比 Profile**：前两项均不可用时，选择上下文容量足够、协议和 Tool 能力兼容、健康且价格合理的保守 Profile；
4. 记录 `judge_status`、错误类别、Fallback 来源、风险标记和实际成本；
5. 不选择低于基础质量下限或能力升级下限的模型。

### 13.1 安全性价比 Profile 选择规则

该 Profile 不是“质量最高模型”，而是“在安全下限之上最具性价比的可用模型”。候选必须同时满足：

- 原生协议兼容；
- Tool / Thinking / 模态能力兼容；
- 上下文容量覆盖当前请求和预期输出，并保留配置化安全余量；
- 当前 Channel 健康；
- 不低于管理员配置的安全质量下限；
- 在满足上述条件的候选中，优先预计总成本更低者。

Alpha 可将 **DeepSeek V4 Pro 级别的长上下文性价比模型** 配置为候选安全档，但不得把具体模型名写死在 Judge Prompt 或业务规则中。模型不可用或不兼容时，应从同一安全档候选组中选择其他 Profile。

若没有任何候选满足硬要求和安全质量下限，返回明确的“无安全可用 Profile”错误，不自动升级到最贵模型，也不静默降级到不合格模型。

用户显式指定模型时不受 Judge 故障影响。

具体候选排序、成本公式和配置字段由 `08` 定义。

## 14. 调用校验与账本

每次 Judge 调用至少校验：

- HTTP 成功；
- 严格 JSON 可解析；
- Schema Version 支持；
- 数值范围合法；
- 概率可归一化；
- 六项因子完整；
- Explanation 长度受限；
- 不包含模型推荐或非法字段。

损坏或部分结果不得直接使用，必须进入第 13 节 Fallback。

每次真实调用记录：

- Judge 模型和 Provider；
- Prompt / Policy Version；
- Trigger Reason；
- Context Hash；
- 输入、缓存、输出 Token；
- 延迟和实际成本；
- Usage 来源；
- Evaluation 状态；
- Cache Hit / Fallback；
- 每个真实 Attempt。

Alpha 按实际 Judge 成本 1.0 倍计入用户总成本。同一 Trigger Event 的重复传输不得重复创建逻辑费用；上游实际产生的多次计费 Attempt 必须分别入账。

## 15. P0 实施范围

五日内必须实现：

1. 显式模型跳过 Judge；
2. 新 Task 首次 Judge；
3. 所有高置信度 HumanMessage Judge；
4. PlanStarted Judge；
5. Segment 内 Evaluation 复用；
6. Codex / Claude 原生上下文解析；
7. ToolResult 与 HumanMessage 区分；
8. JudgeContextEnvelope；
9. 严格 JSON 校验；
10. Evaluation 幂等；
11. Rules Fallback；
12. 安全性价比 Profile Fallback；
13. Judge Token、成本和延迟记录。

## 16. P1 实施范围

- 重复 Failure Signature 后重新 Judge；
- 10 分钟 Routing Lease；
- 长期 Resume 后重新 Judge；
- UserRejected 的临时风险权重；
- 更完整的 Success / Progress Evidence；
- 管理员查看 Context 裁剪记录；
- Judge 模型健康度和自动切换。

## 17. 延期项

- 独立 Q-Context / Q-Difficulty 模型；
- 本地 Router 模型；
- Embedding Session 匹配；
- LLM 上下文摘要器；
- 弱 Planning 自动识别；
- 复杂 Failure 分类器；
- 用户连续质量分；
- 在线学习和自动更新 Prompt；
- 9B Router 训练。

## 18. P0 验收场景

1. 显式模型请求 Judge 调用数为 0；
2. 新 `acu-auto` Task 恰好调用一次 Judge；
3. 普通 Tool 循环不重复 Judge；
4. Claude 仅含 Tool Result 的 `role=user` 不触发 Judge；
5. Claude Tool Result + Human Text 正确拆分并触发一次 Judge；
6. “继续”触发新 Evaluation，Context 包含原 Task、Plan、最近 Tool 和当前 Profile；
7. Codex 实际 `update_plan` 触发 Planning Evaluation；
8. Claude Plan-only 触发 Planning Evaluation；
9. PlanFinished 无新需求时不再次 Judge；
10. Provider 503 和 Retry 不触发 Judge；
11. 同一 Trigger Event 经 New API Retry 只生成一个逻辑 Evaluation；
12. Judge 输出非法 JSON 时按既定顺序 Fallback；
13. Judge 故障且无可复用 Evaluation 时，选择上下文足够的安全性价比 Profile，而不是最顶尖模型；
14. 没有安全候选时返回明确错误；
15. Judge 不输出模型名称，Route Decision 由独立模块完成；
16. Judge Token、成本、延迟和 Attempt 可审计。
