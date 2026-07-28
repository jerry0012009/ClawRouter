# ACU Router Failure 分类与阻塞规则

> 状态：产品设计基线，P0 阈值已确认  
> 版本：v0.2  
> 日期：2026-07-29  
> 依赖：`02-native-protocol-observations.md`、`04-session-task-routing-segment-state-machine-v2.md`、`04a-alpha-state-machine-implementation-profile.md`、`05-judge-and-trigger-policy.md`、`06-planning-detection.md`

## 1. 文档目的

本文定义：

1. 哪些失败属于模型执行失败；
2. 哪些失败只是 Provider、协议、权限或环境问题；
3. P0 如何生成 Failure Signature；
4. 如何判断“同一失败第二次出现且无进展”；
5. 哪些失败可以触发 Judge；
6. 哪些失败不得提高任务难度或能力下限。

## 2. 核心原则

### 2.1 Failure 不等于能力不足

一次失败只说明当前动作没有达到预期，不足以证明模型档位过低。

### 2.2 先分类来源，再决定路由影响

```text
Provider / 网络
→ 协议 / 兼容
→ 权限 / 依赖 / 环境
→ Tool 使用
→ 执行 / 验证
→ 用户拒绝
→ 能力阻塞候选
```

只有高置信度 Tool 使用错误或执行 / 验证失败，且第二次重复无进展时，才进入能力重评估。

### 2.3 Provider Error 不进入能力证据

429、5xx、Timeout、Overload、网络中断和 Channel 故障只影响 Attempt 与可用性恢复，不改变任务难度，不触发能力 Judge。

### 2.4 第二次重复无进展触发

P0 阈值已经确认：

- 第一次确定性 Execution Failure：只记录 Evidence；
- 同一核心 Signature 第二次出现且无进展：重新 Judge；
- 新 Route 只允许保持或升级；
- 不等待第三次。

原因：首批用户阶段应避免错误 Route 在自治循环中持续消耗 Token。

## 3. Failure 一级分类

### 3.1 `provider_error`

包括 429、5xx、Timeout、Overload、DNS / TLS / Connection Reset 和 Channel 故障。

影响：新增失败 Attempt；不生成能力失败；不重新 Judge；交给 `08` 恢复。

### 3.2 `protocol_or_compatibility_error`

包括：

- Endpoint 不支持 `/v1/responses` 或 `/v1/messages`；
- Tool Schema、Thinking、Streaming 不兼容；
- 上下文窗口不足；
- 模型不支持所需 Tool、模态或结构化输出；
- New API / Provider 删除必要字段。

影响：使用当前 Evaluation 重筛兼容 Profile；必要时创建 `compatibility_recovery` Segment；不计入能力失败。

### 3.3 `environment_or_permission_error`

包括文件权限、缺少依赖 / 命令 / 环境变量、磁盘、端口、容器、网络、数据库、测试环境和用户未授权。

影响：可使 Task 暂时 Blocked，但不提高 `capability_escalation_floor`，不因错误本身 Judge。

### 3.4 `tool_usage_error`

包括 Tool 参数错误、不存在的 Tool、Shell 语法、错误路径 / 符号和 Patch 失败。

第一次记录 Failure Evidence；第二次完全相同核心错误且无进展时，可触发能力重评估。Adapter 格式问题应重新分类为协议错误。

### 3.5 `execution_or_verification_failure`

包括 Test / Build / Typecheck 失败、修改后核心错误仍存在、结构化验收不通过、代码无法编译运行或产物未达到目标。

这是 P0 能力阻塞判断的主要候选类别。

### 3.6 `user_rejected`

必须来自高置信度 HumanMessage，例如“还是不对”“理解错了”“重新做”。

HumanMessage 已经触发 Judge，不需要再通过 Failure 重复触发。单次拒绝不自动永久提高能力下限。

## 4. Failure Event

P0 保存：

```json
{
  "failure_id": "fail_...",
  "task_id": "task_...",
  "segment_id": "seg_...",
  "step_id": "step_...",
  "attempt_id": "attempt_...",
  "category": "execution_or_verification_failure",
  "source": "tool_result",
  "tool_name": "shell",
  "exit_code": 1,
  "signature_version": "failure-signature-v1",
  "signature": "sha256...",
  "progress_state": "none",
  "raw_evidence_ref": "trace_...",
  "occurred_at": "ISO-8601"
}
```

原始错误内容保存在 Trace；Failure Event 保存分类、Signature 和证据引用。

## 5. P0 Failure Signature

### 5.1 输入

```text
category
+ source
+ tool_name
+ exit_code / protocol_error_type
+ normalized_error_class
+ normalized_core_message
+ test_or_build_target
+ stable_file_or_symbol
```

### 5.2 确定性规范化

删除：ANSI、时间戳、Request / Trace ID、UUID、临时目录、随机端口、耗时和完全重复 Stack Frame。

保留：错误类型、Tool、Exit Code、测试目标、关键文件 / 符号、断言和核心错误正文。

不得删除所有数字、路径或行号，否则会错误合并不同失败。

### 5.3 版本化

```text
signature = SHA256(
  signature_version
  + canonical_failure_payload
)
```

规则升级不得覆盖历史 Signature。

## 6. “无进展”判定

同一 Signature 第二次出现前，若出现以下任一事实，视为有进展，不触发能力 Judge：

- Test / Build 从失败变成功；
- 失败数量减少；
- 核心 Signature 改变；
- Tool Result 表明原阻塞已解决；
- 用户接受阶段结果；
- 执行策略发生实质变化且尚未重新验证。

P0 最小条件：

```text
同一 Signature 第二次出现
+ 两次之间没有成功验证
+ 没有失败数量下降
+ 没有核心 Signature 变化
→ no_progress = true
```

无法判断时使用 `progress_state=unknown`，不触发能力 Judge。

## 7. P0 能力阻塞 Trigger

```text
category ∈ {
  tool_usage_error,
  execution_or_verification_failure
}
+ 同一 Signature 第二次出现
+ no_progress = true
+ 不是 Retry / 历史重放
→ capability_recovery Segment
→ 重新 Judge
```

JudgeContextEnvelope 必须包含两次失败、两次之间的策略 / Tool 行为、上次 Evaluation 和当前 Profile。

Route 只允许保持或升级。是否提高能力下限由新 Evaluation 决定。

## 8. 明确排除

以下不得进入能力重复计数：

- Provider 429 / 5xx / Timeout；
- 协议转换错误；
- 上下文窗口不兼容；
- 权限、依赖、环境问题；
- Client / New API / ACU Retry；
- 相同历史被重发；
- 客户端取消；
- 尚未收到 ToolResult 的未闭合 ToolCall。

## 9. 与 Judge 陈旧预算的关系

重复失败 Trigger 用于明确卡住；`05` 的 Judge 陈旧预算用于没有可识别错误但自治任务运行过久的情况。

两者独立：

- 先发生重复失败时，立即 Judge并重置陈旧计数；
- 没有重复失败时，最多运行配置数量的被接受 Model Response 后 safety refresh；
- 同一请求同时命中时，只执行优先级更高的 repeated_failure Trigger。

## 10. P0 验收

1. Provider 503 只产生失败 Attempt；
2. 权限 / 依赖错误不提高能力下限；
3. 第一次测试失败不 Judge；
4. 同一核心错误第二次无进展 Judge；
5. 错误数量下降不触发；
6. Signature 变化不触发；
7. Retry / 历史重放不增加失败次数；
8. UserRejected 只通过 HumanMessage 触发一次；
9. 能力恢复 Route 不降级；
10. Signature 版本和原始 Evidence 可审计。

## 11. P1 与延期

P1：语义相近错误聚类、复杂进展判断、振荡、虚构符号、Read / Search 无进展和管理端审计。

延期：学习型 Failure Classifier、多错误因果图、自动根因分析和跨 Agent 统一语义 Signature。
