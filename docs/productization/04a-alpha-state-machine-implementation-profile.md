# ACU Router 五日 Alpha 状态机实施剖面

> 状态：五日 Alpha 开发约束  
> 版本：v0.5  
> 日期：2026-07-29  
> 上位规范：`04-session-task-routing-segment-state-machine-v2.md`  
> 适用范围：3—10 名邀请制 OPC 程序员，原生 Codex / Claude Code，经 New API 接入 ACU

## 1. 文档目的

`04` 是长期产品语义规范；本文只定义五日 Alpha 必须落地的最小闭环。P1 和延期项不得伪装成已实现能力。

## 2. P0 核心闭环

```text
Codex / Claude Code
→ New API 鉴权与额度
→ ACU 识别 Session / Task / Segment
→ 必要时 Judge
→ 现有 ACU 连续价值公式选择并锁定 Profile
→ 原生 Streaming / Tool / Thinking 透传
→ Attempt、Usage、成本和 Route 入账
→ 普通后续 Step 复用 Route
```

Alpha 不建设完整自治工作流引擎。

## 3. 客户端支持边界

P0 正式验收：

- Codex `/v1/responses`；
- Claude Code `/v1/messages`。

OpenClaw、Hermes 和其他 Agent 可保留标准协议入口，显式模型可以实验性透传，但 P0 不宣称其已支持 ACU 任务级自动路由。P1 再补协议侦察和 Adapter 验收。

## 4. P0 最小对象

### Session

保存 `session_id`、用户 / API Key、客户端、协议、规范化历史 Hash、最近 Tool Call ID、`last_activity_at`、当前 `task_id` 与 `segment_id`。

Session 不设置固定身份过期。强历史前缀、Tool ID 因果链或可信 Resume 成立时可长期恢复；连续性不确定时创建新 Session并重新 Judge。

### Task

一个 Session 同时只有一个活动 Task。保存初始目标、当前阶段、基础质量偏好、能力升级下限和时间字段。

“继续”“补充约束”“重做”“还是不行”默认延续当前 Task；明确 New Goal / Reset 或连续性无法确认时创建新 Task。

### Routing Segment

保存创建原因、阶段、Evaluation、Route Decision、锁定 Profile、质量偏好参数快照、`last_activity_at`、`accepted_model_responses_since_judge` 和状态。

普通 Tool 循环复用 Segment。实际模型改变时创建新 Segment；同模型等价 Channel 的 Attempt 变化不创建 Segment。

### Event

P0 稳定产生：

- `human_message`；
- `tool_call`；
- `tool_result`；
- `plan_started`；
- `plan_finished`；
- `execution_failure`；
- `provider_error`。

### Step / Attempt

P0 不实现完整 Step 状态机，只要求已接受 Model Response、Tool Call ID 与 Tool Result 可关联且可去重。

每次真实 Provider 调用必须有独立 Attempt。Client、New API 或 Provider Retry 只能新增 Attempt，不得重复创建 Judge、Segment 或逻辑计费结果。

## 5. P0 原生协议

Codex：Responses 历史增长、`function_call.call_id` / `function_call_output.call_id`、Streaming、Usage、实际 `update_plan`。

Claude：Messages 历史增长、`tool_use.id` / `tool_result.tool_use_id`、Thinking / Signature、Streaming、Usage、Plan-only 指纹、实际 `ExitPlanMode`。

Claude 必须先从 `role=user` 拆出 `tool_result`，再判断剩余 Text 是否为 HumanMessage。

## 6. P0 Judge 触发器

P0 不是每个请求都 Judge，也不是只有用户发消息才 Judge。必须实现：

1. 新自动路由 Task；
2. 所有高置信度 HumanMessage；
3. PlanStarted；
4. PlanFinished；
5. 相同核心 Failure Signature 第二次出现且中间无明确进展；
6. Segment 的 Judge 陈旧预算耗尽。

### Judge 陈旧预算

```text
accepted_model_responses_since_judge >= max_unjudged_model_responses
→ safety_refresh Segment
→ 重新 Judge
```

P0 默认：

```text
max_unjudged_model_responses = 16
```

该值可配置。只统计被接受的逻辑 Model Response，不统计 HTTP Attempt、Retry、SSE Event 或历史重发。

16 是 Codex / Claude Code 与未知 Agent 的统一 Alpha 默认值。它不是“未知客户端专属阈值”，但可按客户端策略覆盖。真实流量后根据平均任务长度、Judge 成本和漏触发率校准。

### 重复失败

第一次失败只记录 Evidence。第二次相同核心失败且无进展时创建 `capability_recovery` Segment、重新 Judge，并只允许保持或升级。Provider、协议、权限、依赖和环境错误不得进入该计数。

## 7. Planning 边界

PlanStarted：Codex 实际 `update_plan`，或 Claude 版本化 Plan-only 指纹。创建 Planning Segment、重新 Judge，并设置：

```text
temporary_phase_override = 88
```

88 是传入 ACU 连续价值公式的质量偏好锚点，不是预测分硬达标线。

PlanFinished：Claude 实际 `ExitPlanMode`；Codex 为 Plan 必要项完成后首次实际 Edit / Write / Patch / Test / Build，且无 Plan 重建。

PlanFinished 创建 Execution Segment、撤销 88、重新 Judge，并按完成后的 Plan 重新运行连续价值公式。

## 8. P0 路由语义

P0 复用当前 `src/acu/decision.ts`：

- 先做协议、Tool、Thinking、模态、上下文、健康和管理员策略硬过滤；
- 对剩余候选估计质量、保守质量、调用成本与预期 fallback 成本；
- 构造成本—质量 Pareto 前沿；
- 用 `effective_quality_target` 调整质量权重、风险权重和效用曲线；
- 选择 `valueUtility` 最大的 Profile。

因此：

- 88 不会直接淘汰预测分低于 88 的模型；
- 所有模型低于 88 时仍能做最合理的质量—成本权衡；
- 所有模型高于 88 时成本效用仍然有效；
- `meetsQualityTarget` 只作为解释和展示字段，不作为 P0 路由硬过滤。

## 9. P1

- 10 分钟 Routing Lease 与长期 Resume；
- 上下文增长 Trigger；
- 低比例 Shadow Judge；
- OpenClaw / Hermes 侦察；
- 实时 Channel Health；
- 更完整 Step 状态与管理员轨迹。

Shadow Judge 不改变线上 Route、不向用户计费。

## 10. 延期项

独立 Task 切分模型、Learned Trigger Model、Embedding Session、弱 Planning、高级 Failure、多 Agent、Completed 置信度、自动 Context Compaction、用户连续质量分和 9B Router 训练。

## 11. P0 验收

1. 显式模型 Judge = 0；
2. 新自动路由 Task 恰好 Judge 一次；
3. 普通 Tool 循环复用 Segment；
4. Claude ToolResult 不误判 HumanMessage；
5. “继续”读取完整 Task并 Judge；
6. PlanStarted 与 PlanFinished 分别 Judge；
7. 相同核心错误第二次无进展 Judge；
8. 连续 16 个被接受 Model Response 且无其他 Trigger 时 safety refresh；
9. 88 仅作为连续公式偏好锚点；
10. Retry 只增加 Attempt；
11. Streaming、Thinking、Tool ID 不被改写；
12. 实际模型、Channel、Usage 和成本可关联；
13. ProviderError 不改变 Difficulty；
14. 同一 Trigger 重放不重复 Judge。
