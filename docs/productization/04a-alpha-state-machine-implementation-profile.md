# ACU Router 五日 Alpha 状态机实施剖面

> 状态：五日 Alpha 开发的实施约束  
> 版本：v0.1  
> 日期：2026-07-29  
> 上位规范：`04-session-task-routing-segment-state-machine-v2.md`  
> 适用范围：3—10 名邀请制 OPC 程序员，原生 Codex / Claude Code，经 New API 接入 ACU

## 1. 文档目的

`04-session-task-routing-segment-state-machine-v2.md` 是完整产品语义规范，用于保证长期设计一致性；它不是要求五日 Alpha 一次实现全部状态、规则和持久化对象。

本文件将完整规范压缩为五日开发必须落地的最小闭环，回答：

1. 五日内必须识别哪些协议事件；
2. 哪些状态必须真实持久化；
3. 哪些事件必须重新 Judge；
4. 哪些复杂规则暂不实现；
5. Alpha 通过验收的最小场景是什么。

发生冲突时：

- 产品语义以 04 v2 为准；
- 五日开发范围和优先级以本文件为准；
- 本文件未实现的 04 v2 规则视为延期，不得伪装成已支持。

## 2. 五日 Alpha 的核心目标

五日版本只证明以下闭环：

```text
原生 Codex / Claude Code
→ New API 鉴权与余额
→ ACU 识别连续任务状态
→ 必要时运行 Judge
→ 选择并锁定 Execution Profile
→ 透传 Tool / Streaming
→ 记录实际模型、Attempt、Usage 和成本
→ 后续正常 Step 复用 Route
→ 在少数高置信度事件下重新评估
```

五日版本不追求完美理解任意 Coding Agent 轨迹，也不追求实现完整自治工作流引擎。

## 3. Alpha 必须实现的最小对象

### 3.1 Session

必须保存：

- `session_id`；
- 用户 / API Key；
- 客户端与协议；
- 规范化历史链 Hash；
- 最近 Tool Call ID；
- `last_activity_at`；
- `active / dormant`；
- 当前 `task_id`；
- 当前 `segment_id`。

实现约束：

- 30 分钟仅使用惰性过期检查，不实现后台 Session 定时任务；
- 以历史前缀、Tool ID 因果关系和可信身份组合识别连续性；
- 不把工作目录或单个 Session Header 当作唯一主键；
- 连续性不确定时创建新 Session并重新 Judge。

### 3.2 Task

Alpha 采用“一次 Session 同时只有一个活动 Task”的简化规则。

必须保存：

- `task_id`；
- `session_id`；
- 初始目标或首个高置信度 HumanMessage；
- 当前阶段；
- 基础质量偏好；
- 能力升级下限；
- 创建和更新时间。

Alpha 不实现独立语义 Task 切分器。

仅在以下情况创建新 Task：

1. 新 Session；
2. 客户端出现明确 Reset / New Goal 信号；
3. 新 HumanMessage 明确替换原目标，且规则置信度高；
4. 连续性无法确认，按安全规则拆分。

“继续”“补充约束”“重做”“还是不行”默认延续当前 Task。

### 3.3 Routing Segment

Routing Segment 是 Alpha 必须真实持久化的核心路由对象。

必须保存：

- `segment_id`；
- `task_id`；
- 创建原因；
- 阶段：`execution / planning / recovery / resume / availability_recovery`；
- Judge Evaluation 引用；
- Route Decision 引用；
- 锁定的 Execution Profile；
- 基础质量、能力下限和临时覆盖快照；
- `last_activity_at`；
- `active / superseded / lease_expired / blocked / completed`。

实现约束：

- 同一 Task 只允许一个活动 Segment；
- 普通 Tool 循环复用当前 Segment；
- 同一 Segment 不自动换模型；
- 同模型等价 Channel 的实际 Attempt 变化不创建新 Segment；
- 实际模型必须变化时创建新 Segment。

### 3.4 Event

Alpha 只要求稳定产生以下七类标准事件：

1. `human_message`；
2. `tool_call`；
3. `tool_result`；
4. `plan_started`；
5. `plan_finished`；
6. `execution_failure`；
7. `provider_error`。

`retry_attempt` 作为 Attempt 属性记录，不要求进入完整业务事件状态机。

每个事件至少保存：

- 类型；
- Session / Task / Segment 候选；
- 原始协议证据引用；
- Tool / Call ID；
- 事件 Hash；
- 是否重复；
- 证据强度；
- 时间。

### 3.5 Attempt

每次真实上游调用必须单独记录：

- `attempt_id`；
- 逻辑请求或 Step 关联；
- Provider / Channel；
- 请求模型与实际模型；
- 上游 Request ID；
- 状态；
- Usage；
- 成本；
- 错误类别；
- Retry Owner；
- 开始和结束时间。

客户端或 New API 的重试只能新增 Attempt，不得重复创建 Judge、Segment 或逻辑结果。

### 3.6 Step

Step 保留为领域概念，但 Alpha 不要求先实现完整七状态 Step 工作流或独立复杂 Step 引擎。

最小实现允许：

- 根据已接受的 Model Response 创建 `step_id`；
- 用 Tool Call ID 关联其 Tool Result；
- 保存 `open / closed / cancelled / unresolved` 四种状态；
- 历史重发不得重复创建 Step；
- Retry 不得创建新 Step。

多 Tool Call、长期 unresolved 和复杂 Resume 的完整清理规则延期。

## 4. Alpha 必须识别的协议事实

### 4.1 Codex Responses

必须支持：

- `/v1/responses`；
- 增长的 Responses Item 历史；
- `function_call.call_id`；
- `function_call_output.call_id`；
- Streaming；
- Usage；
- 实际 `update_plan`。

不依赖 `previous_response_id`。

### 4.2 Claude Messages

必须支持：

- `/v1/messages`；
- 增长的 Messages 历史；
- `tool_use.id`；
- `tool_result.tool_use_id`；
- Thinking / Signature 透传；
- Streaming；
- Usage；
- 版本门控的 Plan-only 指纹；
- 实际 `ExitPlanMode`。

必须先从 `role=user` 内容中拆出 `tool_result`，不能直接把整个 user Role 视为 HumanMessage。

## 5. Alpha 的 Judge 触发器

只有以下事件重新 Judge：

1. 新 `acu-auto` / `acu-high` Task 的首个请求；
2. 高置信度 `human_message`；
3. `plan_started`；
4. 相同核心 Failure Signature 第二次出现且无明确进展；
5. 用户明确拒绝或要求重做，由 `human_message` Evidence 标记；
6. 10 分钟 Routing Lease 过期后的下一次请求；
7. dormant Session Resume；
8. 当前 Execution Profile 因硬兼容条件失效，且需要换模型。

以下事件不重新 Judge：

- 普通 Tool Call；
- 正常 Tool Result；
- Agent 自动继续；
- 普通 Model Response；
- 第一次 Execution Failure；
- Failure Signature 已变化或明确改善；
- Provider 429、5xx、Timeout；
- Retry Attempt；
- Plan 内部状态更新；
- Plan Finished 且没有新能力需求。

## 6. Alpha 的 Segment 边界

### 6.1 创建新 Segment

Alpha 只实现以下创建原因：

- `task_start`；
- `human_message`；
- `planning_start`；
- `planning_end`；
- `first_failure_recovery`；
- `capability_block`；
- `lease_expired`；
- `resume`；
- `availability_recovery`。

### 6.2 Planning

Planning 开始：

- Codex 实际 `update_plan`；
- Claude Plan-only 版本化指纹。

动作：

- 结束当前 Segment；
- 创建 Planning Segment；
- 重新 Judge；
- 临时质量覆盖暂定为 88。

Planning 结束：

- Claude 实际 `ExitPlanMode`；
- Codex Plan 完成并出现执行转移强证据。

动作：

- 创建 Execution Segment；
- 撤销 Planning 临时覆盖；
- 默认复用最近 Judge Evaluation；
- 仅出现重大新范围或约束时再次 Judge。

Alpha 不实现基于 Read / Search 比例、单词 plan 或自然语言计划的弱信号自动切换。

### 6.3 Failure

第一次确定性执行失败：

- 记录 Failure Signature；
- 创建 Recovery Segment；
- 继承原 Judge Evaluation 和模型；
- 不重新 Judge；
- 不提高能力下限。

相同核心 Failure Signature 第二次出现且无进展：

- 标记 `capability_block`；
- 创建新 Segment；
- 重新 Judge；
- 只允许保持或升级；
- 由新 Evaluation 决定是否提高能力下限。

Alpha 只实现“标准化错误签名 + 重复次数 + 是否改善”规则。

以下高级阻塞识别延期：

- 修改—撤销振荡；
- 虚构符号持续引用；
- 语义等价但文本不同的复杂错误聚类；
- 大量 Read / Search 无进展；
- 多错误之间的因果图。

### 6.4 Lease

- Session idle lease：30 分钟；
- Routing Segment lease：10 分钟；
- 均采用请求到达时惰性判断；
- 不实现后台扫描；
- 有效 Streaming、Model Response、ToolCall、ToolResult、HumanMessage 更新活动时间；
- 租约过期不删除历史。

## 7. Alpha 明确不实现

1. 独立 Task 语义切分模型；
2. Embedding Session 匹配；
3. 完整 Client Turn 状态机；
4. 完整七状态 Step 引擎；
5. 后台 Session / Segment 定时任务；
6. 弱信号自主 Planning 推断；
7. 复杂阻塞分类器；
8. Completed 置信度引擎；
9. 多 Agent / Subagent 专用状态模型；
10. 自动 Context Compaction；
11. 用户可调连续质量分；
12. 显式模型自动替换；
13. 因成本或一次成功自动降级；
14. 9B Router 训练；
15. 大规模生产级状态修复工具。

## 8. Alpha 实施优先级

### P0：没有则不能上线测试

1. Responses 与 Messages 原生入口；
2. Streaming 和 Tool ID 透明透传；
3. 显式模型跳过 Judge；
4. `acu-auto` 首请求 Judge + Route；
5. 当前 Segment 路由复用；
6. HumanMessage 与 ToolResult 区分；
7. Planning 强信号；
8. Attempt / Retry 独立记录；
9. PostgreSQL 基础持久化；
10. New API 鉴权身份和最终 Usage / 成本关联。

### P1：首批用户使用期间补齐

1. 第一次失败 Recovery Segment；
2. 重复错误签名后重新 Judge；
3. Session / Segment 惰性 Lease；
4. dormant Resume；
5. 同模型等价 Channel 可用性恢复；
6. 管理员轨迹查询。

### P2：Alpha 后评估

1. 复杂 Task 拆分；
2. 弱 Planning 识别；
3. 高级 Failure 规则；
4. 自动模型降级；
5. 多 Agent 状态；
6. 数据驱动 Q-Context / Q-Difficulty 训练。

五日开发只承诺完成 P0。P1 仅在 P0 全链路通过后实施，不得为了状态机完整性牺牲原生协议、扣费和基础路由的正确性。

## 9. 最小验收场景

1. 显式模型请求完整透传，Judge 调用数为 0；
2. `acu-auto` 首请求调用一次 Judge并产生 Route Decision；
3. Codex Tool Call / Output 连续循环复用同一 Segment；
4. Claude `role=user` 仅含 Tool Result 时不产生 HumanMessage；
5. Claude混合 Tool Result +真实文本时正确拆分；
6. 用户输入“继续”延续 Task、新建 Segment并重新 Judge；
7. Codex 实际 `update_plan` 创建 Planning Segment；
8. Claude Plan-only / `ExitPlanMode` 创建 Planning与Execution Segment；
9. 第一次相同测试失败不升级；
10. 相同错误第二次无进展时重新 Judge且不降级；
11. New API或客户端Retry只增加Attempt；
12. 10分钟后下一次请求创建新Segment并重新Judge；
13. Streaming响应正文和Tool ID不被ACU改写；
14. 实际模型、渠道、Usage和成本可关联到同一逻辑请求；
15. ProviderError不改变任务难度。

P0 上线门槛只要求场景 1—8、11、13、14 通过；其余为 P1 验收。

## 10. 后续文档写作约束

`05`—`11` 每份文档都必须分成：

- Alpha P0；
- Alpha P1；
- 延期项；
- 验收场景。

不得把长期产品能力全部写成五日实施要求。

在正式开工前，再生成一份单独的五日执行计划，把 P0 映射到代码模块、负责人、依赖、测试和每日可验收产物。
