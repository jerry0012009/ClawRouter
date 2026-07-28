# ACU Router Session / Task / Routing Segment 状态机

> 状态：Productization Phase 0 已确认设计基线  
> 版本：v0.2  
> 日期：2026-07-29  
> 依赖文档：`01-glossary-and-domain-model.md`

## 1. 文档目标

本文件定义 ACU Router 在原生 Codex / Claude Code 流量下如何回答四个问题：

1. 当前请求属于哪个 Session 和 Task / Goal；
2. 当前请求是否延续已有 Routing Segment；
3. 是否需要重新调用 LLM Judge；
4. 应保持、临时提高、升级或重新选择哪个 Execution Profile。

状态机的首要目标不是最大化切换频率，而是：

- 在同一连续工作片段中保持模型稳定；
- 只在任务能力需求可能变化时重新 Judge；
- 只在高置信度能力阻塞时升级；
- 避免把普通工具失败、环境失败和上游失败误判为模型能力不足；
- 完整记录轨迹，为后续训练 Q-Context、Q-Difficulty 和失败识别模型积累数据。

## 2. 设计原则

### 2.1 原生请求优先

ACU 不是 Coding Agent，不能控制 Codex 或 Claude Code 提供哪些字段。

状态判断必须以原生 API 请求为第一事实来源，并允许：

- 某些客户端提供显式线程 / Response 关联；
- 某些客户端重新发送完整历史；
- 某些客户端只发送部分历史；
- Goal 模式在没有新的人类输入时产生多个内部 Turn。

### 2.2 Routing Segment 而非 Turn 是路由锁定单位

同一 Task 内可能有多个 Client Turn；同一 Client Turn 也可能包含多个模型 Step。

ACU 不将“出现一个新 Turn”机械等同于“必须换模型”。真正共享一次难度评估和执行配置的单位是 Routing Segment。

### 2.3 高精度、低频触发

第一期宁可少识别一些能力阻塞，也不要频繁错误升级。

普通 Coding Agent 即使使用强模型，也会经历：

- 第一次搜索没有找到目标；
- 第一次测试失败；
- 一次工具参数错误；
- 暂时走错路径后自行修正。

这些是正常探索过程，不应自动触发升级。

### 2.4 当前 Segment 只保持或升级

同一个 Routing Segment 内：

- 默认保持当前 Execution Profile；
- 明确能力阻塞后可升级；
- 不自动降级。

Planning 临时质量覆盖结束后创建新的 Execution Segment，可以恢复 Task 基础质量偏好。这不是同一 Segment 内降级。

## 3. 状态层级

```text
Session
└── Task / Goal
    ├── Client Turn（观察概念，不是路由边界）
    └── Routing Segment
        ├── Judge Evaluation
        ├── Route Decision
        └── Step
            ├── Tool Event
            └── Execution Attempt
```

## 4. 顶层处理流程

```text
收到原生 Codex / Claude Code 请求
        ↓
持久化原始请求与协议元数据
        ↓
识别或创建 Session
        ↓
识别或创建 Task / Goal
        ↓
解析新增事件类型
        ↓
识别当前 Task Phase
        ↓
判断已有 Routing Segment 和 Lease 是否可复用
        ↓
检查 Judge 触发器
        ├── 不触发：复用当前 Route Decision
        ├── 只需兼容过滤：保留难度，重筛 Execution Profile
        └── 需要重评估：创建新 Segment，构造 JudgeContextEnvelope
                ↓
             运行 Judge
                ↓
             价值路由与约束过滤
        ↓
执行上游模型请求
        ↓
保存 Step、Attempt、Tool Event、成本和结果证据
        ↓
更新 Phase、阻塞计数、Lease 和当前 Segment 状态
```

## 5. Session 识别

第一期采用分层确定性识别，不依赖本地模型或 Embedding。

### 5.1 优先级一：原生协议强关联

优先使用实际请求中存在且经过抓包验证的字段，例如：

- Responses 的 `previous_response_id` 与 Response ID；
- Function Call `call_id` 与 Function Call Output 关联；
- Anthropic `tool_use.id` 与 `tool_result.tool_use_id`；
- 原生客户端可能透传的 Session / Thread 标识。

这些字段是否稳定存在，必须在协议侦察阶段通过真实 Codex 和 Claude Code 流量确认。

### 5.2 优先级二：工具调用因果关系

如果新请求中的 Tool Result / Function Call Output 明确对应上一 Step 的 Tool Call，则：

- 归入同一 Session；
- 通常归入同一 Task；
- 默认归入同一 Routing Segment；
- 除非 Tool Result 本身构成高置信度能力阻塞证据。

### 5.3 优先级三：精确上下文前缀链

对原生请求中的内容 Item 做确定性标准化和 Hash。

标准化内容包括：

- role / item type；
- 文本内容；
- Tool / Function 名称；
- Tool Call 参数；
- Tool Result；
- 可见 Reasoning / Thinking；
- System / Developer 指令。

排除仅影响传输、不影响语义的字段，例如：

- 请求 ID；
- 时间戳；
- Streaming 开关；
- 渠道内部字段；
- 可安全忽略的顺序无关元数据。

计算：

```text
item_hash[n] = SHA256(normalized_item[n])
chain_hash[n] = SHA256(chain_hash[n-1] + item_hash[n])
```

如果新请求包含上一请求的完整历史前缀，并仅在尾部增加新的 Tool Result、Assistant 内容或用户 / Goal 输入，则判定为同一 Session。

### 5.4 优先级四：弱关联

前三类信号缺失时，可使用以下组合：

```text
同一 API Key
+ 相同 System / Developer 指纹
+ 相同 Tool Schema 指纹
+ 较长公共上下文前缀
+ 相近时间
```

弱关联不能仅依靠“同一用户十分钟内又发了一次请求”。

### 5.5 无法确认

如果无法高置信度确认连续性：

- 创建新 Session 或新 Task；
- 运行 Judge；
- 不静默沿用旧低难度和旧模型。

错误拆分只增加一次 Judge；错误合并可能让高难度新任务沿用不充分模型，风险更高。

## 6. Task / Goal 识别

Task / Goal 是语义连续目标，但第一期不使用独立 LLM 进行 Task 切分。

### 6.1 默认延续当前 Task

满足以下任一强关联时，默认延续：

- `previous_response_id` / Tool Call 因果关系延续；
- 原始上下文完整前缀延续；
- Goal Continuation 没有新增目标或约束；
- 用户输入“请继续”且上下文仍指向原任务。

### 6.2 可能创建新 Task 或重大扩展

以下事件作为 Judge 证据：

- 新增显著不同的目标；
- 任务范围从单文件扩大到系统级；
- 新增多个关键约束；
- 从修复问题转为大规模重构；
- 新项目 / 新仓库 / 新工作目录；
- 客户端明确发出新 Goal / Reset 信号。

是否新建 Task 可由第一期规则结合 Judge 输出决定；所有判断和证据必须保存。

### 6.3 Goal 模式

Goal 模式可能在没有新的人类输入时产生多个内部 Turn 或 Subgoal。

原则：

- 客户端内部 Turn 变化不自动创建新 Routing Segment；
- 明确新的 Goal、Planning、Replanning 或能力需求变化才创建新 Segment；
- 仅仅是自动继续执行已有计划，复用现有 Segment。

## 7. Routing Segment 生命周期

建议状态：

- `active`；
- `superseded`；
- `completed`；
- `blocked`；
- `lease_expired`；
- `incompatible`；
- `abandoned`。

### 7.1 创建 Segment

创建新 Routing Segment 的主要原因：

- `new_task`；
- `new_external_input`；
- `goal_change`；
- `planning_start`；
- `replanning_start`；
- `planning_end`；
- `capability_block`；
- `lease_expired`；
- `compatibility_change`。

每次创建时保存：

- 触发原因；
- 上一 Segment；
- 当前 Task Phase；
- Task 基础质量偏好；
- 临时质量覆盖；
- 当前最低允许质量等级；
- JudgeContextEnvelope Hash；
- Judge 与路由策略版本。

### 7.2 复用 Segment

以下条件同时满足时复用：

- Session / Task 连续性成立；
- Routing Lease 有效；
- 没有新的 Judge 触发器；
- 当前 Execution Profile 仍满足硬兼容条件；
- 没有高置信度能力阻塞；
- 当前活动属于正常连续 Step / Tool Event。

### 7.3 完成或替代

新 Segment 创建后，上一 Segment 标记为 `superseded` 或 `completed`，并记录结束原因。

## 8. Routing Lease

### 8.1 默认时长

```text
10 分钟
```

### 8.2 续租事件

任何有效活动都会更新 `last_activity_at`：

- 接收到模型请求；
- 上游模型仍在有效 Streaming；
- 模型响应完成；
- Tool Call；
- Tool Result；
- 用户输入；
- 可确认属于当前任务的其他客户端事件。

### 8.3 过期行为

当：

```text
now - last_activity_at > 10 分钟
```

下一次模型请求到来时：

- Session 不自动结束；
- Task 不自动结束；
- 当前 Segment 标记为 `lease_expired`；
- 创建新 Segment；
- 重新构造完整 JudgeContextEnvelope；
- Judge 结合既往任务状态决定维持还是重新选择能力需求。

系统不运行后台定时 Judge，只在新请求到来时检查 Lease。

## 9. Judge 触发策略

## 9.1 必须重新 Judge

### A. 新 Task 或无法确认连续性

无法确定是否延续已有任务时，重新 Judge。

### B. 新的实质性外部输入

新的真实用户输入默认创建新 Segment 并重新 Judge，包括“请继续”“执行吧”等短输入。

但 Judge 不能只读取短文本，必须读取：

- 原始当前 API 请求；
- Task 初始目标；
- 当前 / 最近 Plan；
- 上一 Judge 与 Route Decision；
- 最近 Step 和 Tool Event；
- 过去成功 / 失败；
- 用户满意 / 不满意信号；
- 当前 Execution Profile 和升级历史。

### C. 新 Goal 或目标明显变化

包括新增任务范围、关键约束、项目或架构目标。

### D. Planning 开始

检测到高置信度 Planning 开始时：

- 创建 Planning Segment；
- 构造新的 JudgeContextEnvelope；
- 临时提高 Planning 权重或质量偏好；
- 默认 `effective_quality_target = max(task_base_quality_target, 88)`。

### E. Replanning

原计划被否定、测试或实现路径证明不可行、Agent 明确重新规划时重新 Judge。

### F. Planning 明确结束

Planning 明确结束、准备进入 Execution 时：

- 创建新的 Execution Segment；
- 重新 Judge 接下来执行阶段的难度；
- Planning 临时质量覆盖结束；
- 允许恢复 Task 基础质量偏好；
- 根据新 Segment 重新选择 Execution Profile。

这不是同一 Segment 内降级。

如果无法高置信度识别 Planning 已结束，第一期不自动回落，继续保持当前配置。

### G. 高置信度能力阻塞

达到本文件第 13 节的规则阈值时重新 Judge，并只允许保持或升级。

### H. Routing Lease 过期

超过 10 分钟后下一次请求重新 Judge。

### I. 强用户不满意或明确重试

例如用户明确表示：

- 没解决；
- 还是不行；
- 理解错了；
- 重新来；
- 测试仍然失败；
- 要求更强模型或重新处理。

这些信号不直接硬加固定难度分，而作为结构化 Evidence 交给 Judge。

## 9.2 不重新 Judge

以下情况默认复用当前 Segment：

- 普通 Tool Result；
- 正常连续模型 Step；
- 正常 Read / Search / Edit；
- 第一次测试失败；
- 错误签名发生改善或有明确进展；
- 模型正在尝试新的合理策略；
- 普通上游 429、5xx、Timeout；
- Tool 执行时间较长但有效活动仍在续租；
- 单纯 Streaming 继续；
- 相同任务的正常自动 Goal Continuation。

## 9.3 只重新过滤候选，不重新 Judge

以下变化影响执行可用性，但不一定改变任务难度：

- 当前 Execution Profile 上下文窗口不足；
- 请求新增当前 Profile 不支持的工具；
- 新增 Vision 或其他模态；
- 当前渠道限流或过载；
- 当前 Profile 不支持 Responses / Messages / Streaming / Tool Calling；
- Usage 或必要参数在该渠道不兼容。

处理：

```text
保留最近 Judge Evaluation
→ 更新兼容性与健康过滤
→ 重新选择满足最低质量等级的 Execution Profile
```

## 10. JudgeContextEnvelope 构造

第一期采用：

> 原始当前 API 输入优先 + PostgreSQL 历史状态 + 确定性规则提取。

不使用本地模型或额外 LLM 做摘要。

### 10.1 必须包含

1. 当前原生 API 请求；
2. Session / Task / Segment 元数据；
3. Task 初始目标和最近外部输入；
4. 上一次 Judge Evaluation；
5. 上一次 Route Decision；
6. 当前 Execution Profile；
7. 当前或最近活动 Plan；
8. 最近 Step；
9. 最近 Tool Call / Tool Result；
10. 最近 Test / Build / Patch 结果；
11. 成功与失败 Evidence；
12. 用户满意 / 不满意 / 重试 Evidence；
13. 重复错误签名与次数；
14. 当前 Task Phase；
15. 当前 Segment 的升级历史。

### 10.2 原始上下文未超限

尽可能原封不动保留：

- System / Developer 指令；
- Messages / Input Items；
- Tool Schema；
- Tool Calls / Results；
- 可见 Reasoning / Thinking；
- 历史 Assistant 内容。

再附加 ACU 结构化状态。

### 10.3 原始上下文超限

使用确定性裁剪，不使用 LLM 总结。

始终保留：

1. System / Developer 指令；
2. 最新外部输入或 Goal；
3. Task 初始目标；
4. 当前活动 Plan；
5. 上一次 Judge 与 Route Decision；
6. 上次 Judge 之后的全部错误 Evidence；
7. 最近 Tool Call 与对应 Result；
8. 最近 Test / Build 结果；
9. 最近若干 Step；
10. 用户不满意 / 重试 Evidence；
11. 当前原生请求尾部。

优先删除：

- 完全重复的历史内容；
- 重复 Tool Schema；
- 已完成且后续未引用的大段 Read 输出；
- 重复错误正文，只保留一次全文和计数；
- 已被后续结果覆盖的早期中间输出。

对每个被裁剪内容记录：

- 数据库记录 ID；
- 内容 Hash；
- 类型；
- 原始 Token 数；
- 裁剪原因。

Judge 最大上下文 Token 应为可配置项，并选择支持长上下文的 Judge 模型。

## 11. Planning 识别

第一期目标是高精度识别，不通过“出现单词 plan”机械升级。

### 11.1 强信号

需要协议侦察确认具体字段：

- Codex 原生 Plan / `update_plan` 工具事件；
- Claude Code Plan 模式或权限模式标记；
- 明确的 Plan 状态结构；
- 客户端明确从执行切换到规划模式。

### 11.2 组合规则信号

可组合使用：

- 当前任务被识别为多文件、多模块或架构级；
- 连续使用 Read / Search / List 等只读工具；
- 尚未出现 Edit / Write / Patch；
- Assistant 输出结构化步骤、依赖关系和验证计划；
- 明确比较多种实现方案；
- 明确进行影响范围、风险或兼容性分析。

单一 Read / Search 不足以触发 Planning。

### 11.3 Planning 质量覆盖

```text
task_base_quality_target = acu-auto / acu-high 的基础参数
planning_effective_quality_target = max(task_base_quality_target, 88)
```

Planning Segment 内仍遵守“只保持或升级”。

### 11.4 Planning 结束

高置信度结束信号可包括：

- 原生 Plan 状态全部完成；
- 客户端明确切换至执行模式；
- 明确输出最终计划并开始 Edit / Write / Patch；
- 从只读工具轨迹稳定切换到实现动作；
- 抓包确认的其他稳定协议标识。

仅出现一句“开始执行”但轨迹不一致时，不应立即降级。

第一期不实现“由强模型规划后无条件换便宜模型执行”。

## 12. Phase 状态转换

建议基础转换：

```text
unknown → understanding
understanding → planning
understanding → execution
planning → execution
execution → verification
verification → completed
verification → repair
repair → verification
repair → planning       # replanning
任意阶段 → blocked
blocked → planning      # 重新规划
blocked → repair        # 升级后继续修复
任意阶段 → completed
```

Phase 主要用于：

- Judge 上下文；
- Planning 临时质量覆盖；
- Failure Evidence 解释；
- 后续训练数据。

Phase 不应直接硬编码到某一个固定模型。

## 13. 模型能力阻塞识别

第一期使用确定性规则，目标是高精度、低频触发。

## 13.1 Failure Signature

对失败进行标准化：

```text
failure_signature = SHA256(
  event_type
  + tool_name
  + normalized_arguments
  + normalized_error_code
  + target_file_or_symbol
  + normalized_core_message
)
```

标准化时移除：

- 随机 ID；
- 时间戳；
- 内存地址；
- 临时路径中的随机部分；
- 行号等可能轻微变化但不影响核心错误的字段。

## 13.2 高置信度能力阻塞候选

### A. 非法工具选择或参数反复失败

- 调用工具列表中不存在的工具；
- Tool 参数不符合 Schema；
- 必填字段持续缺失；
- 参数类型持续错误；
- 同一 Failure Signature 连续出现至少 2 次，并且模型没有改变策略。

一次工具参数错误不触发升级。

### B. 测试 / Build 核心错误无改善

- 第一次失败：正常反馈给当前模型；
- 修改后第二次仍是同一核心 Failure Signature：累计阻塞 Evidence；
- 连续 2 次无改善：可触发重新 Judge；
- 连续 3 次无改善：强触发重新 Judge。

如果失败数量减少、错误签名变化或测试明显推进，则视为进展，不触发。

### C. 虚构路径或符号反复出现

- 工具结果已明确文件 / 函数不存在；
- 模型仍连续访问或引用相同虚构目标；
- 至少重复 2 次且没有重新搜索有效路径。

### D. 轨迹振荡

例如：

```text
修改 A
→ 测试失败
→ 撤销 A
→ 再次做近似相同的 A
```

需要同时满足：

- 修改目标和内容高度相似；
- 错误没有改善；
- 至少完成一个完整振荡周期。

### E. 用户明确指出同一问题未解决

当用户明确不满意，且最近轨迹存在重复失败、无进展或错误理解 Evidence 时，触发重新 Judge。

## 13.3 软阻塞信号

单独出现不触发升级，只累计 Evidence：

- Tool Error 但参数已明显改变；
- 编译错误变化但仍未通过；
- 连续大量 Read / Search 但尚未编辑；
- 重新解释问题；
- 生成新 Plan 但尚未实施；
- 表达不确定或需要更多信息；
- 测试仍失败但失败数量下降。

未来可根据真实数据调整组合阈值。第一期不建议用大量软信号直接自动升级。

## 13.4 不属于模型能力失败

以下错误不得直接触发能力升级：

- 401 / 403；
- 429；
- 5xx；
- Provider Timeout / Overload；
- 网络中断；
- 缺少依赖；
- 权限不足；
- 磁盘不足；
- 端口占用；
- 测试环境未启动；
- 文件确实不存在且模型尚未重复执迷；
- Tool 协议转换错误；
- Responses / Messages 格式转换错误；
- Thinking / Reasoning 字段不兼容；
- 上下文超限；
- Usage 解析缺失。

## 13.5 阻塞后的动作

```text
标记当前 Segment blocked
→ 构造 Failure Evidence
→ 创建新 Segment
→ 重新 Judge
→ Route Decision 只允许保持或升级
```

升级后，本 Task 当前工作链的最低质量等级随之提高，直到出现新的实质性外部输入、新 Task 或明确 Planning 临时覆盖结束后的新 Segment。

## 14. 上游、协议和环境错误处理

## 14.1 Provider / Channel Error

包括：

- 429；
- 5xx；
- Timeout；
- Provider Overload；
- 网络错误。

动作：

- 记录 Execution Attempt；
- 不重新 Judge；
- 不改变难度；
- 第一阶段按当前既定行为返回错误或使用已明确设计的服务恢复；
- 同模型不同渠道切换属于后续 Phase，不在本文第一期核心范围内。

## 14.2 Protocol Compatibility Error

第一期只维护轻量兼容矩阵：

- Responses；
- Messages；
- Streaming；
- Tool Calling；
- Thinking / Reasoning；
- Context Window；
- Usage 解析。

不支持的 Execution Profile 在执行前从候选池过滤，不建设复杂自动协议修复系统。

## 14.3 Environment Error

环境错误保存为 Evidence 并返回客户端，不自动升级模型。

## 15. 显式模型、acu-auto 与 acu-high

### 15.1 显式模型

用户指定具体模型时：

- 不运行 Judge；
- 不运行 ACU 模型路由；
- 不替换成其他模型；
- 第一阶段不自动切换渠道；
- 仍保存完整请求、响应、成本和错误记录。

### 15.2 acu-auto

- 运行事件驱动 Judge；
- 使用 Task 基础质量偏好；
- 通过模型曲线、成本、风险和白名单选择 Execution Profile；
- 同一 Segment 保持或升级。

### 15.3 acu-high

- 与 `acu-auto` 使用同一状态机；
- 基础质量偏好可设为 92；
- 质量权重和不确定性惩罚更高；
- 不是某个固定最贵模型的别名。

## 16. 质量基准与成本记录

### 16.1 显式模型

不计算 ACU 节省率，只记录实际成本。

### 16.2 acu-auto / acu-high

质量上界定义为：

> 当前用户白名单、协议兼容性和任务难度下，预计质量最高的可用 Execution Profile。

记录：

- `actual_total_cost`；
- `quality_ceiling_counterfactual_cost`；
- `quality_gap_vs_ceiling`；
- `cost_reduction_vs_ceiling`。

所有前端、Trace 和 Ledger 必须使用相同的质量上界定义、价格版本和预计输出长度口径。

## 17. PostgreSQL 最小持久化对象

状态机实现至少需要：

- `acu_sessions`；
- `acu_tasks`；
- `acu_client_turns`；
- `acu_routing_segments`；
- `acu_steps`；
- `acu_tool_events`；
- `acu_execution_attempts`；
- `acu_judge_evaluations`；
- `acu_route_decisions`；
- `acu_outcome_evidence`；
- `acu_ledger_entries`；
- `acu_raw_protocol_requests`；
- `acu_raw_protocol_responses`。

第一期保存完整输入、输出和过程数据，不运行自动定时删除任务。

## 18. 核心伪代码

```text
handle_native_request(request):
    persist_raw_request(request)

    if request.model is explicit_model:
        execute_without_judge(request)
        persist_step_attempt_response()
        return

    session = identify_or_create_session(request)
    task = identify_or_create_task(session, request)
    event = classify_incremental_event(request, task)
    segment = task.active_routing_segment

    trigger = evaluate_judge_trigger(
        request=request,
        task=task,
        segment=segment,
        event=event,
        lease_valid=is_lease_valid(segment),
        evidence=recent_outcome_evidence(task)
    )

    if trigger == REUSE_ROUTE:
        decision = segment.route_decision

    else if trigger == REFILTER_ONLY:
        decision = refilter_execution_profiles(
            judge_evaluation=segment.judge_evaluation,
            minimum_quality=segment.minimum_quality_level,
            request_capabilities=request.capabilities
        )

    else:
        close_or_supersede(segment, trigger.reason)
        new_segment = create_routing_segment(task, trigger.reason)
        envelope = build_judge_context_envelope(request, task, new_segment)
        evaluation = run_llm_judge(envelope)
        decision = select_route(evaluation, new_segment.constraints)
        persist_evaluation_and_decision()

    attempt = execute(decision.execution_profile, request)
    persist_step_attempt_response(attempt)
    evidence = extract_deterministic_evidence(request, attempt)
    update_task_phase_segment_lease(evidence)
```

## 19. 第一阶段验收场景

### 场景 A：同一任务正常多 Step

- 首 Step 调用 Judge；
- Read / Search / Edit / Test 连续发生；
- 未出现高置信度阻塞；
- 后续 Step 不重复调用 Judge；
- Execution Profile 保持稳定。

### 场景 B：用户输入“请继续”

- 创建新的 Segment；
- 重新调用 Judge；
- Judge 输入包含原始 Task、Plan、最近 Step、成功 / 失败和当前 Profile；
- 不只评估“请继续”三个字。

### 场景 C：Planning 临时提高质量

- 识别 Planning 开始；
- 创建 Planning Segment；
- 质量偏好至少 88；
- Planning 连续 Step 保持同一较强 Profile。

### 场景 D：Planning 明确结束

- 创建 Execution Segment；
- 重新 Judge 执行阶段；
- 临时质量覆盖结束；
- 允许恢复 Task 基础偏好；
- 如果结束信号不可靠，则不自动回落。

### 场景 E：第一次测试失败

- 不升级；
- 记录 Failure Signature；
- 当前模型继续处理。

### 场景 F：同一核心错误连续无改善

- 达到规则阈值；
- 标记 capability block；
- 创建新 Segment 并重新 Judge；
- 只允许保持或升级。

### 场景 G：上游 429 / Timeout

- 不重新 Judge；
- 不改变难度；
- 记录 Provider Error；
- 按第一期既定服务行为处理。

### 场景 H：Goal 模式自动继续

- 没有人类新输入；
- 上下文和工具因果关系连续；
- 不因为内部 Turn 变化而重复 Judge；
- 新 Goal / Replanning / 阻塞出现时才创建新 Segment。

### 场景 I：10 分钟无活动后恢复

- Session 和 Task 保持；
- 原 Segment Lease 过期；
- 下一次请求重新 Judge；
- Judge 读取此前完整任务状态。

### 场景 J：用户指定具体模型

- 不运行 Judge；
- 不替换模型；
- 保存完整轨迹和实际成本。

## 20. 第一阶段明确不做

- 不为每个 Step 调用 Judge；
- 不使用 Embedding 或本地模型识别 Session；
- 不训练独立的失败分类器；
- 不因为一次测试失败自动升级；
- 不因为单独出现 `plan` 单词自动提高质量；
- 不按 Read / Search / Edit 单个工具动作切换模型；
- 不在 Planning 结束后无条件换便宜模型；
- 不对显式模型自动切换模型或渠道；
- 不建设复杂协议自动修复层；
- 不运行周期性定时 Judge；
- 不运行定时自动数据删除。

## 21. 开工前协议侦察清单

实现状态机前，需要采集原生 Codex 和 Claude Code 样本并更新本文件中的可验证字段：

- Session / Thread / Response 关联字段；
- Goal / Continuation 表示；
- Plan 开始、更新和结束信号；
- Tool Call / Result ID 关系；
- 人类输入与 Tool Result 的可靠区分；
- Responses Input Item 和历史管理方式；
- Claude Messages / Thinking 历史方式；
- Streaming 事件；
- Usage、Reasoning Token 和缓存 Token；
- New API 透传或转换后的实际差异。

协议侦察完成后，应把“待确认”信号替换为真实字段和 Fixture，并为每种客户端建立回归测试。