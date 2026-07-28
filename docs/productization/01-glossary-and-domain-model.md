# ACU Router 产品化领域模型与术语

> 状态：Productization Phase 0 已确认设计基线  
> 版本：v0.2  
> 日期：2026-07-29  
> 适用范围：New API + ACU Router，首批原生 Codex / Claude Code 用户

## 1. 文档目的

本文件定义 ACU Router 产品化过程中的核心对象、术语、关系和系统不变量，避免把以下概念混为一谈：

- 一次客户端持续对话；
- 一个持续任务或 Goal；
- 客户端内部的一轮交互；
- 一段可以共享路由判断的连续模型调用；
- 一次真实上游模型请求；
- 一次工具调用及其结果；
- 一次任务难度评估；
- 一次执行配置选择；
- 一次实际执行或失败尝试。

本文件是后续数据库、接口、状态机和模块设计的共同语义基础。

## 2. 已确认的产品边界

### 2.1 客户端

第一期只以原生客户端实际发送的 API 请求为事实来源：

- OpenAI Codex，对应 OpenAI Responses 风格请求；
- Claude Code，对应 Anthropic Messages 风格请求。

ACU 不要求用户修改客户端、添加自定义 Header 或主动上报额外字段。客户端传来什么，系统就基于什么进行识别、路由和记录。

### 2.2 用户模型入口

第一期对用户暴露：

- 指定具体模型；
- `acu-auto`；
- 可选的 `acu-high`，默认质量偏好参数可设为 92。

用户指定具体模型时：

- 不运行 LLM Judge；
- 不替换成其他模型；
- 第一阶段也不自动切换渠道；
- 仅由 New API 完成鉴权、额度和既定渠道转发。

### 2.3 平台分工

**New API 控制面负责：**

- 用户账户；
- API Key；
- 兑换码与余额；
- 模型目录和渠道配置；
- 基础鉴权、限额、扣费和使用记录。

**ACU 数据与决策面负责：**

- 原生协议请求解析；
- Session / Task / Routing Segment / Step 识别；
- Judge 上下文构造；
- 难度评估；
- 模型质量曲线与价值路由；
- 执行配置选择；
- 路由状态和失败升级；
- 完整输入、输出、工具轨迹、成本和结果记录。

ACU 完整轨迹数据保存在本地 PostgreSQL。第一期不实现自动定时删除；保留策略、人工删除和后续管理方式另行设计。

## 3. 核心领域对象

### 3.1 User

New API 中的用户账户。

主要属性：

- `user_id`；
- 账户状态；
- 余额；
- 可用模型范围；
- 创建时间。

### 3.2 API Key

用户调用平台的凭证，也是数据隔离和策略生效的基础边界。

主要属性：

- `api_key_id`；
- `user_id`；
- 状态；
- 余额或额度约束；
- 模型白名单 / 黑名单；
- 是否允许 `acu-auto`；
- 是否允许 `acu-high`。

### 3.3 Provider / Channel

上游模型供应渠道。第一批包括：

- OpenRouter；
- CloseAI；
- 后续可新增其他兼容渠道。

Channel 是执行配置的一部分。同一个模型通过不同渠道调用，价格、延迟、可用性和协议兼容性可能不同。

### 3.4 Native Protocol Request

原生 Codex 或 Claude Code 发给平台的一次请求。

它是 ACU 最重要的原始事实来源，可能包含：

- System / Developer 指令；
- Input Items 或 Messages；
- 历史 Assistant 内容；
- Tool / Function 定义；
- Tool Call / Tool Result；
- Reasoning / Thinking 可见内容；
- Response 关联字段；
- Streaming 配置；
- Token 与协议参数。

ACU 不假定所有客户端都提供相同的 Session 字段，也不假定用户会提供额外标识。

### 3.5 Session

一次原生 Codex 或 Claude Code 的持续对话或线程容器。

一个 Session 可以：

- 包含多个 Task / Goal；
- 包含多次真实用户输入；
- 包含 Goal 模式下没有新的人类输入、但由客户端继续生成的内部交互；
- 被暂停后恢复；
- 持续数十分钟或更长时间。

Session 是对话身份，不等同于：

- 一个任务；
- 一次难度评估；
- 一个固定模型；
- 10 分钟路由有效期。

### 3.6 Task / Goal

Session 中语义上相对连续的目标。

示例：

> 修复认证模块中的 Refresh Token 失效问题，并保持旧 Token 兼容。

后续“请继续”通常仍属于同一个 Task。后续“重构整个权限系统并加入多租户支持”可能是：

- 新 Task；或
- 原 Task 的显著扩展。

第一期不要求规则完全准确地切分所有 Task。无法确认时，系统应优先保留完整上下文并重新 Judge，而不是静默沿用低难度判断。

### 3.7 Client Turn

客户端或对话协议内部的一轮交互。

Turn 保留为观察和记录术语，但**不作为 ACU 的核心路由锁定单位**，原因包括：

- 人类输入可以触发一个 Turn；
- Goal 模式可能在没有新的人类输入时创建多个内部 Turn；
- Anthropic 协议中的 `tool_result` 可能使用 `user` 角色，但并非人类输入；
- 不同客户端对 Turn 的定义可能不同。

### 3.8 Routing Segment

ACU 的核心路由单位。

Routing Segment 表示：

> 一段连续共享基础难度评估、阶段状态、质量策略和当前执行配置的 Step 序列。

同一 Routing Segment 内：

- 多个 Step 默认复用同一次 Judge Evaluation；
- 默认复用同一个 Execution Profile；
- 自动路由只允许保持或升级，不允许降级；
- 普通 Read / Search / Edit / Tool Result 不触发重新 Judge；
- 一次普通失败不立即触发升级。

可能创建新 Routing Segment 的事件：

- 新的实质性外部输入；
- 新 Goal 或目标明显变化；
- Planning 开始；
- Replanning 开始；
- Planning 明确结束并进入 Execution；
- 高置信度能力阻塞；
- Routing Lease 过期；
- 当前 Execution Profile 不再满足硬兼容要求。

### 3.9 Step

一次实际发往上游模型的推理请求。

一个 Routing Segment 可包含多个 Step，例如：

1. 模型分析任务并请求读取文件；
2. 模型接收 Tool Result 后继续搜索；
3. 模型形成计划；
4. 模型编辑代码；
5. 模型读取测试失败并继续修复。

Step 是成本、延迟、上游响应和执行轨迹的基本记录单位。

### 3.10 Tool Event

一次工具相关事件，包括：

- Tool Call；
- Tool Result；
- Function Call；
- Function Call Output；
- Read；
- Search；
- Edit / Write；
- Bash / Shell；
- Test；
- Build；
- Patch；
- 其他原生客户端工具事件。

Tool Result 不自动创建新 Task 或 Routing Segment。

### 3.11 Execution Profile

ACU 实际路由和比较的最小执行单位，不只是模型名。

一个 Execution Profile 至少由以下部分构成：

```text
模型
+ 上游渠道
+ Thinking / Reasoning 配置
+ 原生协议兼容能力
+ 上下文能力
+ 其他影响成本、质量或延迟的执行参数
```

示例：

```text
GPT-5.6 / CloseAI / medium reasoning
GPT-5.6 / OpenRouter / medium reasoning
Qwen 3.6 Plus / CloseAI / non-thinking
```

同一模型的不同渠道或思考深度，应视为不同 Execution Profile。

### 3.12 Execution Attempt

一次对某个 Execution Profile 的实际调用尝试。

主要结果：

- `success`；
- `timeout`；
- `provider_error`；
- `protocol_error`；
- `environment_error`；
- `capability_failure_candidate`；
- `cancelled`。

一个 Step 在未来可能包含多个 Execution Attempt，例如同模型不同渠道重试；第一期显式模型不自动切换渠道。

### 3.13 Task Phase

Task 或 Routing Segment 当前工作阶段。

第一期使用以下枚举作为观察和规则输入：

- `understanding`；
- `planning`；
- `execution`；
- `verification`；
- `repair`；
- `blocked`；
- `completed`；
- `unknown`。

Phase 由原生协议、工具轨迹和确定性规则识别，不由用户手动选择。

### 3.14 JudgeContextEnvelope

发送给 LLM Judge 的统一上下文载体。

第一期由两类信息组成：

#### A. 当前原生 API 输入

尽量完整保留客户端实际传来的：

- System / Developer 指令；
- Messages / Input Items；
- Tool 定义；
- Tool Call / Tool Result；
- Reasoning / Thinking 可见内容；
- 最新输入和历史上下文。

#### B. ACU 本地确定性补充

不依赖本地模型，只使用 PostgreSQL 记录和规则可直接提取的信息：

- Session / Task / Routing Segment 标识；
- Task 初始目标；
- 上一次 Judge Evaluation；
- 上一次 Route Decision；
- 当前活动 Plan；
- 当前 Execution Profile；
- 最近 Step；
- 最近 Tool Event；
- 最近测试和 Build 结果；
- 成功 / 失败计数；
- 重复错误签名；
- 用户不满意、重试或认可信号；
- 已发生的升级历史；
- 当前 Phase。

Judge 的问题不是“最新三个字难不难”，而是：

> 在当前任务、历史进展、最近结果、最新输入和现有计划下，接下来所需的最低充分能力与风险水平是什么？

### 3.15 Judge Evaluation

一次对“接下来所需能力”的评估。

第一期暂时合并两个未来可拆分的职责：

1. **Q-Context**：理解当前任务状态、阶段、进展和失败；
2. **Q-Difficulty**：评估下一 Routing Segment 的能力需求与难度。

主要字段建议包括：

- `judge_evaluation_id`；
- `session_id`；
- `task_id`；
- `routing_segment_id`；
- `context_hash`；
- `difficulty_score_raw`；
- `difficulty_index`；
- 六项难度因子；
- 能力档位概率；
- `confidence`；
- 识别的 Task Phase；
- 关键证据；
- 对过去成功 / 失败的解释；
- 是否建议保持、提高或重新选择质量水平；
- Judge 模型、Prompt 版本、Token、成本和延迟。

用户“请继续”、用户强烈不满意、测试反复失败等信号，不直接由规则硬加固定难度分，而作为证据交给 Judge 综合判断。

### 3.16 Route Decision

基于 Judge Evaluation 和执行约束形成的选择结果。

输入至少包括：

- Judge Evaluation；
- 模型难度—质量曲线；
- 用户 / API Key 模型白名单；
- 协议、Tool、Vision、Context 等硬兼容条件；
- Execution Profile 健康状态；
- 价格；
- `acu-auto` 或 `acu-high` 质量偏好；
- 同一 Segment 只允许保持或升级的约束。

输出至少包括：

- 推荐 Execution Profile；
- 质量上界 Execution Profile；
- 预计分数与不确定性；
- 预计调用成本；
- Judge 成本；
- 相对质量上界的反事实成本差；
- 选择原因；
- 候选过滤原因；
- 策略版本。

### 3.17 Routing Lease

Judge Evaluation 和 Route Decision 在连续 Step 中的有效租约。

第一期规则：

- 任意有效活动都会更新 `last_activity_at`；
- 有效活动包括模型请求、流式响应、Tool Call、Tool Result、用户输入或其他可确认的客户端事件；
- 相邻有效活动间隔不超过 10 分钟，且没有其他触发器时，复用当前 Routing Segment；
- 超过 10 分钟后，Session 和 Task 不自动结束，但当前 Routing Lease 过期；
- 下一次模型请求重新构造 JudgeContextEnvelope 并运行 Judge。

### 3.18 Outcome Evidence

用于描述任务进展和结果的结构化证据。

可能包括：

- 测试通过 / 失败；
- Build 通过 / 失败；
- Patch 成功 / 失败；
- Tool 调用成功 / 失败；
- 错误签名变化；
- 重复错误次数；
- 用户明确满意 / 不满意；
- 用户重试；
- 用户要求重新处理；
- 任务完成或放弃。

Outcome Evidence 是 Judge 上下文、未来训练数据和路由评估的重要组成部分。

### 3.19 Ledger Entry

一次 Step 或 Execution Attempt 的成本与用量记录。

至少记录：

- 用户、API Key、Session、Task、Segment、Step；
- 请求协议；
- 指定模型或 ACU 模式；
- 推荐与实际 Execution Profile；
- 输入、输出、Reasoning、缓存 Token；
- Judge 成本；
- 上游实际成本；
- 失败尝试成本；
- 总成本；
- 质量上界反事实成本；
- 相对质量上界成本下降；
- 延迟；
- Usage 来源和价格版本。

对于 `acu-auto` / `acu-high`，所谓“节省”必须明确表述为：

> 相对当前白名单和任务难度下的质量上界 Execution Profile 的反事实成本下降。

用户指定具体模型时，不计算 ACU 节省率。

## 4. 对象关系

```text
User
└── API Key
    └── Session
        ├── Task / Goal
        │   └── Routing Segment
        │       ├── Step
        │       │   ├── Tool Event
        │       │   └── Execution Attempt
        │       ├── Judge Evaluation
        │       ├── Route Decision
        │       └── Outcome Evidence
        └── Ledger Entry
```

注意：Client Turn 可以与 Task、Routing Segment 交叉，不作为严格父子关系。

## 5. 系统不变量

1. 原生客户端请求是上下文事实的第一来源。
2. 系统不得要求原生 Codex / Claude Code 用户提供自定义字段才能正常工作。
3. 用户指定具体模型时不运行 Judge，也不替换模型。
4. 只有 `acu-auto` / `acu-high` 执行任务级路由。
5. 同一 Routing Segment 中的多个 Step 默认共享 Judge Evaluation 和 Execution Profile。
6. 同一 Routing Segment 内自动路由只允许保持或升级，不允许降级。
7. Planning 的临时质量覆盖结束并创建新 Segment 后，可以恢复 Task 的基础质量偏好；这不视为同一 Segment 内降级。
8. 新的实质性用户输入，包括“请继续”，可触发重新 Judge，但 Judge 必须读取完整任务上下文，而不是只评估最新短文本。
9. Tool Result 不等于人类输入。
10. Goal 模式中的客户端内部 Turn 变化，不必然创建新 Routing Segment。
11. 上游 429、5xx、Timeout 等不改变任务难度，不触发 Judge。
12. 硬协议或上下文不兼容可以重新过滤候选，不必重新评估任务难度。
13. 一次普通测试失败不直接判定为模型能力失败。
14. 完整输入、输出、过程和成本保存在本地 PostgreSQL。
15. 第一阶段不运行自动定时数据删除任务。
16. 模型本身不被假定拥有跨 API 请求的长期记忆；连续性来自客户端或服务端再次提供的上下文。

## 6. 模型目录与自动路由资格

第一期可以展示并允许显式调用 CloseAI / OpenRouter 中已配置的模型。

但“可显式调用”和“可参与 ACU 自动路由”必须分开。

### 6.1 可显式调用

只要 New API 渠道已配置且调用可用，即可进入用户模型目录。

### 6.2 可参与自动路由

Execution Profile 需要同时满足：

- 已有难度—质量曲线；
- 当前渠道可调用；
- 当前原生协议兼容；
- Tool / Streaming / Context 等硬能力满足；
- 价格和 Usage 解析明确；
- 健康状态允许；
- 用户和 API Key 白名单允许。

## 7. 第一阶段明确不做

- 不训练独立的 Session 识别模型；
- 不训练能力失败识别模型；
- 不使用本地模型总结 Judge 上下文；
- 不要求用户修改原生 Codex / Claude Code；
- 不在显式模型模式下运行 Judge；
- 不在显式模型模式下自动替换模型；
- 不在第一阶段自动切换显式模型的渠道；
- 不在 Planning 结束后无条件切换到便宜模型；
- 不实现定时自动删除完整轨迹数据；
- 不把 New API 和 ACU 的所有数据强行写入同一套业务表。

## 8. 需要通过真实协议采集确认的事项

以下内容在实现前必须用原生 Codex 和 Claude Code 流量验证：

- Codex 是否稳定传递 `previous_response_id` 或其他线程关联字段；
- Claude Code 是否有可透传的 Session 标识；
- Goal / Continuation 在请求中的实际表示；
- Codex Plan 工具和 Plan 状态的实际协议形态；
- Claude Code Plan 模式在网关请求中的可观察信号；
- Tool Call / Tool Result 的稳定 ID 关联方式；
- Reasoning / Thinking 内容跨 Step 的保留方式；
- Streaming 事件与 Usage 的实际结构；
- New API 对 Responses 和 Messages 的透传、转换和错误行为。

这些是协议侦察阶段的事实任务，不应由产品文档提前猜定。