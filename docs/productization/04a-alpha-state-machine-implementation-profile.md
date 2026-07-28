# ACU Router 五日 Alpha 状态机实施剖面

> 状态：五日 Alpha 开发约束  
> 版本：v0.2  
> 日期：2026-07-29  
> 上位规范：`04-session-task-routing-segment-state-machine-v2.md`  
> 适用范围：3—10 名邀请制 OPC 程序员，原生 Codex / Claude Code，经 New API 接入 ACU

## 1. 文档目的

`04-session-task-routing-segment-state-machine-v2.md` 是长期产品语义规范，不代表五日 Alpha 必须一次实现全部状态和规则。

本文只定义五日开发必须落地的最小闭环。发生冲突时：

- 产品语义以 04 v2.1 为准；
- 五日开发范围以本文 P0 为准；
- P1 和延期项不得伪装成已实现能力。

## 2. 五日 Alpha 核心目标

```text
原生 Codex / Claude Code
→ New API 鉴权与余额
→ ACU 识别连续 Session / Task
→ 必要时运行 Judge
→ 选择并锁定 Execution Profile
→ 透明转发 Streaming / Tool
→ 记录 Attempt、实际模型、Usage 和成本
→ 普通后续 Step 复用当前 Route
```

Alpha 只证明任务级路由闭环，不建设完整自治工作流引擎。

## 3. P0 最小领域对象

### 3.1 Session

必须保存：

- `session_id`；
- 用户 / API Key；
- 客户端与协议；
- 规范化历史链 Hash；
- 最近 Tool Call ID；
- `last_activity_at`；
- 当前 `task_id`；
- 当前 `segment_id`。

实现约束：

- Session 不设置固定身份过期时间；
- 强历史前缀、Tool ID 因果关系或可信 Resume 证据成立时，可以长期关联原 Session；
- `last_activity_at` 不用于终止 Session；
- 不把工作目录或单个 Session Header 当作唯一主键；
- 连续性不确定时创建新 Session并重新 Judge。

### 3.2 Task

Alpha 简化为：一个 Session 同时只有一个活动 Task。

必须保存：

- `task_id`；
- `session_id`；
- 初始目标；
- 当前阶段；
- 基础质量偏好；
- 能力升级下限；
- 创建与更新时间。

仅在以下情况创建新 Task：

1. 新 Session；
2. 客户端明确 Reset / New Goal；
3. HumanMessage 明确替换原目标且置信度高；
4. 连续性无法确认。

“继续”“补充约束”“重做”“还是不行”默认延续当前 Task。

### 3.3 Routing Segment

必须保存：

- `segment_id`；
- `task_id`；
- 创建原因；
- 阶段：`execution / planning / recovery / resume / availability_recovery / compatibility_recovery`；
- Judge Evaluation 引用；
- Route Decision 引用；
- 锁定的 Execution Profile；
- 基础质量、能力下限、临时覆盖快照；
- `last_activity_at`；
- 状态：`active / superseded / lease_expired / blocked / completed`。

实现约束：

- 同一 Task 只允许一个活动 Segment；
- 普通 Tool 循环复用当前 Segment；
- 同一 Segment 不因成本或一次成功自动换模型；
- 同模型等价 Channel 的 Attempt 变化不创建新 Segment；
- 实际模型必须变化时创建新 Segment。

### 3.4 Event

P0 只要求稳定产生：

1. `human_message`；
2. `tool_call`；
3. `tool_result`；
4. `plan_started`；
5. `plan_finished`；
6. `provider_error`。

`execution_failure` 在 P0 只记录为 Evidence，不要求完成 Recovery 状态机；正式 Failure 处理列入 P1。

每个 Event 至少保存：

- 类型；
- Session / Task / Segment；
- 原始协议证据引用；
- Tool / Call ID；
- Event Hash；
- 是否重复；
- 证据强度；
- 时间。

### 3.5 Attempt

每次实际上游调用必须单独记录：

- `attempt_id`；
- 逻辑请求关联；
- Provider / Channel；
- 请求模型与实际模型；
- 上游 Request ID；
- 状态；
- Usage；
- 成本；
- 错误类别；
- Retry Owner；
- 开始和结束时间。

客户端或 New API Retry 只能新增 Attempt，不得重复创建 Judge、Segment 或计费逻辑结果。

### 3.6 Step

P0 不实现完整 Step 状态机。

最小实现：

- 接受的 Model Response 可生成 `step_id`；
- Tool Call ID 关联 Tool Result；
- 历史重发不得重复创建 Step；
- Retry 不创建新 Step。

多 Tool 并行、长期 unresolved、复杂取消恢复列入 P1 / P2。

## 4. P0 必须支持的原生协议

### 4.1 Codex Responses

- `/v1/responses`；
- 增长的 Responses Item 历史；
- `function_call.call_id`；
- `function_call_output.call_id`；
- Streaming；
- Usage；
- 实际 `update_plan`。

不依赖 `previous_response_id`。

### 4.2 Claude Messages

- `/v1/messages`；
- 增长的 Messages 历史；
- `tool_use.id`；
- `tool_result.tool_use_id`；
- Thinking / Signature 透明转发；
- Streaming；
- Usage；
- 版本门控的 Plan-only 指纹；
- 实际 `ExitPlanMode`。

必须先从 `role=user` 内容中拆出 `tool_result`，再判断剩余 Text 是否为 HumanMessage。

## 5. P0 Judge 触发器

P0 只在以下情况重新 Judge：

1. 新 `acu-auto` / `acu-high` Task 首次请求；
2. 高置信度 `human_message`，包括“继续”、补充约束、拒绝或重做；
3. `plan_started`。

P0 不重新 Judge：

- 普通 ToolCall；
- 正常 ToolResult；
- Agent 自动继续；
- 普通 Model Response；
- Provider 429、5xx、Timeout；
- Retry Attempt；
- Plan 内部状态更新；
- PlanFinished 且没有新能力需求；
- 单纯硬兼容变化。

硬兼容变化只使用最近有效 Evaluation 重筛候选；若实际模型必须变化，创建 `compatibility_recovery` Segment，但不因兼容问题重新解释任务难度。

## 6. P0 Segment 边界

P0 创建新 Segment 的原因：

- `task_start`；
- `human_message`；
- `planning_start`；
- `planning_end`；
- `availability_recovery`；
- `compatibility_recovery`。

### 6.1 Planning 开始

强信号：

- Codex 实际调用 `update_plan`；
- Claude 命中版本门控的 Plan-only 指纹。

动作：

- 结束当前 Segment；
- 创建 Planning Segment；
- 重新 Judge；
- 临时质量覆盖暂定为 88。

### 6.2 Planning 结束

强信号：

- Claude 实际 `ExitPlanMode`；
- Codex Plan 完成并出现执行转移证据。

动作：

- 创建 Execution Segment；
- 撤销 Planning 临时覆盖；
- 默认复用最近 Judge Evaluation；
- 只有出现重大新范围或约束时才重新 Judge。

P0 不使用 Read / Search 比例、单词 plan 或自然语言计划作为自动强信号。

## 7. P1：首批用户期间补齐

1. 10 分钟 Routing Segment Lease 的惰性检查；
2. 长期 Resume 后保留原 Session / Task，Lease 过期则新建 Segment并重新 Judge；
3. 第一次确定性失败创建 Recovery Segment；
4. 相同 Failure Signature 第二次且无进展时重新 Judge；
5. 同模型等价 Channel 可用性恢复；
6. 管理员轨迹查询；
7. Step 的 `open / closed / cancelled / unresolved` 状态。

P1 仍不引入 Session 固定身份过期规则。

## 8. P2 / 延期项

- 独立 Task 语义切分模型；
- Embedding Session 匹配；
- 完整 Client Turn 状态机；
- 完整 Step 引擎；
- 弱信号自主 Planning；
- 高级 Failure 分类器；
- 修改—撤销振荡识别；
- 虚构符号持续引用识别；
- Completed 置信度；
- 多 Agent / Subagent 状态；
- 自动 Context Compaction；
- 用户连续质量分；
- 显式模型自动替换；
- 因成本或一次成功自动降级；
- 9B Router 训练。

## 9. P0 实施优先级

1. Responses 与 Messages 原生入口；
2. Streaming、Thinking 和 Tool ID 透明转发；
3. 显式模型跳过 Judge；
4. `acu-auto` 首请求 Judge + Route；
5. 当前 Segment Route 复用；
6. HumanMessage 与 ToolResult 区分；
7. Planning 强信号；
8. Attempt / Retry 独立记录；
9. PostgreSQL 最小持久化；
10. New API 鉴权身份与最终 Usage / 成本关联。

五日开发只承诺完成 P0。P1 仅在 P0 全链路通过后继续。

## 10. P0 最小验收场景

1. 显式模型请求完整透传，Judge 调用数为 0；
2. `acu-auto` 首请求调用一次 Judge并产生 Route Decision；
3. Codex Tool Call / Output 连续循环复用当前 Segment；
4. Claude `role=user` 仅含 Tool Result 时不产生 HumanMessage；
5. Claude混合 Tool Result +真实文本时正确拆分；
6. “继续”延续 Task、新建 Segment并重新 Judge；
7. Codex 实际 `update_plan` 创建 Planning Segment；
8. Claude Plan-only / `ExitPlanMode` 创建 Planning与Execution Segment；
9. New API或客户端 Retry 只增加 Attempt；
10. Streaming正文、Thinking和Tool ID不被ACU改写；
11. 实际模型、渠道、Usage和成本关联到同一逻辑请求；
12. ProviderError不改变任务难度；
13. 硬兼容变化不调用 Judge，只使用现有 Evaluation 重筛候选。

## 11. 后续文档约束

`05`—`11` 每份文档必须明确区分：

- Alpha P0；
- Alpha P1；
- 延期项；
- 验收场景。

正式开工前，再将 P0 映射为五日执行计划、代码模块、依赖和每日验收产物。
