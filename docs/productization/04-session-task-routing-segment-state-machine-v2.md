# ACU Router 状态机 v2：Session / Task / Routing Segment / Step

> 状态：基于原生协议实测的产品设计基线  
> 版本：v2.1  
> 日期：2026-07-29  
> 依据：`02-native-protocol-observations.md`、`03-system-architecture.md`  
> 实施裁剪：`04a-alpha-state-machine-implementation-profile.md`  
> 取代关系：本文取代旧 `04-session-task-routing-segment-state-machine.md`；旧文件仅保留为历史记录

## 1. 文档目的

本文定义 ACU Router 的长期状态语义，回答：

1. 原生 Codex / Claude Code 请求如何归入同一 Session 与 Task；
2. 哪些连续工作共享一次 Judge Evaluation 和 Route Decision；
3. HumanMessage、Tool、Planning、Failure、Provider Error 与 Retry 如何改变状态；
4. 何时保持当前模型，何时创建新 Routing Segment，何时重新 Judge。

本文不是五日开发任务书。五日 Alpha 只实现 `04a` 中标记为 P0 的部分。

## 2. 实测事实基础

以下事实已经由 `02` 的真实 Fixture 验证，并作为状态机约束：

1. Codex 0.145.0 通过重发并增长 Responses Item 历史维持连续性，不能依赖 `previous_response_id`。
2. Codex 使用 `function_call.call_id` 与 `function_call_output.call_id` 关联 Tool Call / Result。
3. Claude Code 2.1.220 通过增长的 Messages 历史以及 `tool_use.id` / `tool_result.tool_use_id` 维持连续性。
4. Claude `tool_result` 位于 `role=user`，且同一 `role=user` 内容可能同时包含 Tool Result 与 Text。
5. Codex 实际调用 `update_plan` 是 Planning 强信号；仅声明该 Tool 不是强信号。
6. Claude Plan-only 指纹与实际 `ExitPlanMode` 是 Planning 强信号。
7. New API 会删除 Claude Session Header，因此 Header 不能作为全链路唯一主键。
8. Retry 可在客户端和 New API 多层发生，一个逻辑模型动作可能产生多个 Provider Attempt。

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

### 3.1 Conversation Session

原生客户端中可被连续性证据关联的一段持续对话。一个 Session 可以跨客户端进程、Continue / Resume、工作目录变化和较长时间间隔。

**Session 不设置固定时间身份过期规则。**

只要强连续性证据成立，原 Session 和 Task 可以长期恢复。`last_activity_at` 仅用于审计、运营和 Routing Lease 计算，不决定 Session 身份失效。

### 3.2 Task / Goal

Session 中语义连续的用户目标，例如“修复登录 Bug”。一个 Task 可包含多个 Human Turn、多个 Segment、多个 Step，以及 Planning、Execution、Recovery 等阶段。

### 3.3 Human Turn

从一个已确认的 HumanMessage 开始，到下一个 HumanMessage 或 Task 结束之前的 Agent 工作区间。

Turn 用于理解人机交互，不是模型锁定边界。Agent 自动循环不会自动创建 Human Turn。

### 3.4 Routing Segment

Task 内共享同一难度认知、质量策略快照和默认 Execution Profile 的连续工作片段。Routing Segment 是 ACU 的核心路由单位。

### 3.5 Step

一个语义完整的 Agent 行动循环：一次逻辑 Model Response，加上该 Response 发出的 Tool Call，以及相应 Tool Result。没有 Tool Call 的终局 Model Response 也构成一个 Step。

Step 不绑定单个 HTTP Request。

### 3.6 Attempt

一次实际 Provider 调用。客户端 Retry、New API Retry、ACU Retry 或 Provider SDK Retry 可以使同一个 Step 产生多个 Attempt。

Retry 只增加 Attempt，不创建新的 Task、Turn、Segment、Step 或 Judge Evaluation。

## 4. 系统不变量

1. 一个 Task 同一时刻最多只有一个活动 Routing Segment。
2. Segment 保存不可变的 Judge Evaluation 引用、质量策略快照和首选 Execution Profile。
3. 普通 Tool 循环和 Agent 自动继续默认复用当前 Segment。
4. 同一 Segment 内不因成本、一次成功或普通进展自动降级。
5. 实际模型需要改变时，应结束旧 Segment并创建新 Segment；同模型等价 Channel 的 Attempt 切换不必创建新 Segment。
6. ToolResult 不等于 HumanMessage，即使协议 Role 是 `user`。
7. ProviderError 不等于模型能力不足。
8. 新的高置信度 HumanMessage 默认创建新 Segment并重新 Judge，但不默认创建新 Task。
9. Resume 不默认创建新 Task；Routing Lease 已过期时不得静默复用旧 Segment。
10. 无法高置信度证明连续性时，宁可创建新 Session / Task并重新 Judge，不错误继承旧的低质量 Route。
11. 用户显式指定模型时不运行 Judge、不替换模型，但仍记录 Session、Task、Segment、Step、Attempt、Usage 和错误。

## 5. Session 连续性

### 5.1 强信号

按组合证据判断，优先级如下：

1. 可信入口身份相同，且原生历史构成精确增长前缀；
2. Tool Call 与 Tool Result 的 ID 因果关系连续；
3. 经客户端版本门控验证的 Thread / Session Header，与历史前缀一致；
4. 显式 Resume 重建出与已知 Session 一致的历史。

### 5.2 中等信号

- 较长规范化历史前缀一致；
- Task 根目标、System / Developer 指纹和 Tool Schema 指纹一致；
- 客户端项目范围与最近轨迹一致。

### 5.3 弱信号

以下信号不能单独合并 Session：

- 仅同一用户或 API Key；
- 仅工作目录相同；
- 仅时间相近；
- 仅模型或 Tool 列表相同；
- 仅 Claude Session Header。

### 5.4 长期 Resume

若强连续性证据成立：

- 保留原 Session；
- 保留原 Task 历史和能力升级下限；
- 不因客户端重启、工作目录变化或长时间间隔创建新 Session；
- 检查当前 Routing Segment 的 10 分钟 Lease。

若 Segment Lease 已过期：

- 旧 Segment 标记 `lease_expired`；
- 创建 `resume` Segment；
- 重新构造 JudgeContextEnvelope；
- 对 `acu-auto` / `acu-high` 重新 Judge。

若只有弱证据或历史冲突：

- 不合并旧 Session；
- 创建新 Session / Task；
- 旧历史只作为弱 Evidence，不作为身份事实。

## 6. Task 边界

### 6.1 默认延续同一 Task

以下输入通常延续当前 Task：

- “继续”“执行吧”；
- 补充约束；
- 要求重做；
- 明确不满意；
- Plan、Execution、Test、Repair 的正常推进；
- 中断后的高置信度 Resume。

### 6.2 创建新 Task

仅在高置信度情况下创建：

- 新 Session；
- 客户端明确 Reset / New Goal；
- HumanMessage 明确替换原目标；
- 新项目目标与原任务明显无关；
- 连续性无法确认，按安全规则拆分。

第一阶段不训练独立 Task 切分模型。

## 7. Routing Segment

### 7.1 创建原因

主要 Segment 边界：

- `task_start`；
- `human_message`；
- `planning_start`；
- `planning_end`；
- `first_failure_recovery`；
- `capability_block`；
- `lease_expired`；
- `resume`；
- `availability_recovery`；
- `compatibility_recovery`。

### 7.2 10 分钟 Routing Lease

Routing Segment 默认 Lease：

```text
10 分钟
```

可归属到当前 Segment 的以下活动更新 `last_activity_at`：

- 模型请求或有效 Streaming；
- 被接受的 Model Response；
- ToolCall；
- ToolResult；
- 当前 Task 的 HumanMessage。

系统不运行后台定时 Judge。仅在下一次可处理请求到达时惰性检查：

```text
now - segment.last_activity_at > 10 分钟
```

若过期：

- Session 和 Task 保留；
- 旧 Segment 标记 `lease_expired`；
- 创建新 Segment；
- `acu-auto` / `acu-high` 重新 Judge。

### 7.3 Segment 内模型锁定

同一 Segment 内：

- 普通 Step 复用首选 Execution Profile；
- ToolCall、正常 ToolResult、普通 Model Response 不重新选模型；
- 第一次 ExecutionFailure 不自动升级；
- Provider Retry 可产生多个 Attempt；
- 可切换同模型、等价能力配置的健康 Channel。

如果必须改变实际模型：

- 结束当前 Segment；
- 创建新的 recovery / availability / compatibility Segment；
- 保留最近有效 Judge Evaluation，除非同时存在 Judge 触发器。

硬兼容变化本身只重筛候选，不自动改变任务难度，也不必重新 Judge。

## 8. 标准事件

协议 Normalizer 从原生请求、响应和历史增量中产生标准事件。

### 8.1 HumanMessage

高置信度确认的人类新输入。

- Codex：增长历史中新增的人类 Message，不是 `function_call_output`；
- Claude：先从 `role=user` 内容中拆出 `tool_result`，剩余 Text 经来源规则确认后才标记 HumanMessage。

状态影响：

- 创建 Human Turn；
- 判断新 Task或延续 Task；
- 结束旧 Segment；
- 创建新 Segment；
- `acu-auto` / `acu-high` 重新 Judge。

### 8.2 ToolCall

- Codex 关联键：`call_id`；
- Claude 关联键：`tool_use.id`。

正常 ToolCall 归入当前 Step，不创建 Segment，不重新 Judge。

### 8.3 ToolResult

- Codex 关联键：`function_call_output.call_id`；
- Claude 关联键：`tool_result.tool_use_id`。

正常 ToolResult 推进或闭合 Step，不创建 Human Turn。确定性失败结果可额外产生 ExecutionFailure。

### 8.4 PlanStarted

强信号：

- Codex 实际调用 `update_plan` 创建或重建计划；
- Claude 命中经版本门控验证的 Plan-only 指纹；
- Recovery 中再次出现实际 Plan Tool，表示 Replanning。

动作：

- 创建 Planning Segment；
- 重新 Judge；
- 施加 Planning 临时质量覆盖，第一阶段暂定 88。

仅出现单词 plan、Read / Search 较多或 Tool Schema 声明，不构成强信号。

### 8.5 PlanFinished

强信号：

- Claude 实际 `ExitPlanMode`；
- Codex Plan 完成，并出现执行转移证据；
- Plan-only Tool 集退出，修改工具恢复并实际调用。

动作：

- 结束 Planning Segment；
- 创建 Execution Segment；
- 撤销 Planning 临时覆盖；
- 默认复用最近 Judge Evaluation；
- 仅当 Plan 暴露重大新范围、约束或能力需求时重新 Judge。

### 8.6 ExecutionFailure

执行、验证或 Tool 结果显示当前动作未达到目标。

处理原则：

1. 第一次确定性失败：创建 Recovery Segment，继承原 Evaluation 和模型，不重新 Judge；
2. Failure Signature 变化或有明确进展：继续 Recovery，不重新 Judge；
3. 相同核心失败第二次出现且无进展：形成 capability block，创建新 Segment并重新 Judge；
4. 环境错误可阻塞任务，但不提高模型能力下限；
5. Provider / 协议错误不归入能力失败。

### 8.7 UserRejected

HumanMessage 明确否定结果或要求重做，例如“还是不行”“理解错了”。

动作：

- 默认保持同一 Task；
- 创建 rejection-recovery Segment；
- 重新 Judge；
- 临时提高需求重读、验证和风险规避权重；
- 不因单次拒绝直接永久提高能力下限。

### 8.8 ProviderError

429、5xx、Timeout、Overload 或网络错误。

动作：

- 记录失败 Attempt；
- 不改变任务难度；
- 不重新 Judge；
- 不计入能力失败；
- 可重试同一 Profile或切换同模型等价 Channel；
- 无可用候选时返回错误。

### 8.9 RetryAttempt

同一逻辑模型动作因错误恢复产生的新增 Provider Attempt。

- Retry Owner 可为 Client、New API、ACU 或 Provider SDK；
- 不创建新 Step、Segment、Task 或 Judge；
- Client Request ID 不能直接作为唯一幂等键；
- 每个实际上游调用都必须独立记录 Usage、成本和错误。

## 9. Judge触发矩阵

| 事件 | 重新 Judge | 新 Segment | 说明 |
|---|---:|---:|---|
| 新 `acu-auto` / `acu-high` Task | 是 | 是 | 首次评估 |
| 高置信度 HumanMessage | 是 | 是 | 包括“继续”、补充约束与拒绝 |
| PlanStarted / Replanning | 是 | 是 | Planning 临时覆盖 |
| PlanFinished，无新能力需求 | 否 | 是 | 复用 Evaluation，撤销临时覆盖 |
| 第一次 ExecutionFailure | 否 | 是 | Recovery，保持模型 |
| 相同失败第二次且无进展 | 是 | 是 | 只允许保持或升级 |
| ProviderError / RetryAttempt | 否 | 否 | 只增加 Attempt |
| 硬兼容变化 | 否 | 必要时是 | 使用现有 Evaluation 重筛候选 |
| 10 分钟 Segment Lease 过期 | 是 | 是 | Session / Task 保留 |
| 长期 Resume，Lease 已过期 | 是 | 是 | 强连续性证据关联原 Session |
| 普通 ToolCall / ToolResult | 否 | 否 | 复用当前 Route |

## 10. 质量策略

Task 维护：

```text
effective_quality_target = max(
  task_base_quality_target,
  capability_escalation_floor,
  temporary_phase_override
)
```

- `task_base_quality_target`：`acu-auto` / `acu-high` 的基础偏好；
- `capability_escalation_floor`：高置信度能力阻塞形成的 Task 内下限；
- `temporary_phase_override`：Planning、Recovery、UserRejected 等阶段性覆盖。

同一 Segment 内不自动降级。只有创建新 Segment 时，才可以撤销临时覆盖或根据新 Evaluation 选择较低 Profile，且不得低于：

```text
max(task_base_quality_target, capability_escalation_floor)
```

Provider Error、成本压力、一次成功 ToolResult 均不能单独触发降级。

## 11. 显式模型模式

用户指定具体模型时：

- 不运行 Judge；
- 不替换模型；
- 第一阶段不自动跨渠道切换；
- 仍识别并保存 Session、Task、Segment、Step、Attempt；
- 仍记录完整 Usage、成本、Tool 轨迹和错误；
- HumanMessage、Failure、ProviderError 可形成 Evidence，但不改变指定模型。

## 12. 长期规范与 Alpha 实施边界

长期规范允许逐步扩展：

- 更精确的 Task 切分；
- 完整 Step 生命周期；
- 弱 Planning 信号；
- 高级 Failure 分类；
- 多 Agent / Subagent 状态；
- Completed 置信度；
- 数据驱动的 Q-Context / Q-Difficulty。

五日 Alpha 不要求一次实现以上能力。实际开发范围以 `04a` 的 P0 / P1 划分为准。

## 13. 状态机验收问题

1. Codex 不使用 `previous_response_id` 时，是否仍可通过历史前缀和 Call ID 关联 Session？
2. Claude `role=user` 同时含 ToolResult 与 Text 时，是否先拆分再判断 HumanMessage？
3. 历史重发时，是否只识别新增 Step和Event？
4. 多层 Retry 是否只增加 Attempt，不重复 Judge和Segment？
5. “继续”是否延续 Task、新建 Segment，并用完整上下文重新 Judge？
6. PlanStarted 与 PlanFinished 是否形成清晰 Segment 边界？
7. 第一次失败是否进入 Recovery而不自动升级？
8. 重复无进展是否重新 Judge并禁止降级？
9. Provider 503 是否不改变任务难度？
10. Session 是否不因固定时间自动失效？
11. Segment 是否只使用 10 分钟 Routing Lease？
12. 长期 Resume 是否保留原 Session / Task，但在 Lease 过期时新建 Segment并重新 Judge？
13. 同一 Segment 是否永不因成本或一次成功自动降级？

上述问题均可由协议 Event、状态和路由规则确定性回答时，本文通过设计验收。
