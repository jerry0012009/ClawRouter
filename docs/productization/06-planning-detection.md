# ACU Router Planning 识别策略

> 状态：产品设计基线，P0 规则已确认  
> 版本：v0.3  
> 日期：2026-07-29  
> 依赖：`02-native-protocol-observations.md`、`04-session-task-routing-segment-state-machine-v2.md`、`04a-alpha-state-machine-implementation-profile.md`、`05-judge-and-trigger-policy.md`

## 1. 文档目的

本文定义：

1. 如何识别 `PlanStarted`、`PlanUpdated`、`PlanFinished`；
2. Planning 如何影响 Segment、Judge 和质量目标；
3. 如何避免把普通分析误判为 Planning；
4. 五日 Alpha 的 P0、P1 与延期边界。

## 2. 核心原则

### 2.1 P0 只使用实测强信号

以下现象单独出现时不是强信号：

- Prompt 中出现“plan”“规划”；
- Model Response 给出编号步骤；
- 连续 Read / Search；
- 请求声明存在 Plan Tool；
- 任务看起来复杂；
- Reasoning Token 较多。

### 2.2 Planning 是阶段，不是永久难度

Planning 期间：

```text
temporary_phase_override = 88
```

Planning 结束后撤销该覆盖，再由 PlanFinished Judge 评估 Execution Segment 所需能力。

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

P0 正式规则仅覆盖：

- Codex 0.145.0 及通过 Fixture 验证的兼容版本；
- Claude Code 2.1.220 及通过 Fixture 验证的兼容版本。

OpenClaw、Hermes 和其他 Agent 尚未完成 Planning 侦察。即使传输层可用，也不得复用 Codex / Claude 指纹或宣称已支持阶段识别。

未知 Agent 不识别 Planning 时，由 `05` 的 Judge 陈旧预算提供兜底；P1 再补协议侦察和专用 Signal Family。

## 4. 标准事件

### 4.1 PlanStarted

记录客户端、版本、协议、Signal Family、Fingerprint Version、原始证据、Plan ID / Hash、是否 Replanning、Task / Segment、Event Hash 和时间。

动作：

- 结束当前 Segment；
- 创建 Planning Segment；
- 重新 Judge；
- 应用 88 临时覆盖。

### 4.2 PlanUpdated

同一活动 Plan 的结构化变化：

- 更新 Plan 和活动时间；
- 不创建 Segment；
- 不重新 Judge；
- 不重复叠加覆盖。

### 4.3 PlanFinished

高置信度完成并转入执行：

- 结束 Planning Segment；
- 创建 Execution Segment；
- 清除 88 覆盖；
- **重新 Judge**；
- Judge 读取完成后的 Plan、Task、验证要求和当前 Profile；
- 新 Route 可保持、升级或降至不低于基础质量与能力下限的 Profile。

PlanFinished 必须幂等，历史重发不得重复生成 Event 或 Judge。

## 5. Codex Planning

### 5.1 PlanStarted

强信号：

```text
实际调用 update_plan
```

仅 Tool Schema 声明 `update_plan` 不构成 PlanStarted。

### 5.2 PlanUpdated

后续 `update_plan` 若只是更新同一活动 Plan：

- 生成 PlanUpdated；
- 不创建 Segment；
- 不重新 Judge；
- 保存 Plan 项、状态、版本、Plan Hash 和结构差异。

### 5.3 Replanning

P0 识别高精度场景：Execution / Recovery 后再次实际调用 `update_plan` 重建方案。

动作与 PlanStarted 相同，标记 `reason=replanning`。

### 5.4 PlanFinished：确认规则

```text
Plan 必要项全部完成
+ 随后首次实际 Edit / Write / Patch / Test / Build Tool Call
+ 没有新的 Plan 重建
→ PlanFinished
```

边界：

- Plan 项完成但没有执行转移，不结束 Planning；
- 普通 Read / Search 不算执行转移；
- 首次修改或验证行为只生成一次 Event；
- 历史重发不得重复生成。

### 5.5 自主 Planning 无强信号

复杂任务可能不调用 `update_plan`。P0 不猜测 Planning、不施加 88 覆盖、不阻断请求。Judge 陈旧预算确保长自治任务最终仍会重新评估。

## 6. Claude Code Planning

### 6.1 PlanStarted：版本化 Plan-only 指纹

必须组合：

- 客户端标识和版本；
- Plan Mode System 特征；
- Tool Set 限制；
- `ExitPlanMode` Tool；
- Tool Schema 指纹；
- 对应 Fixture。

不能只匹配单个 Header、Prompt 片段或 Tool 名。

### 6.2 PlanFinished

强信号：

```text
实际调用 ExitPlanMode
```

动作：创建 PlanFinished、Execution Segment、撤销 88 覆盖并重新 Judge。

Edit / Write / Patch Tool 恢复并实际调用，只作为执行确认和 Evidence，不替代 `ExitPlanMode`。

### 6.3 Replanning

P0 识别：已经进入 Execution / Recovery 后，再次命中通过版本门控的 Plan-only 指纹。

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

客户端升级后先重跑 Fixture，再启用新规则。无法识别版本时，只记录候选 Evidence，不自动产生 Planning Event。

## 8. Plan 数据最小结构

P0 保存：

- `plan_id`、`task_id`；
- 客户端、版本、Signal Family；
- 状态和 Revision；
- 协议中真实可见的 Plan Items；
- Plan Hash；
- 开始、更新、完成时间。

ACU 不自行生成或改写客户端 Plan。

## 9. PlanFinished Judge 的上下文

必须包含：

- Task 根目标；
- 完成后的完整 Plan；
- 原生上下文；
- Planning 阶段进展和修改；
- 当前 Profile；
- 基础质量和能力下限；
- 执行所需 Tool、协议、上下文和验证条件。

PlanFinished Judge 的问题是：

> 依据已经形成的具体计划，执行阶段所需的最低充分能力是什么？

而不是简单撤销 88 后沿用 Planning Route。

## 10. 误判策略

P0 优先避免假阳性。假阴性由以下机制缓解：

- HumanMessage Trigger；
- 重复失败 Trigger；
- Judge 陈旧预算；
- P1 Shadow Judge 审计。

## 11. P0 验收

1. Codex Tool Schema 声明不触发 Planning；
2. 实际 `update_plan` 触发一次 PlanStarted Judge；
3. 同一 Plan 更新不重复 Judge；
4. Codex 组合信号只生成一次 PlanFinished；
5. Claude Plan-only 指纹触发一次 PlanStarted；
6. 实际 `ExitPlanMode` 触发一次 PlanFinished；
7. PlanFinished 创建 Execution Segment并重新 Judge；
8. 88 覆盖在 Planning 结束后清除；
9. 历史重放不重复生成 Event；
10. 未识别 Planning 不阻断请求。

## 12. P1 与延期

P1：OpenClaw / Hermes 侦察、复杂 Plan 重建、跨版本兼容、Shadow Judge、管理端信号审计。

延期：弱 Planning 分类器、自然语言 Plan 推断、多 Agent / Subagent Planning、Learned Trigger Model。
