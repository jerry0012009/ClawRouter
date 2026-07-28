# ACU Router Failure 分类与阻塞规则

> 状态：产品设计初稿，待创始人审阅  
> 版本：v0.1  
> 日期：2026-07-29  
> 依赖：`02-native-protocol-observations.md`、`04-session-task-routing-segment-state-machine-v2.md`、`04a-alpha-state-machine-implementation-profile.md`、`05-judge-and-trigger-policy.md`、`06-planning-detection.md`

## 1. 文档目的

本文定义：

1. 哪些失败属于模型执行失败；
2. 哪些失败只是 Provider、协议、权限或环境问题；
3. P0 如何生成可重复的 Failure Signature；
4. 何时判断“相同失败再次出现且没有进展”；
5. 哪些失败可以触发重新 Judge；
6. 哪些失败绝不能提高任务难度或能力下限；
7. 五日 Alpha 的 P0、P1 与延期边界。

## 2. 核心原则

### 2.1 Failure 不等于能力不足

一次失败只说明当前动作没有达到预期，不足以证明模型档位过低。

以下关系不成立：

```text
任何错误
→ 任务更难
→ 换更贵模型
```

### 2.2 先分类来源，再决定路由影响

分类顺序：

```text
Provider / 网络
→ 协议 / 兼容
→ 权限 / 依赖 / 环境
→ Tool 使用
→ 执行 / 验证
→ 用户拒绝
→ 能力阻塞候选
```

只有高置信度执行或验证失败，且重复无进展时，才进入能力阻塞判断。

### 2.3 Provider Error 不进入能力证据

429、5xx、Timeout、Overload、网络中断和 Channel 故障只影响 Attempt 与可用性恢复，不改变任务难度，不触发 Judge。

### 2.4 第一次失败不自动升级

P0：

- 第一次确定性 Execution Failure 只记录 Evidence；
- 同一核心 Signature 第二次出现且无进展，才触发安全重评估；
- Route 只允许保持或升级，不允许因故障判断降级。

## 3. Failure 一级分类

### 3.1 `provider_error`

示例：

- HTTP 429；
- HTTP 500 / 502 / 503；
- Provider Timeout；
- Overload；
- DNS / TLS / Connection Reset；
- 上游 Channel 暂时不可用。

状态影响：

- 新增失败 Attempt；
- 不创建 ExecutionFailure；
- 不重新 Judge；
- 不提高能力下限；
- 交给 `08` 的同模型 Channel 恢复策略。

### 3.2 `protocol_or_compatibility_error`

示例：

- Endpoint 不支持 `/v1/responses` 或 `/v1/messages`；
- Tool Schema / Thinking / Streaming 格式不兼容；
- 上下文窗口不足；
- 模型不支持所需 Tool、模态或结构化输出；
- New API / Provider 删除必要字段。

状态影响：

- 不重新解释任务难度；
- 使用现有 Evaluation 重新筛选兼容 Profile；
- 实际模型必须变化时创建 `compatibility_recovery` Segment；
- 不计入能力失败次数。

### 3.3 `environment_or_permission_error`

示例：

- 文件权限不足；
- 缺少系统依赖或命令；
- 环境变量缺失；
- 磁盘不足；
- 端口占用；
- 容器、网络、数据库或测试环境未启动；
- 用户未授权危险操作。

状态影响：

- 可使 Task 暂时 Blocked；
- 不提高 `capability_escalation_floor`；
- 不因错误本身重新 Judge；
- 外部条件恢复后继续原 Task。

若模型在明确环境事实后仍重复执行同一错误动作，重复动作本身可形成后续能力证据，但环境错误本体仍不能被改写为模型能力不足。

### 3.4 `tool_usage_error`

示例：

- Tool 参数缺失或类型错误；
- 调用不存在的 Tool；
- Shell 命令语法错误；
- 使用错误文件路径或符号；
- Patch 无法应用。

P0 处理：

- 第一次记录 ExecutionFailure Evidence；
- 第二次完全相同核心错误且无进展，允许进入重复失败 Trigger；
- 明显由客户端或 Adapter 格式错误造成时，应重新分类为协议错误。

### 3.5 `execution_or_verification_failure`

示例：

- Test / Build / Typecheck 失败；
- 修改后核心错误仍存在；
- 结果不符合结构化验收条件；
- 代码无法编译或运行；
- Tool 成功执行，但产物未达到目标。

这是 P0 能力阻塞判断的主要候选类别。

### 3.6 `user_rejected`

来源必须是高置信度 HumanMessage，例如：

- “还是不对”；
- “理解错了”；
- “重新做”；
- “这不是我要的”。

用户拒绝本身已经通过 HumanMessage Trigger 重新 Judge，不需要再通过 Failure 重复触发。

单次拒绝不自动永久提高能力下限；应结合错误理解、重复失败或验证证据。

## 4. P0 Failure Event

建议结构：

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

原始错误内容保存在 Trace 中；Failure Event 只保存结构化分类和可审计引用。

## 5. P0 Failure Signature

### 5.1 目标

Signature 用于识别“同一核心失败再次出现”，不是用于理解所有语义相似错误。

P0 优先高精度，允许漏掉语义相近但文本不同的失败。

### 5.2 输入字段

建议组合：

```text
category
+ source
+ tool_name
+ exit_code / protocol_error_type
+ normalized_error_class
+ normalized_core_message
+ relevant_test_or_build_target
+ relevant_file_or_symbol（如稳定可提取）
```

### 5.3 确定性规范化

P0 可以删除：

- ANSI 控制字符；
- 时间戳；
- Request ID、Trace ID、UUID；
- 临时目录前缀；
- 随机端口；
- 耗时和速度数字；
- 重复空白；
- 完全重复的 Stack Frame。

P0 应保留：

- 错误类型；
- Tool 名；
- Exit Code；
- Test / Build 目标；
- 关键文件、符号和断言；
- 核心错误正文。

不得把所有数字、文件路径或行号全部删除，否则可能把不同失败错误合并。

### 5.4 Signature 版本化

```text
signature = SHA256(
  signature_version
  + canonical_failure_payload
)
```

规则升级不得覆盖历史 Signature；数据库必须保存 Signature Version。

## 6. “无进展”判定

P0 采用保守、确定性的判断。

同一 Signature 第二次出现前，若满足以下任一条件，视为存在进展，不触发能力 Judge：

- 相关 Test / Build 从失败变为成功；
- 失败测试数量明确减少；
- 核心 Signature 改变；
- Tool Result 表明原阻塞已解决；
- 用户明确接受阶段结果；
- 当前 Plan 或执行策略发生实质改变，并尚未重新验证。

P0 的 `no_progress=true` 最小条件：

```text
同一 signature 第二次出现
+ 两次之间没有成功验证
+ 没有失败数量下降
+ 没有核心 Signature 变化
```

无法判断时默认不触发，记录 `progress_state=unknown`。

## 7. P0 能力阻塞 Trigger

触发条件：

```text
category ∈ {
  tool_usage_error,
  execution_or_verification_failure
}
+ 同一 Signature 第二次出现
+ no_progress = true
+ 当前不是重复网络传输或 Retry
→ capability_block_candidate
```

动作：

- 结束当前 Segment；
- 创建 `capability_recovery` Segment；
- 重新 Judge；
- JudgeContext 包含两次失败、两次之间的 Tool / Model 行为和当前 Profile；
- Route Decision 只允许保持或升级；
- 是否永久提高能力下限由新 Evaluation 决定。

同一 Failure Event 因历史重发、New API Retry 或 Client Retry 重复出现时，必须幂等去重，不能累计次数。

## 8. 明确不触发能力 Judge

- Provider 429 / 5xx / Timeout；
- 协议转换失败；
- 模型上下文或 Tool 硬不兼容；
- 权限、依赖、磁盘、端口和环境配置错误；
- 客户端取消；
- 单次 Test / Build 失败；
- Signature 已变化；
- 已观察到明确进展；
- 同一错误只是被历史重发；
- Client / New API / Provider Retry。

## 9. 错误分类优先级

同一原始事件可能匹配多个类别，按以下顺序归类：

```text
provider_error
> protocol_or_compatibility_error
> environment_or_permission_error
> tool_usage_error
> execution_or_verification_failure
```

例如：

- Shell 返回“command not found”通常是环境错误，不是能力失败；
- Tool JSON 格式被 New API 改坏是协议错误，不是 Tool 使用错误；
- Provider 503 后 Client 重发不是模型重复失败；
- Test Assertion 第二次完全相同且没有改善，才是能力阻塞候选。

## 10. 与 Retry / Attempt 的关系

每次实际上游调用是一个 Attempt，但 Failure Event 只在产生新的逻辑失败事实时创建。

```text
Attempt 1 → Provider 503
Attempt 2 → Provider 503
Attempt 3 → 成功 Model Response → Test失败
```

结果：

- 三个 Attempt；
- 两个 ProviderError 记录；
- 一个 ExecutionFailure；
- 不得把两个 503 算成能力失败重复次数。

## 11. 与 Planning 的关系

- Planning 内部 Tool 错误按正常分类处理；
- PlanUpdated 不代表进展或失败；
- Recovery 后强 Replanning 信号可创建 Planning Segment并 Judge；
- P0 不因“计划写得不好”自动形成 Failure；
- 用户拒绝计划通过 HumanMessage / UserRejected 触发，而不是错误 Signature。

## 12. P0 实施范围

五日内实现：

1. 一级 Failure 分类；
2. Provider / 协议 / 环境错误排除；
3. `failure-signature-v1`；
4. 历史重发和 Retry 幂等；
5. 同一 Signature 第二次且无进展；
6. capability recovery Segment；
7. 重新 Judge且只保持或升级；
8. Failure、Attempt、Judge 和 Route 可审计关联。

## 13. P1 与延期项

P1：

- 语义相近错误聚类；
- 更完整的测试数量和错误数量比较；
- 修改—撤销振荡；
- 虚构路径或符号持续引用；
- 大量 Read / Search 无进展；
- 多错误因果关系；
- OpenClaw / Hermes Tool 和 Failure 结构侦察。

延期：

- LLM Failure 分类器；
- Embedding 错误聚类；
- 自动根因分析；
- 跨项目通用错误知识库；
- 自动生成修复方案。

## 14. P0 验收场景

1. Provider 503 只记录 Attempt / ProviderError，不触发 Judge；
2. `command not found` 被归为环境错误，不触发能力 Judge；
3. Tool Schema 格式错误被归为协议或 Tool 使用错误，按来源区分；
4. 第一次 Test 失败只记录 Evidence；
5. 第二次相同 Test Signature 且无进展，恰好触发一次 Judge；
6. 中间失败数量减少时不触发；
7. Signature 改变时不触发；
8. 历史重发不增加失败次数；
9. New API / Client Retry 不增加失败次数；
10. capability recovery 只允许保持或升级；
11. 环境错误不会提高能力下限；
12. Failure Event 可追溯到原始 Tool Result、Step、Attempt、Segment 和 Route。
