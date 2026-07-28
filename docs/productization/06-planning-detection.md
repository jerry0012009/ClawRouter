# ACU Router Planning 识别策略

> 状态：产品设计基线，P0 规则已确认  
> 版本：v0.4  
> 日期：2026-07-29  
> 依赖：`02-native-protocol-observations.md`、`04-session-task-routing-segment-state-machine-v2.md`、`04a-alpha-state-machine-implementation-profile.md`、`05-judge-and-trigger-policy.md`

## 1. 文档目的

本文定义 `PlanStarted`、`PlanUpdated`、`PlanFinished` 的识别，以及 Planning 对 Segment、Judge 和 ACU 连续价值公式的影响。

## 2. 核心原则

### 2.1 P0 只使用实测强信号

以下现象单独出现时不是强信号：Prompt 出现“plan”、自然语言编号步骤、连续 Read / Search、Tool Schema 声明 Plan Tool、任务看起来复杂或 Reasoning Token 较多。

### 2.2 Planning 是阶段，不是永久难度

Planning 期间：

```text
temporary_phase_override = 88
```

88 是路由公式的质量偏好锚点。它会提高质量权重、风险权重和质量效用曲线的陡峭程度，但不是“预测分低于 88 就淘汰”的硬线。

Planning 结束后撤销该锚点，并通过 PlanFinished Judge 评估 Execution Segment。

### 2.3 Planning 产生两个 Judge 边界

```text
Execution / Recovery
→ PlanStarted
→ Planning Segment + Judge
→ PlanFinished
→ Execution Segment + Judge
```

PlanUpdated 不反复创建 Segment，也不反复 Judge。

### 2.4 不改写客户端

ACU 不注入 Plan Tool、不修改 Tool Schema、不强迫客户端进入 Plan Mode、不修改 Prompt，也不改写 Streaming 或 Tool ID。

## 3. 客户端支持范围

P0 正式规则仅覆盖通过 Fixture 验证的 Codex 0.145.0 与 Claude Code 2.1.220 兼容版本。

OpenClaw、Hermes 和其他 Agent 尚未完成 Planning 侦察，不得复用 Codex / Claude 指纹。未知 Agent 由 Judge 陈旧预算提供兜底。

## 4. 标准事件

### PlanStarted

记录客户端、版本、协议、Signal Family、Fingerprint Version、原始证据、Plan ID / Hash、Task / Segment、Event Hash 和时间。

动作：创建 Planning Segment、重新 Judge、设置 88 偏好锚点。

### PlanUpdated

同一活动 Plan 的结构化变化：更新 Plan 和活动时间，不创建 Segment、不重新 Judge、不重复叠加覆盖。

### PlanFinished

高置信度完成并转入执行：结束 Planning Segment、创建 Execution Segment、清除 88、重新 Judge，并重新运行连续价值公式。

PlanFinished 必须幂等，历史重发不得重复 Event 或 Judge。

## 5. Codex Planning

### 5.1 PlanStarted

强信号是实际调用 `update_plan`。仅 Tool Schema 声明不构成开始。

### 5.2 PlanUpdated

后续 `update_plan` 若只是更新同一活动 Plan，只保存 Plan 项、状态、版本、Hash 和结构差异，不创建 Segment、不 Judge。

### 5.3 Replanning

P0 识别 Execution / Recovery 后再次实际调用 `update_plan` 重建方案，标记 `reason=replanning`。

### 5.4 PlanFinished

```text
Plan 必要项全部完成
+ 随后首次实际 Edit / Write / Patch / Test / Build Tool Call
+ 没有新的 Plan 重建
→ PlanFinished
```

普通 Read / Search 不算执行转移；事件只生成一次。

### 5.5 自主 Planning 无强信号

复杂任务可能不调用 `update_plan`。P0 不猜测 Planning、不施加 88、不阻断请求。16 个 accepted Model Response 的陈旧预算为长自治任务提供兜底。

## 6. Claude Code Planning

### 6.1 PlanStarted

使用版本化 Plan-only 指纹，组合客户端版本、Plan Mode System 特征、Tool Set 限制、`ExitPlanMode` Tool、Tool Schema 指纹及对应 Fixture。不能只匹配单个 Header、Prompt 片段或 Tool 名。

### 6.2 PlanFinished

强信号是实际调用 `ExitPlanMode`。动作：创建 PlanFinished、Execution Segment、撤销 88 并重新 Judge。

Edit / Write / Patch Tool 恢复并实际调用，只作为执行确认，不替代 `ExitPlanMode`。

### 6.3 Replanning

P0 识别已经进入 Execution / Recovery 后，再次命中版本门控 Plan-only 指纹。

## 7. Planning Signal Registry

所有规则配置化和版本化：

```text
client
client_version_range
protocol
signal_family
fingerprint_version
start_matcher
update_matcher
finish_matcher
confidence
enabled
last_verified_at
fixture_ids
```

客户端升级后先重跑 Fixture。无法识别版本时只记录候选 Evidence，不自动产生 Planning Event。

## 8. Plan 数据最小结构

P0 保存 `plan_id`、`task_id`、客户端、版本、Signal Family、状态、Revision、协议中真实可见的 Plan Items、Plan Hash 和时间字段。ACU 不自行生成或改写 Plan。

## 9. PlanFinished Judge

上下文必须包含 Task 根目标、完成后的 Plan、原生上下文、Planning 阶段进展、当前 Profile、质量偏好参数和执行硬要求。

Judge 的问题是：

> 依据已经形成的具体计划，执行阶段的能力分布、风险和不确定性是什么？

随后 Route Decision Engine 使用新的 Evaluation 与撤销 88 后的目标锚点重新计算 `valueUtility`。不是简单沿用 Planning Route，也不是寻找“是否有模型超过 88”。

## 10. 误判策略

P0 优先避免假阳性。假阴性由 HumanMessage、重复失败、16-response 陈旧预算和 P1 Shadow Judge 缓解。

## 11. P0 验收

1. Codex Tool Schema 声明不触发 Planning；
2. 实际 `update_plan` 触发一次 PlanStarted Judge；
3. 同一 Plan 更新不重复 Judge；
4. Codex 组合信号只生成一次 PlanFinished；
5. Claude Plan-only 指纹触发 PlanStarted；
6. 实际 `ExitPlanMode` 触发 PlanFinished；
7. PlanFinished 创建 Execution Segment并重新 Judge；
8. 88 仅作为连续公式偏好锚点；
9. 历史重放不重复事件；
10. 未识别 Planning 不阻断请求。

## 12. P1 与延期

P1：OpenClaw / Hermes 侦察、复杂 Plan 重建、跨版本兼容、Shadow Judge 和管理端信号审计。

延期：弱 Planning 分类器、自然语言 Plan 推断、多 Agent / Subagent Planning、Learned Trigger Model。
