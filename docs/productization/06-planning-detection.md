# ACU Router Planning 识别策略

> 状态：产品设计初稿，待创始人审阅  
> 版本：v0.1  
> 日期：2026-07-29  
> 依赖：`02-native-protocol-observations.md`、`04-session-task-routing-segment-state-machine-v2.md`、`04a-alpha-state-machine-implementation-profile.md`、`05-judge-and-trigger-policy.md`

## 1. 文档目的

本文定义：

1. 如何从原生 Codex / Claude Code 协议中识别 Planning；
2. 哪些信号可以创建 `PlanStarted` / `PlanFinished`；
3. Planning 如何影响 Routing Segment、Judge 和质量目标；
4. 如何避免把普通分析、Read / Search 或自然语言中的“计划”误判为 Planning；
5. 五日 Alpha 的 P0、P1 和延期边界。

本文只定义 Planning 识别和状态影响，不定义模型曲线、Provider 恢复或数据库表结构。

## 2. 核心原则

### 2.1 只使用高置信度协议事实

五日 Alpha 只根据已经实测的强信号识别 Planning，不使用自然语言猜测。

以下现象单独出现时都不是强信号：

- Prompt 中出现“plan”“规划”“先想一下”；
- Model Response 给出编号步骤；
- 连续 Read / Search；
- 请求中声明存在 Plan Tool；
- 任务看起来复杂；
- Reasoning Token 较多。

### 2.2 Planning 是阶段，不是永久难度

Planning 期间使用：

```text
temporary_phase_override = 88
```

它提高全局理解、架构一致性和长程推理要求，但不永久提高 `capability_escalation_floor`。

Planning 结束后撤销临时覆盖，恢复：

```text
effective_quality_target = max(
  task_base_quality_target,
  capability_escalation_floor
)
```

### 2.3 Planning 产生 Segment 边界

```text
Execution / Recovery Segment
→ PlanStarted
→ Planning Segment
→ PlanFinished
→ Execution Segment
```

Planning 内部的普通 Plan 更新不反复创建 Segment，也不反复调用 Judge。

### 2.4 不改写原生客户端行为

ACU 只观察和记录原生协议，不：

- 注入 Plan Tool；
- 修改 Tool Schema；
- 强迫客户端进入 Plan Mode；
- 修改用户 Prompt；
- 把自然语言计划转换成客户端内部 Plan；
- 改写 Streaming 或 Tool ID。

## 3. 标准 Planning 事件

### 3.1 PlanStarted

表示出现高置信度 Planning 开始或 Replanning 证据。

事件至少记录：

- 客户端和版本；
- 协议；
- Signal Family；
- 原始请求 / Tool Evidence 引用；
- Plan ID 或可推导关联 ID；
- 是否为 Replanning；
- 当前 Task / Segment；
- Event Hash；
- 发生时间。

### 3.2 PlanUpdated

表示当前活动 Plan 的结构化状态发生变化，但 Planning 阶段没有改变。

P0 中：

- 记录 Plan 状态；
- 更新活动时间；
- 不创建新 Segment；
- 不重新 Judge；
- 不再次叠加临时覆盖。

### 3.3 PlanFinished

表示 Planning 已高置信度完成并转入执行。

动作：

- 结束 Planning Segment；
- 创建 Execution Segment；
- 清除 Planning 临时覆盖；
- 默认继承最近有效 Evaluation；
- 仅在 Plan 暴露重大新范围、约束或能力需求时重新 Judge。

## 4. Codex Planning 信号

基于 Codex 0.145.0 的协议侦察结果。

### 4.1 强开始信号

```text
实际调用 update_plan
```

仅 Tool Schema 中声明 `update_plan` 不构成 PlanStarted。必须观察到实际 Tool Call。

第一次实际调用：

- 创建 `PlanStarted`；
- 结束当前 Segment；
- 创建 Planning Segment；
- 调用 Judge；
- 应用 `temporary_phase_override = 88`。

### 4.2 PlanUpdated

后续实际 `update_plan` 调用若只是更新同一个活动 Plan：

- 生成 `PlanUpdated`；
- 不创建新 Segment；
- 不重新 Judge。

应至少保存：

- Plan 项目；
- 每项状态；
- 新增、删除和变更项；
- Plan Hash；
- 与前一版本的差异。

### 4.3 Replanning

满足以下条件之一，可产生新的 `PlanStarted(reason=replanning)`：

- 原 Plan 已完成或已退出，随后重新实际调用 `update_plan` 建立新 Plan；
- Recovery / Blocked 阶段实际调用 `update_plan` 重建方案；
- Plan 结构发生重大重建，而非普通状态更新。

P0 只要求识别“Recovery 后重新实际调用 `update_plan`”这一高精度场景；复杂 Plan 重建判断列入 P1。

### 4.4 强结束组合

Codex 没有单一稳定的 Plan Finished 字段。P0 使用组合信号：

1. 当前 Plan 的所有必要项目进入完成状态；
2. 随后出现执行转移证据，例如实际 Edit / Write / Patch / Test / Build Tool Call；
3. 未同时出现新的 Plan 重建。

仅计划项全部完成但没有执行转移，不立即创建 PlanFinished，避免在总结或等待用户确认时过早退出 Planning。

### 4.5 自主 Planning 无强信号

实测中，复杂任务可能进行大量内部规划但不调用 `update_plan`。

P0 策略：

- 不推断 PlanStarted；
- 保持当前 Execution / Unknown 阶段；
- 不施加 88 临时覆盖；
- 不因漏识别而阻断请求。

这属于可接受的 P0 假阴性，优先避免高成本假阳性。

## 5. Claude Code Planning 信号

基于 Claude Code 2.1.220 的协议侦察结果。

### 5.1 强开始信号：Plan-only 指纹

Claude Code Plan Mode 通过版本化的 System Prompt / Tool Set 组合形成强信号。

识别必须：

- 绑定客户端版本；
- 使用结构化指纹，而不是完整 Prompt 字符串硬编码；
- 同时检查 Tool 集限制和关键 System 片段；
- 记录 Fingerprint Version。

命中后：

- 创建 PlanStarted；
- 创建 Planning Segment；
- 调用 Judge；
- 应用 88 临时覆盖。

### 5.2 Plan-only 指纹建议组成

P0 指纹至少包含：

- 客户端标识和版本；
- Plan Mode 特征 System 片段 Hash；
- Edit / Write 类 Tool 是否被限制；
- `ExitPlanMode` 是否存在；
- Tool Schema 指纹；
- 其他已实测稳定字段。

单个 Header、单个 Prompt 片段或单个 Tool 名不能独立构成强信号。

### 5.3 强结束信号

```text
实际调用 ExitPlanMode
```

实际调用后：

- 创建 PlanFinished；
- 结束 Planning Segment；
- 创建 Execution Segment；
- 撤销 88 临时覆盖；
- 默认复用最近 Evaluation。

### 5.4 执行确认组合

以下组合用于确认已经进入执行，但不替代 `ExitPlanMode` 作为主要结束信号：

- Plan-only Tool 限制消失；
- Edit / Write / Patch Tool 恢复；
- 修改类 Tool 被实际调用。

如果 `ExitPlanMode` 已发生，但执行工具暂未调用，仍可进入 Execution Segment；执行确认组合只提高置信度。

### 5.5 Replanning

Claude P1 可在以下场景创建 `PlanStarted(reason=replanning)`：

- 已进入 Execution / Recovery 后再次命中 Plan-only 指纹；
- Blocked 后重新进入 Plan Mode；
- 用户拒绝原方案后客户端再次进入 Plan Mode。

P0 只要求识别“执行阶段后再次命中版本化 Plan-only 指纹”。

## 6. Signal Registry

Planning 信号必须配置化和版本化，不写死在散落的业务代码中。

建议维护：

```text
planning_signal_registry
- client
- client_version_range
- protocol
- signal_family
- fingerprint_version
- start_matcher
- update_matcher
- finish_matcher
- confidence
- enabled
- last_verified_at
- fixture_ids
```

升级 Codex 或 Claude Code 后，先重跑对应 Fixture，再启用新版本规则。

无法识别客户端版本时：

- 不应用版本专属强规则；
- 可以记录候选 Evidence；
- 不自动产生 PlanStarted / PlanFinished。

## 7. Plan 数据最小结构

P0 建议保存：

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

Plan Item 只保存协议中真实可见的结构，不要求 ACU 自行生成语义计划。

## 8. 与 Judge 的关系

### 8.1 PlanStarted

必须重新 Judge。JudgeContextEnvelope 包含：

- Task 根目标；
- 当前完整原生上下文；
- 当前 Plan；
- Planning Trigger Evidence；
- 上次 Evaluation 与 Route；
- 当前 Profile；
- `temporary_phase_override = 88`。

### 8.2 PlanUpdated

不重新 Judge。更新 Plan Evidence，继续使用当前 Planning Segment 的 Evaluation 和 Route。

### 8.3 PlanFinished

默认不重新 Judge，只创建 Execution Segment并撤销临时覆盖。

仅以下情况重新 Judge：

- Plan 显著扩大文件、模块、系统或步骤范围；
- 新增关键业务、格式、安全或验证约束；
- 新增原 Profile 不具备的 Tool、协议、上下文或模态要求；
- Plan 明确否定此前能力假设；
- 同时出现新 HumanMessage。

P0 中“重大变化”只使用确定性结构差异和硬能力变化，不使用额外 LLM 判断。

## 9. 误判处理

### 9.1 假阳性优先避免

错误进入 Planning 会：

- 多调用一次 Judge；
- 提高质量目标和成本；
- 不必要地切换模型；
- 制造错误 Segment 边界。

因此 P0 只接受高置信度强信号。

### 9.2 假阴性可容忍

自主内部 Planning 没有强信号时，继续沿用当前 Route。该情况应记录为 `planning_candidate` Evidence，供后续离线分析，不影响在线状态。

### 9.3 信号冲突

开始和结束信号冲突时：

- 优先保留当前稳定状态；
- 不在同一原始事件中反复开关 Planning；
- 记录冲突 Evidence；
- P0 不调用额外 LLM 仲裁。

## 10. P0 实施范围

五日内必须实现：

1. Codex 实际 `update_plan` → PlanStarted；
2. Codex 同 Plan 后续更新 → PlanUpdated；
3. Codex Plan 完成 +执行转移 → PlanFinished；
4. Claude 2.1.220 Plan-only 指纹 → PlanStarted；
5. Claude 实际 `ExitPlanMode` → PlanFinished；
6. PlanStarted 创建 Planning Segment并重新 Judge；
7. Planning 使用 88 临时覆盖；
8. PlanUpdated 不重新 Judge；
9. PlanFinished 创建 Execution Segment，默认复用 Evaluation；
10. Planning Signal Registry 最小版本化配置；
11. 原生请求、Streaming、Tool ID 和 Tool Schema 不被改写；
12. 所有 Planning Event 可追溯到 Fixture 和原始 Evidence。

## 11. P1 实施范围

- Recovery / Blocked 后 Replanning；
- Codex Plan 重大重建识别；
- PlanFinished 后重大范围变化规则；
- 更多 Codex / Claude Code 版本；
- Planning 冲突告警；
- 管理员查看 Plan Revision 与 Signal Evidence；
- Planning 规则线上命中率和成本统计。

## 12. 延期项

- 自然语言 Planning 分类器；
- 基于 Read / Search 比例的弱识别；
- 基于 Reasoning Token 的 Planning 推断；
- LLM 判断 Plan 开始 / 结束；
- 自动改写或合并客户端 Plan；
- 多 Agent / Subagent 独立 Plan 状态；
- 用户可见的 Plan 编辑器；
- 数据驱动 Planning 模型。

## 13. P0 验收场景

1. Codex 仅声明 `update_plan` Tool 时不产生 PlanStarted；
2. Codex 实际调用 `update_plan` 时恰好产生一次 PlanStarted和一次 Judge；
3. 同一 Plan 的状态更新不创建新 Segment、不重新 Judge；
4. Codex Plan 全部完成但尚未执行时不提前 PlanFinished；
5. Codex 出现执行转移后创建 Execution Segment；
6. Claude 2.1.220 Plan-only 指纹产生 PlanStarted；
7. Claude 普通模式不因单个 Prompt 片段误判 Planning；
8. Claude 实际 `ExitPlanMode` 产生 PlanFinished；
9. PlanStarted 的有效质量目标至少为 88；
10. PlanFinished 撤销临时覆盖且默认不重新 Judge；
11. Plan 内部更新和普通 Read / Search 不额外调用 Judge；
12. 未知客户端版本不应用版本专属强规则；
13. Planning Event 均可追溯到原生 Evidence 与 Fixture；
14. ACU 不修改原生 Tool ID、Tool Schema、Streaming 或响应正文。
