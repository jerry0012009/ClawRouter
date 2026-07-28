# ACU Router 状态机 v2：Session / Task / Routing Segment / Step

> 状态：基于原生协议实测的产品设计基线  
> 版本：v2.2  
> 日期：2026-07-29  
> 依据：`02-native-protocol-observations.md`、`03-system-architecture.md`  
> 实施裁剪：`04a-alpha-state-machine-implementation-profile.md`

## 1. 文档目的

本文定义 ACU Router 的长期状态语义：原生请求如何归入 Session / Task，哪些工作共享一次 Judge Evaluation 与 Route Decision，以及 HumanMessage、Planning、Failure、Provider Error 和 Retry 如何改变状态。

本文不是五日开发任务书。五日 Alpha 仅实现 `04a` 的 P0。

## 2. 实测事实基础

1. Codex 0.145.0 通过增长的 Responses Item 历史维持连续性，不依赖 `previous_response_id`。
2. Codex 使用 `function_call.call_id` 与 `function_call_output.call_id` 关联 Tool Call / Result。
3. Claude Code 2.1.220 通过增长的 Messages 历史与 `tool_use.id` / `tool_result.tool_use_id` 维持连续性。
4. Claude `tool_result` 位于 `role=user`，同一内容还可能混合真实 Human Text。
5. Codex 实际 `update_plan`、Claude Plan-only 指纹与实际 `ExitPlanMode` 是 Planning 强信号。
6. New API 会删除 Claude Session Header，因此 Header 不能作为全链路唯一主键。
7. Retry 可在客户端和 New API 多层发生，一个逻辑模型动作可能产生多个 Provider Attempt。

因此不得假设：

```text
HTTP Request = Human Turn = Step = Provider Attempt
```

## 3. 领域层级

```text
Conversation Session
└── Task / Goal
    ├── Human Turn（观察边界）
    └── Routing Segment（路由边界）
        └── Step（Agent行动循环）
            ├── Model Response
            ├── Tool Call / Tool Result
            └── Attempt / Retry Attempt
```

### 3.1 Session

可被连续性证据关联的一段持续对话。Session 可以跨客户端进程、Continue / Resume、工作目录变化和较长时间间隔。

Session 不设置固定时间身份过期。`last_activity_at` 只用于审计、运营和 Routing Lease，不决定 Session 失效。

### 3.2 Task / Goal

Session 中语义连续的用户目标。一个 Task 可包含多个 Human Turn、Segment、Step，以及 Planning、Execution、Recovery 等阶段。

### 3.3 Human Turn

从已确认的 HumanMessage 开始，到下一个 HumanMessage 或 Task 结束之前的 Agent 工作区间。Turn 不是模型锁定边界。

### 3.4 Routing Segment

Task 内共享同一 Judge Evaluation、质量偏好快照和默认 Execution Profile 的连续工作片段。Segment 是 ACU 的核心路由单位。

### 3.5 Step

一次逻辑 Model Response，加上该 Response 发出的 Tool Call 和相应 Tool Result。无 Tool Call 的终局 Model Response 也构成 Step。Step 不绑定单个 HTTP Request。

### 3.6 Attempt

一次实际 Provider 调用。Retry 只增加 Attempt，不创建新的 Task、Turn、Segment、Step 或 Judge Evaluation。

## 4. 系统不变量

1. 一个 Task 同一时刻最多只有一个活动 Segment。
2. Segment 保存不可变的 Evaluation、Route Decision、路由参数版本和首选 Execution Profile。
3. 普通 Tool 循环和 Agent 自动继续默认复用当前 Segment。
4. 同一 Segment 不因成本、一次成功或普通进展自动换模型。
5. 实际模型需要改变时创建新 Segment；同模型等价 Channel 的 Attempt 切换不必创建新 Segment。
6. ToolResult 不等于 HumanMessage，即使协议 Role 是 `user`。
7. ProviderError 不等于模型能力不足。
8. 新的高置信度 HumanMessage默认创建新 Segment并重新 Judge，但不默认创建新 Task。
9. Resume 不默认创建新 Task；Routing Lease 过期时不得静默复用旧 Segment。
10. 无法高置信度证明连续性时，宁可创建新 Session / Task并重新 Judge。
11. 显式模型不运行 Judge、不替换模型，但仍记录完整状态和账本。

## 5. Session 连续性

### 强信号

1. 可信入口身份相同，且原生历史构成精确增长前缀；
2. Tool Call / Result ID 因果关系连续；
3. 经版本门控验证的 Thread / Session Header 与历史前缀一致；
4. 显式 Resume 重建出一致历史。

### 中等信号

- 较长规范化历史前缀一致；
- Task 根目标、System / Developer 指纹和 Tool Schema 指纹一致；
- 客户端项目范围与最近轨迹一致。

### 弱信号

仅同一用户、工作目录、时间相近、模型列表或单个 Claude Session Header，均不能单独合并 Session。

### 长期 Resume

强连续性成立时保留原 Session / Task。若旧 Segment 的 10 分钟 Lease 已过期，则创建 `resume` Segment并重新 Judge。证据冲突时创建新 Session / Task。

## 6. Task 边界

“继续”“执行吧”、补充约束、重做、不满意、Plan / Execution / Repair 推进及高置信度 Resume，通常延续当前 Task。

仅在新 Session、明确 Reset / New Goal、目标明显替换或连续性无法确认时创建新 Task。第一阶段不训练独立 Task 切分模型。

## 7. Routing Segment

主要创建原因：

- `task_start`；
- `human_message`；
- `planning_start`；
- `planning_end`；
- `capability_recovery`；
- `safety_refresh`；
- `lease_expired` / `resume`；
- `availability_recovery`；
- `compatibility_recovery`。

### 10 分钟 Routing Lease

只在下一次可处理请求到达时惰性检查。过期后保留 Session / Task，关闭旧 Segment并对自动路由重新 Judge。

## 8. 标准事件与状态影响

### HumanMessage

Codex 从新增人类 Message 提取；Claude 必须先剥离 `tool_result`。高置信度 HumanMessage 创建 Human Turn、新 Segment并重新 Judge。

### ToolCall / ToolResult

按 Call ID 关联当前 Step。正常 Tool 循环不创建 Segment、不重新 Judge。失败 ToolResult 可额外产生 ExecutionFailure。

### PlanStarted

Codex 实际 `update_plan` 或 Claude 版本化 Plan-only 指纹。创建 Planning Segment、重新 Judge，并设置 Planning 偏好锚点 88。

### PlanFinished

Claude 实际 `ExitPlanMode`；Codex 为 Plan 必要项完成后首次实际 Edit / Write / Patch / Test / Build，且无 Plan 重建。创建 Execution Segment、撤销 Planning 锚点并重新 Judge。

### ExecutionFailure

第一次确定性失败只记录 Evidence。相同核心 Failure Signature 第二次出现且无进展时，创建 capability recovery Segment、重新 Judge，Route 只允许保持或升级。Provider、协议、权限、依赖和环境错误不进入该计数。

### ProviderError / RetryAttempt

ProviderError 只增加失败 Attempt和可用性恢复，不改变任务难度。RetryAttempt 不创建新的逻辑对象。

### Safety Refresh

当一个 Segment 自上次 Judge 后已接受的逻辑 Model Response 达到配置预算时，创建 `safety_refresh` Segment并重新 Judge，防止未知 Agent 长期复用陈旧 Evaluation。

## 9. Judge 触发矩阵

| 事件 | Judge | 新 Segment |
|---|---:|---:|
| 新自动路由 Task | 是 | 是 |
| 高置信度 HumanMessage | 是 | 是 |
| PlanStarted | 是 | 是 |
| PlanFinished | 是 | 是 |
| 相同核心失败第二次且无进展 | 是 | 是 |
| Judge 陈旧预算耗尽 | 是 | 是 |
| 普通 ToolCall / ToolResult | 否 | 否 |
| ProviderError / Retry | 否 | 否 |
| 硬兼容变化 | 否 | 必要时是 |
| P1 Lease / Resume | 是 | 是 |

## 10. 质量偏好语义

Task / Segment 计算：

```text
effective_quality_target = max(
  task_base_quality_target,
  capability_escalation_floor,
  temporary_phase_override
)
```

该数值是**连续价值公式的质量偏好锚点**，不是“模型预测分必须高于该线”的硬过滤条件。

- `task_base_quality_target`：自动路由模式的基础质量偏好；
- `capability_escalation_floor`：能力阻塞后，对后续目标偏好的最低值；
- `temporary_phase_override`：Planning 等阶段的临时目标偏好；Planning P0 为 88。

即使所有模型的预测分都低于 88，系统仍在硬兼容候选的 Pareto 前沿上比较质量、风险与成本，不返回“没有模型达线”；即使所有模型都高于 88，也仍保留成本效用。具体公式以 `08` 和当前 `src/acu/decision.ts` 为准。

同一 Segment 内不自动降级。新 Segment 可以因偏好锚点变化选择不同 Profile；重复能力失败形成的 recovery Segment 只允许保持或升级。

## 11. 显式模型模式

用户指定具体模型时不运行 Judge、不替换模型，P0 不自动跨 Channel Failover；仍记录 Session、Task、Segment、Step、Attempt、Usage、成本和错误。

## 12. Alpha 边界

长期规范允许扩展更精确 Task 切分、完整 Step 生命周期、弱 Planning、高级 Failure、多 Agent、Completed 置信度及数据驱动模型。五日 Alpha 以 `04a` 为准。

## 13. 验收问题

1. Claude `role=user` 是否先拆 ToolResult 再识别人类输入？
2. 历史重发是否只识别新增 Step / Event？
3. 多层 Retry 是否只增加 Attempt？
4. “继续”是否读取完整 Task并重新 Judge？
5. PlanStarted 与 PlanFinished 是否分别形成 Judge 边界？
6. 相同核心失败第二次无进展是否触发重评估？
7. Provider 503 是否不改变 Difficulty？
8. Session 是否不因固定时间失效？
9. 88 是否作为公式偏好锚点，而不是硬达标线？
10. 长自治任务是否由陈旧预算保证有界重评估？
