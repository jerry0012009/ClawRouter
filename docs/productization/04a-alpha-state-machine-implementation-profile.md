# ACU Router 五日 Alpha 状态机实施剖面

> 状态：五日 Alpha 开发约束  
> 版本：v0.4  
> 日期：2026-07-29  
> 上位规范：`04-session-task-routing-segment-state-machine-v2.md`  
> 适用范围：3—10 名邀请制 OPC 程序员，原生 Codex / Claude Code，经 New API 接入 ACU

## 1. 文档目的

`04` 是长期产品语义规范；本文只定义五日 Alpha 必须落地的最小闭环。

发生冲突时：

- 产品语义以 `04 v2.1` 为准；
- 五日开发范围以本文 P0 为准；
- P1 和延期项不得伪装成已实现能力。

## 2. 五日 Alpha 核心目标

```text
原生 Codex / Claude Code
→ New API 鉴权与余额
→ ACU 识别 Session / Task / Segment
→ 必要时运行 Judge
→ 选择并锁定 Execution Profile
→ 透明转发 Streaming / Tool / Thinking
→ 记录 Attempt、实际模型、Usage 和成本
→ 普通后续 Step 复用当前 Route
→ 在明确状态变化或陈旧预算耗尽时重新评估
```

Alpha 只证明任务级路由闭环，不建设完整自治工作流引擎。

## 3. 客户端支持边界

### 3.1 P0 正式支持

- Codex：原生 `/v1/responses`；
- Claude Code：原生 `/v1/messages`。

两者已经完成协议侦察、Fixture、Planning、Tool、Retry 与 Resume 实测。

### 3.2 OpenClaw、Hermes 与未知 Agent

标准 OpenAI-compatible / Anthropic-compatible 入口可保留，显式模型透传可以实验性使用，但 P0 不对外宣称其已支持 ACU 任务级自动路由。

未验证内容包括：

- Session / Task 连续性；
- HumanMessage 与 ToolResult 边界；
- Planning 强信号；
- Retry、Tool ID、Streaming、Usage 与实际模型；
- Segment 复用。

P0 完成后再进行最小协议侦察和 Adapter 验收。不得为了扩大客户端数量影响 Codex / Claude Code 五日闭环。

## 4. P0 最小领域对象

### 4.1 Session

保存：

- `session_id`；
- 用户 / API Key；
- 客户端与协议；
- 规范化历史链 Hash；
- 最近 Tool Call ID；
- `last_activity_at`；
- 当前 `task_id`、`segment_id`。

约束：

- Session 不设置固定身份过期；
- 强历史前缀、Tool ID 因果关系或可信 Resume 成立时，可长期恢复；
- 工作目录、时间相近或单个 Session Header 不能单独作为主键；
- 连续性不确定时创建新 Session并重新 Judge。

### 4.2 Task

Alpha 简化为一个 Session 同时只有一个活动 Task。

保存：

- `task_id`、`session_id`；
- 初始目标；
- 当前阶段；
- 基础质量偏好；
- 能力升级下限；
- 创建与更新时间。

“继续”“补充约束”“重做”“还是不行”默认延续当前 Task。明确 New Goal / Reset、明显目标替换或连续性无法确认时创建新 Task。

### 4.3 Routing Segment

保存：

- `segment_id`、`task_id`；
- 创建原因和阶段；
- Judge Evaluation、Route Decision；
- 锁定的 Execution Profile；
- 基础质量、能力下限、临时覆盖快照；
- `last_activity_at`；
- `accepted_model_responses_since_judge`；
- 状态。

约束：

- 同一 Task 只允许一个活动 Segment；
- 普通 Tool 循环复用当前 Segment；
- 同一 Segment 不因成本或一次成功自动换模型；
- 同模型等价 Channel 的 Attempt 变化不创建新 Segment；
- 实际模型必须变化时创建新 Segment。

### 4.4 Event

P0 稳定产生：

1. `human_message`；
2. `tool_call`；
3. `tool_result`；
4. `plan_started`；
5. `plan_finished`；
6. `execution_failure`；
7. `provider_error`。

每个 Event 保存类型、归属对象、原始证据引用、Tool / Call ID、Event Hash、重复标记、证据强度和时间。

### 4.5 Attempt

每次实际上游调用单独记录 Provider、Channel、请求模型、实际模型、上游 Request ID、状态、Usage、成本、错误类别、Retry Owner、开始与结束时间。

Client、New API 或 Provider Retry 只能新增 Attempt，不得重复创建 Judge、Segment 或逻辑计费结果。

### 4.6 Step

P0 不实现完整 Step 状态机，只要求：

- 接受的 Model Response 可生成 `step_id`；
- Tool Call ID 关联 Tool Result；
- 历史重发不重复创建 Step；
- Retry 不创建新 Step。

## 5. P0 必须支持的原生协议

### 5.1 Codex Responses

- `/v1/responses`；
- 增长的 Responses Item 历史；
- `function_call.call_id`；
- `function_call_output.call_id`；
- Streaming、Usage；
- 实际 `update_plan`。

不依赖 `previous_response_id`。

### 5.2 Claude Messages

- `/v1/messages`；
- 增长的 Messages 历史；
- `tool_use.id`；
- `tool_result.tool_use_id`；
- Thinking / Signature 透明转发；
- Streaming、Usage；
- 版本门控 Plan-only 指纹；
- 实际 `ExitPlanMode`。

必须先从 `role=user` 拆出 `tool_result`，再判断剩余 Text 是否为 HumanMessage。

## 6. P0 Judge 触发器

P0 不是每个请求都 Judge，也不是只有用户发消息才 Judge。必须实现六类触发器：

1. 新 `acu-auto` / `acu-high` Task 首次请求；
2. 所有高置信度 `human_message`；
3. `plan_started`；
4. `plan_finished`；
5. 同一标准化核心 Failure Signature 第二次出现且中间无明确进展；
6. Segment 的 Judge 陈旧预算耗尽。

### 6.1 Judge 陈旧预算

为兼容不可预期的 Agent 行为，P0 增加客户端无关的兜底：

```text
accepted_model_responses_since_judge >= max_unjudged_model_responses
→ 创建 safety_refresh Segment
→ 重新 Judge
```

默认：

```text
max_unjudged_model_responses = 8
```

该值必须可配置。它按被接受的逻辑 Model Response 计数，不按 HTTP Attempt、Streaming Event 或历史重发计数。

作用：即使没有新 HumanMessage、没有显式 Planning、也没有重复错误，长自治任务也不会永久复用最初 Evaluation。

### 6.2 重复失败

第一次失败只记录 Evidence。第二次相同核心失败且无进展时：

- 创建 `capability_recovery` Segment；
- 重新 Judge；
- 新 Route 只允许保持或升级；
- Provider、协议、权限、依赖和环境错误不得使用此触发器。

### 6.3 P0 不触发 Judge

- 普通 Model Response；
- Agent 自动继续；
- 普通 ToolCall；
- 成功 ToolResult；
- 第一次 ExecutionFailure；
- Failure Signature 改变或有明确进展；
- Provider 429、5xx、Timeout、Overload；
- Retry Attempt；
- Plan 内部更新；
- 单纯硬兼容变化。

硬兼容变化只使用最近 Evaluation 重筛候选；若实际模型必须变化，创建 `compatibility_recovery` Segment。

## 7. P0 Planning 边界

### 7.1 Planning 开始

强信号：

- Codex 实际调用 `update_plan`；
- Claude 命中版本门控 Plan-only 指纹。

动作：创建 Planning Segment、重新 Judge、设置 `temporary_phase_override = 88`。

### 7.2 Planning 结束

强信号：

- Claude 实际调用 `ExitPlanMode`；
- Codex Plan 必要项完成，随后首次出现实际 Edit / Write / Patch / Test / Build，且没有新 Plan 重建。

动作：

- 创建 Execution Segment；
- 撤销 Planning 临时覆盖；
- **重新 Judge**，读取已完成 Plan 和执行要求；
- 允许在新 Segment 中保持、升级或降至不低于基础质量与能力下限的 Profile。

PlanFinished Judge 使用幂等键，历史重发不得重复调用。

P0 不使用自然语言中的“计划”、Read / Search 比例或 Reasoning Token 作为强信号。

## 8. P1

- 10 分钟 Routing Segment Lease；
- 长期 Resume 后的 Lease 重评估；
- 上下文增长阈值 Trigger；
- 低比例 Shadow Judge 审计未触发请求；
- OpenClaw / Hermes 协议侦察；
- 同模型等价 Channel 恢复；
- 管理员轨迹查询；
- 更完整 Step 状态。

Shadow Judge 仅用于评估 Trigger 漏判，不改变线上 Route，不向用户计费。

## 9. 延期项

- 独立 Task 切分模型；
- Learned Trigger Model；
- Embedding Session 匹配；
- 弱 Planning 推断；
- 高级 Failure 分类；
- 多 Agent / Subagent 状态；
- Completed 置信度；
- 自动 Context Compaction；
- 用户连续质量分；
- 9B Router 训练。

未来 Learned Trigger Model 用于提高兼容性与召回率，但不能取代新 Task、HumanMessage、Planning、重复失败和陈旧预算等确定性安全触发器。

## 10. P0 最小验收

1. 显式模型 Judge 调用数为 0；
2. 新 `acu-auto` Task 恰好 Judge 一次；
3. 普通 Tool 循环复用当前 Segment；
4. Claude ToolResult 不误触发 HumanMessage；
5. “继续”触发一次完整上下文 Judge；
6. PlanStarted 触发 Planning Judge；
7. PlanFinished 触发 Execution Judge；
8. 相同核心错误第二次无进展触发一次 Judge；
9. 连续 8 个被接受 Model Response 且无其他 Trigger 时触发 safety refresh；
10. Retry 只增加 Attempt；
11. Streaming、Thinking、Tool ID 不被改写；
12. 实际模型、Channel、Usage、成本可关联；
13. ProviderError 不改变任务难度；
14. 同一 Trigger 重放不重复 Judge。

## 11. 后续文档约束

`05`—`11` 必须明确区分 Alpha P0、P1、延期项和验收场景。正式开工前，再将 P0 映射为五日执行计划、代码模块、依赖和每日验收产物。
