# ACU Router Planning 识别策略

> 状态：产品设计基线，P0 规则已确认  
> 版本：v0.2  
> 日期：2026-07-29  
> 依赖：`02-native-protocol-observations.md`、`04-session-task-routing-segment-state-machine-v2.md`、`04a-alpha-state-machine-implementation-profile.md`、`05-judge-and-trigger-policy.md`

## 1. 文档目的

本文定义：

1. 如何从原生 Codex / Claude Code 协议识别 Planning；
2. 哪些信号产生 `PlanStarted`、`PlanUpdated`、`PlanFinished`；
3. Planning 如何影响 Segment、Judge 和质量目标；
4. 如何避免把普通分析或自然语言误判为 Planning；
5. 五日 Alpha 的 P0、P1 和延期边界。

本文不定义模型曲线、Provider 恢复或数据库表结构。

## 2. 核心原则

### 2.1 P0 只使用实测强信号

以下现象单独出现时不是 Planning 强信号：

- Prompt 中出现“plan”“规划”“先想一下”；
- Model Response 给出编号步骤；
- 连续 Read / Search；
- 请求中声明存在 Plan Tool；
- 任务看起来复杂；
- Reasoning Token 较多。

### 2.2 Planning 是阶段，不是永久难度

Planning 期间：

```text
temporary_phase_override = 88
```

Planning 结束后恢复：

```text
effective_quality_target = max(
  task_base_quality_target,
  capability_escalation_floor
)
```

Planning 不自动提高永久能力下限。

### 2.3 Planning 产生 Segment 边界

```text
Execution / Recovery Segment
→ PlanStarted
→ Planning Segment
→ PlanFinished
→ Execution Segment
```

Plan 内部更新不反复创建 Segment，也不反复 Judge。

### 2.4 不改写客户端

ACU 不注入 Plan Tool、不修改 Tool Schema、不强迫客户端进入 Plan Mode、不修改 Prompt，也不改写 Streaming 或 Tool ID。

## 3. 客户端支持范围

P0 Planning 识别仅对以下实测版本提供正式规则：

- Codex 0.145.0 及通过 Fixture 验证的兼容版本；
- Claude Code 2.1.220 及通过 Fixture 验证的兼容版本。

OpenClaw、Hermes 和其他 Agent 的 Planning 语义尚未侦察。即使传输层可以调用 New API，也不得复用 Codex / Claude 的 Planning 指纹或宣称已支持任务阶段识别。

## 4. 标准事件

### 4.1 PlanStarted

表示出现高置信度 Planning 开始或 Replanning 证据。

至少记录：

- 客户端、版本和协议；
- Signal Family 与 Fingerprint Version；
- 原始 Tool / Request Evidence；
- Plan ID 或关联 Hash；
- 是否为 Replanning；
- Task / Segment；
- Event Hash；
- 时间。

动作：

- 结束当前 Segment；
- 创建 Planning Segment；
- 重新 Judge；
- 应用 `temporary_phase_override = 88`。

### 4.2 PlanUpdated

同一个活动 Plan 的结构化状态变化：

- 更新 Plan 内容和活动时间；
- 不创建新 Segment；
- 不重新 Judge；
- 不重复叠加质量覆盖。

### 4.3 PlanFinished

高置信度 Planning 完成并转入执行：

- 结束 Planning Segment；
- 创建 Execution Segment；
- 清除 Planning 临时覆盖；
- 默认继承最近 Evaluation；
- 只有重大新范围、约束或硬能力需求才重新 Judge。

## 5. Codex Planning

### 5.1 强开始信号

```text
实际调用 update_plan
```

仅 Tool Schema 中声明 `update_plan` 不构成 PlanStarted。

第一次实际调用：

- 创建 PlanStarted；
- 创建 Planning Segment；
- 调用 Judge；
- 应用 88 覆盖。

### 5.2 PlanUpdated

后续 `update_plan` 若只是更新同一个活动 Plan：

- 生成 PlanUpdated；
- 不创建 Segment；
- 不重新 Judge。

保存 Plan 项目、状态、版本、Plan Hash 和结构差异。

### 5.3 Replanning

P0 只识别高精度场景：Execution / Recovery 后再次实际调用 `update_plan` 重建方案。

动作与 PlanStarted 相同，但标记 `reason=replanning`。

复杂 Plan 重建或自然语言重新规划列入 P1。

### 5.4 PlanFinished：P0 已确认规则

Codex 没有单一稳定的 Plan Finished 字段。P0 使用已经确认的组合信号：

```text
Plan 必要项全部完成
+ 随后首次实际 Edit / Write / Patch / Test / Build Tool Call
+ 没有新的 Plan 重建
→ PlanFinished
```

边界：

- Plan 项全部完成但没有执行转移，不立即结束 Planning；
- 普通 Read / Search 不视为执行转移；
- 首次修改或验证行为只生成一次 PlanFinished；
- 历史重发不得重复生成事件。

### 5.5 自主 Planning 无强信号

复杂任务可能在不调用 `update_plan` 的情况下进行内部规划。P0：

- 不猜测 PlanStarted；
- 保持当前 Execution / Unknown；
- 不施加 88 覆盖；
- 不阻断请求。

这是有意接受的假阴性，优先避免假阳性、额外 Judge 和无必要的成本上升。

## 6. Claude Code Planning

### 6.1 强开始信号：版本化 Plan-only 指纹

必须同时使用：

- 客户端标识和版本；
- Plan Mode System 特征；
- Tool Set 限制；
- `ExitPlanMode` Tool 存在；
- Tool Schema 指纹；
- 对应 Fixture。

不能只匹配单个 Header、Prompt 片段或 Tool 名。

命中后创建 PlanStarted、Planning Segment、Judge 和 88 覆盖。

### 6.2 强结束信号

```text
实际调用 ExitPlanMode
```

动作：

- 创建 PlanFinished；
- 结束 Planning Segment；
- 创建 Execution Segment；
- 撤销 88 覆盖；
- 默认复用最近 Evaluation。

Edit / Write / Patch Tool 恢复并实际调用只作为执行确认，不替代 `ExitPlanMode`。

### 6.3 Replanning

P0 识别：已经进入 Execution / Recovery 后，再次命中通过版本门控的 Plan-only 指纹。

复杂用户拒绝、子 Agent Planning 和跨版本信号列入 P1。

## 7. Planning Signal Registry

Planning 信号必须配置化和版本化：

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

客户端升级后先重跑 Fixture，再启用新版本规则。

无法识别客户端版本时：

- 不应用版本专属强规则；
- 只记录候选 Evidence；
- 不自动产生 PlanStarted / PlanFinished。

## 8. Plan 最小数据

P0 保存：

```json
{
  "plan_id": "plan_...",
  "task_id": "task_...",
  "source_client": "codex",
  "source_version": "0.145.0",
  "signal_family": "codex_update_plan",
  "status": "active",
  "revision": 1,
  "items": [],
  "plan_hash": "sha256...",
  "started_at": "ISO-8601",
  "updated_at": "ISO-8601",
  "finished_at": null
}
```

只保存协议中真实可见的 Plan，不由 ACU 自行生成语义计划。

## 9. 与 Judge 的关系

### PlanStarted

必须重新 Judge，并把 Task 根目标、原生上下文、当前 Plan、Trigger Evidence、上次 Evaluation / Route、当前 Profile 和 88 覆盖放入 JudgeContextEnvelope。

### PlanUpdated

不重新 Judge，复用当前 Planning Segment。

### PlanFinished

默认不重新 Judge。只有以下确定性变化才触发：

- Plan 显著扩大文件、模块或系统范围；
- 新增关键业务、格式、安全或验证约束；
- 新增原 Profile 不具备的 Tool、协议、上下文或模态要求；
- Plan 明确否定此前能力假设；
- 同时出现新 HumanMessage。

P0 不调用额外 LLM 判断“重大变化”。

## 10. 误判策略

### 10.1 优先避免假阳性

错误进入 Planning 会增加 Judge 和高档模型成本，因此 P0 宁可漏识别隐式规划，也不根据弱信号自动切换。

### 10.2 去重

事件幂等键至少包含：

```text
client
+ signal_family
+ task_id
+ plan_hash / tool_call_id
+ normalized_history_hash
```

Client / New API Retry 和历史重发不得重复创建 Planning Segment或重复 Judge。

### 10.3 信号失效

版本不匹配、结构冲突或 Fixture 未验证时：

- 记录 `planning_signal_unknown`；
- 保持当前 Segment；
- 不应用 88 覆盖；
- 不阻断请求。

## 11. P0 实施范围

- Codex `update_plan` PlanStarted / PlanUpdated；
- Codex 已确认的 PlanFinished 组合；
- Claude Plan-only 指纹；
- Claude `ExitPlanMode`；
- Planning Segment 与 88 覆盖；
- PlanFinished 默认继承 Evaluation；
- Signal Registry 与版本门控；
- Event 去重；
- 原始 Evidence 和 Plan 数据持久化。

## 12. P1 与延期项

P1：

- 复杂 Plan 重建；
- 更细粒度重大范围判断；
- 更多 Codex / Claude 版本；
- OpenClaw / Hermes Planning 侦察和规则；
- 跨 Segment Plan 恢复；
- 子 Agent Planning。

延期：

- 自然语言 Planning 分类器；
- Read / Search 统计推断；
- Reasoning Token 推断；
- 独立 Planning 模型；
- ACU 自动生成或修改 Plan。

## 13. P0 验收

1. Codex Tool Schema 声明 `update_plan` 但未调用时不触发；
2. 第一次实际 `update_plan` 恰好触发一次 Judge；
3. 后续 PlanUpdated 不重复 Judge；
4. Plan 必要项完成但没有执行转移时仍保持 Planning；
5. Plan 完成后首次 Edit / Write / Patch / Test / Build 产生一次 PlanFinished；
6. Claude Plan-only 指纹触发一次 PlanStarted；
7. Claude 实际 `ExitPlanMode` 触发一次 PlanFinished；
8. PlanFinished 无重大变化时不重复 Judge；
9. Retry 和历史重发不重复事件；
10. 未知客户端版本不应用强规则；
11. Planning 期间质量覆盖为 88，结束后正确撤销；
12. ACU 不改写客户端请求、Streaming 或 Tool ID。
