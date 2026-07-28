# ACU Router 五日 Alpha 状态机实施剖面

> 状态：五日 Alpha 开发约束  
> 版本：v0.3  
> 日期：2026-07-29  
> 上位规范：`04-session-task-routing-segment-state-machine-v2.md`  
> 适用范围：3—10 名邀请制 OPC 程序员，原生 Codex / Claude Code，经 New API 接入 ACU

## 1. 文档目的

`04` 是长期产品语义规范；本文只定义五日开发必须落地的最小闭环。

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
→ 重复明确失败时触发一次安全重评估
```

Alpha 只证明任务级路由闭环，不建设完整自治工作流引擎。

## 3. 客户端支持边界

### 3.1 P0 正式支持

五日 Alpha 的正式验收客户端只有：

- Codex：原生 `/v1/responses`；
- Claude Code：原生 `/v1/messages`。

原因是两者已经完成协议侦察、Fixture 和 Planning / Tool / Resume 实测。

### 3.2 OpenClaw 与 Hermes

OpenClaw 官方支持 OpenAI-compatible 和 Anthropic-compatible Endpoint；Hermes Agent 官方支持 OpenAI-compatible `/v1/chat/completions` Endpoint。因此在传输层，它们有机会通过 New API 与 ACU 调用模型。

但以下能力尚未实测：

- Session 与 Task 连续性信号；
- HumanMessage 与 ToolResult 的边界；
- Planning 强信号；
- Retry 行为；
- Tool ID、Streaming、Usage 和实际模型字段；
- `acu-auto` 是否能稳定复用 Segment。

因此第一阶段口径为：

- 可以保留标准协议入口，避免主动阻断；
- 显式模型透传可作为实验性兼容；
- 不对外宣称 OpenClaw / Hermes 已支持 ACU 任务级自动路由；
- P0 完成后再做最小协议侦察和 Adapter 验收。

不得为了扩大客户端数量，影响 Codex / Claude Code 的五日闭环。

## 4. P0 最小领域对象

### 4.1 Session

必须保存：

- `session_id`；
- 用户 / API Key；
- 客户端与协议；
- 规范化历史链 Hash；
- 最近 Tool Call ID；
- `last_activity_at`；
- 当前 `task_id`；
- 当前 `segment_id`。

约束：

- Session 不设置固定身份过期时间；
- 强历史前缀、Tool ID 因果关系或可信 Resume 证据成立时，可长期关联原 Session；
- 工作目录、时间相近或单个 Session Header 不能单独作为主键；
- 连续性不确定时创建新 Session并重新 Judge。

### 4.2 Task

Alpha 简化为：一个 Session 同时只有一个活动 Task。

必须保存：

- `task_id`；
- `session_id`；
- 初始目标；
- 当前阶段；
- 基础质量偏好；
- 能力升级下限；
- 创建与更新时间。

“继续”“补充约束”“重做”“还是不行”默认延续当前 Task。只有明确 New Goal / Reset、明显目标替换或连续性无法确认时创建新 Task。

### 4.3 Routing Segment

必须保存：

- `segment_id`；
- `task_id`；
- 创建原因；
- 阶段：`execution / planning / capability_recovery / availability_recovery / compatibility_recovery`；
- Judge Evaluation 引用；
- Route Decision 引用；
- 锁定的 Execution Profile；
- 基础质量、能力下限、临时覆盖快照；
- `last_activity_at`；
- 状态。

约束：

- 同一 Task 只允许一个活动 Segment；
- 普通 Tool 循环复用当前 Segment；
- 同一 Segment 不因成本或一次成功自动换模型；
- 同模型等价 Channel 的 Attempt 变化不创建新 Segment；
- 实际模型必须变化时创建新 Segment。

### 4.4 Event

P0 稳定产生七类事件：

1. `human_message`；
2. `tool_call`；
3. `tool_result`；
4. `plan_started`；
5. `plan_finished`；
6. `execution_failure`；
7. `provider_error`。

每个 Event 至少保存类型、Session / Task / Segment、原始证据引用、Tool / Call ID、Event Hash、重复标记、证据强度和时间。

### 4.5 Attempt

每次实际上游调用必须单独记录：

- `attempt_id`；
- 逻辑请求关联；
- Provider / Channel；
- 请求模型与实际模型；
- 上游 Request ID；
- 状态；
- Usage 与成本；
- 错误类别；
- Retry Owner；
- 开始和结束时间。

Client、New API 或 Provider Retry 只能新增 Attempt，不得重复创建 Judge、Segment 或逻辑计费结果。

### 4.6 Step

P0 不实现完整 Step 状态机。只要求：

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
- Streaming；
- Usage；
- 实际 `update_plan`。

不依赖 `previous_response_id`。

### 5.2 Claude Messages

- `/v1/messages`；
- 增长的 Messages 历史；
- `tool_use.id`；
- `tool_result.tool_use_id`；
- Thinking / Signature 透明转发；
- Streaming；
- Usage；
- 版本门控 Plan-only 指纹；
- 实际 `ExitPlanMode`。

必须先从 `role=user` 内容中拆出 `tool_result`，再判断剩余 Text 是否为 HumanMessage。

## 6. P0 Judge 触发器

P0 不是“只有用户发消息才重新 Judge”。必须实现四类触发器：

1. 新 `acu-auto` / `acu-high` Task 首次请求；
2. 所有高置信度 `human_message`，包括“继续”、补充约束、拒绝和重做；
3. `plan_started`；
4. **同一 P0 标准化核心 Failure Signature 第二次出现，且中间没有明确进展。**

第四项是自治任务的安全触发器，避免客户端长时间没有新 HumanMessage 时永久复用错误 Route。

第一次失败只记录 Evidence，不重新 Judge。第二次相同核心失败且无进展时：

- 创建 `capability_recovery` Segment；
- 重新 Judge；
- 新 Route 只允许保持或升级；
- Provider、协议、权限、依赖和环境错误不得使用此触发器。

P0 不重新 Judge：

- 普通 Model Response；
- Agent 自动继续；
- 普通 ToolCall；
- 成功 ToolResult；
- 第一次 ExecutionFailure；
- Failure Signature 已变化或存在明确进展；
- Provider 429、5xx、Timeout、Overload；
- Retry Attempt；
- Plan 内部更新；
- PlanFinished 且没有新能力需求；
- 单纯硬兼容变化。

硬兼容变化只使用最近 Evaluation 重筛候选；若实际模型必须变化，创建 `compatibility_recovery` Segment。

## 7. P0 Planning 边界

### 7.1 Planning 开始

强信号：

- Codex 实际调用 `update_plan`；
- Claude 命中版本门控 Plan-only 指纹。

动作：

- 创建 Planning Segment；
- 重新 Judge；
- `temporary_phase_override = 88`。

### 7.2 Planning 结束

强信号：

- Claude 实际调用 `ExitPlanMode`；
- Codex Plan 必要项完成，随后首次出现实际 Edit / Write / Patch / Test / Build 行为，且没有新的 Plan 重建。

动作：

- 创建 Execution Segment；
- 撤销 Planning 临时覆盖；
- 默认复用最近 Evaluation；
- 只有出现重大新范围、约束或硬能力需求时才再次 Judge。

P0 不使用自然语言中的“计划”、Read / Search 比例或 Reasoning Token 作为强信号。

## 8. P1：首批用户期间补齐

- 10 分钟 Routing Segment Lease；
- 长期 Resume 后的 Route 重评估；
- 语义相近但文本不同的重复失败；
- 更完整的进展判断；
- 同模型等价 Channel 可用性恢复；
- 管理员轨迹查询；
- Step 的 `open / closed / cancelled / unresolved` 状态；
- OpenClaw / Hermes 最小协议侦察和客户端 Adapter Registry。

P1 仍不引入 Session 固定身份过期规则。

## 9. P2 / 延期项

- 独立 Task 语义切分模型；
- Embedding Session 匹配；
- 完整 Client Turn / Step 引擎；
- 弱信号 Planning；
- 高级 Failure 分类器；
- 修改—撤销振荡与虚构符号识别；
- Completed 置信度；
- 多 Agent / Subagent 专用状态；
- 自动 Context Compaction；
- 用户连续质量分；
- 显式模型自动替换；
- 因成本或一次成功自动降级；
- 9B Router 训练。

## 10. 五日 P0 实施优先级

1. Responses 与 Messages 原生入口；
2. Streaming、Thinking 和 Tool ID 透明转发；
3. 显式模型跳过 Judge；
4. `acu-auto` 首请求 Judge + Route；
5. 当前 Segment Route 复用；
6. HumanMessage 与 ToolResult 区分；
7. Planning 强信号；
8. P0 Failure Signature 与第二次无进展触发；
9. Attempt / Retry 独立记录；
10. PostgreSQL 最小持久化；
11. New API 鉴权身份与最终 Usage / 成本关联。

## 11. P0 最小验收场景

1. 显式模型请求 Judge 调用数为 0；
2. 新 `acu-auto` Task 恰好 Judge 一次；
3. 普通 Tool 循环复用当前 Segment；
4. Claude 仅含 Tool Result 的 `role=user` 不触发 Judge；
5. Claude Tool Result +真实 Text 正确拆分；
6. “继续”延续 Task、新建 Segment并重新 Judge；
7. Codex `update_plan` 创建 Planning Segment；
8. Claude Plan-only / `ExitPlanMode` 创建 Planning 与 Execution Segment；
9. Codex“Plan 完成 + 首次实际编辑/测试”创建 PlanFinished；
10. 第一次核心失败不重新 Judge；第二次相同核心失败且无进展时重新 Judge；
11. ProviderError 和 Retry 不触发 Judge；
12. Streaming、Thinking 和 Tool ID不被ACU改写；
13. 实际模型、渠道、Usage 和成本关联到同一逻辑请求；
14. 硬兼容变化不调用 Judge，只重筛候选。

## 12. 后续文档约束

`05`—`11` 必须明确区分：

- Alpha P0；
- Alpha P1；
- 延期项；
- 验收场景。

正式开工前，再把 P0 映射为五日执行计划、代码模块、依赖和每日验收产物。
