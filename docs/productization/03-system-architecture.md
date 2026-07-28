# ACU Router 总体系统架构与模块边界

> 状态：产品化阶段 0 架构草案，待创始人终审  
> 版本：v0.1  
> 日期：2026-07-29  
> 依赖文档：`00-product-scope.md`、`01-glossary-and-domain-model.md`、`04-session-task-routing-segment-state-machine.md`

## 1. 文档目的

本文件定义 ACU Router 1.0 Alpha 的总体系统架构、服务边界、模块职责、请求生命周期、数据流、故障边界以及现有 ClawRouter 代码的承接方式。

本文件回答：

1. New API、ACU Router Core、Provider 和 PostgreSQL 之间是什么关系；
2. 哪些能力属于 New API，哪些能力属于独立 ACU 服务；
3. 原生 Codex / Claude Code 请求如何进入系统、完成路由并返回；
4. 显式模型与 `acu-auto` 如何共用执行链路但保持不同路由语义；
5. ACU 内部需要哪些模块，以及模块之间如何通信；
6. 现有 ClawRouter 哪些代码可以承接，哪些需要重构或替换；
7. New API 如何获得实际模型、渠道、Token 和成本，又不修改客户端 API 正文；
8. 第一阶段的部署边界和技术约束是什么。

本文不是数据库字段级 Schema、协议字段清单或单模块开发任务书。详细设计由后续 `05`—`10` 文档展开。

## 2. 已确认的架构决策

### 2.1 New API 是公网入口和用户控制面

用户使用原生 Codex 或 Claude Code，通过平台 Base URL 直接访问 New API。

New API 负责：

- 用户账户；
- API Key；
- 兑换码和余额；
- 模型目录；
- 基础额度、限流和请求准入；
- 用户网页使用记录；
- 最终扣费；
- 将经过鉴权的原生请求转发给 ACU Router Core。

New API 不负责：

- 任务难度判断；
- Session / Task / Routing Segment 识别；
- Planning 识别；
- 模型难度—质量曲线；
- ACU 价值路由；
- 模型能力阻塞识别；
- 完整 Coding Agent 轨迹存储。

### 2.2 ACU Router Core 是独立服务

ACU 逻辑不全部写入 New API。

ACU Router Core 作为独立服务运行，负责：

- 接收 New API 转发的原生请求；
- 保存原始请求；
- 识别协议、Session、Task、Routing Segment 和 Step；
- 对 `acu-auto` / `acu-high` 构造 JudgeContextEnvelope；
- 运行 Judge；
- 执行候选过滤、质量曲线计算和 Route Decision；
- 调用 OpenRouter、CloseAI 及未来 Provider；
- 转发 Streaming、Tool Calling、Reasoning / Thinking 和原生响应；
- 保存完整响应、工具轨迹、成本和结果证据；
- 向 New API 上报可信的实际用量与成本。

独立服务不等于拆成大量微服务。第一阶段采用：

> **一个独立部署、内部模块化的 ACU Router Service。**

后续只有在流量、团队和部署需求明确时，再拆分 Judge、执行器或数据服务。

### 2.3 所有模型请求都经过 ACU 数据面

包括：

- 用户显式指定模型；
- `acu-auto`；
- 可选的 `acu-high`。

原因：

- 显式模型虽然不运行 Judge，但仍需统一协议处理、上游执行、完整数据记录和成本账本；
- 如果显式模型绕过 ACU，将形成两套执行、日志和计费链路；
- ACU 需要同时观察显式模型与自动路由的真实任务分布。

显式模型路径只跳过 Judge 和模型路由，不跳过 ACU 执行与数据记录。

### 2.4 客户端响应保持原生协议

ACU 和 New API 不向模型正文、Tool Result 或 SSE 事件中注入路由说明。

- Codex 请求保持 Responses 兼容响应；
- Claude Code 请求保持 Messages 兼容响应；
- 现有 Chat Completions 能力可以继续保留；
- 用户实际模型、渠道和成本在 New API 网页使用记录中展示；
- 内部账单信息通过可信内部接口传递，不依赖修改客户端正文。

## 3. 总体部署拓扑

```text
┌──────────────────────────────────────────────┐
│ 用户本地                                      │
│                                              │
│  原生 Codex              原生 Claude Code    │
└───────────────┬──────────────────┬───────────┘
                │ HTTPS            │ HTTPS
                └──────────┬───────┘
                           ↓
┌──────────────────────────────────────────────┐
│ New API：公网控制面与北向网关                 │
│                                              │
│ - 用户 / API Key / 兑换码 / 余额              │
│ - 请求鉴权、准入、额度预留                     │
│ - 模型目录、使用记录和网页前台                 │
│ - 将原生请求转发到 ACU                        │
│ - 接收 Usage Report 并完成最终扣费             │
└───────────────────────┬──────────────────────┘
                        │ 内网 HTTPS
                        │ 原始协议请求 + 可信身份上下文
                        ↓
┌──────────────────────────────────────────────┐
│ ACU Router Service：独立数据面                │
│                                              │
│  Protocol Ingress                            │
│       ↓                                      │
│  Conversation / Task State Engine            │
│       ↓                                      │
│  Trigger Engine                              │
│       ↓                                      │
│  Judge Context + Judge Service               │
│       ↓                                      │
│  Catalog / Curve / Route Decision            │
│       ↓                                      │
│  Execution Orchestrator                      │
│       ↓                                      │
│  Provider Adapters + Stream Relay             │
└─────────────┬──────────────────────┬─────────┘
              │                      │
              ↓                      ↓
┌─────────────────────┐   ┌─────────────────────┐
│ OpenRouter          │   │ CloseAI             │
│ 后续兼容 Provider    │   │ 后续兼容 Provider    │
└─────────────────────┘   └─────────────────────┘

                        ACU 内部读写
                              ↓
┌──────────────────────────────────────────────┐
│ PostgreSQL：ACU 任务轨迹与账本                │
│                                              │
│ - Session / Task / Segment / Step             │
│ - 原始请求和响应                              │
│ - Tool Event / Attempt                        │
│ - Judge / Route Decision                      │
│ - Outcome Evidence / Ledger                   │
│ - Usage Report Outbox                         │
└──────────────────────────────────────────────┘
```

## 4. 服务边界

## 4.1 New API 控制面

### 负责

- 用户登录和账户状态；
- API Key 创建、禁用和归属；
- 兑换码生成、兑换、余额增加和记录；
- 请求前鉴权；
- 请求频率、额度和模型访问范围检查；
- 为请求分配或透传平台级 `request_id`；
- 将可信用户身份和策略上下文传递给 ACU；
- 根据 ACU Usage Report 完成最终扣费；
- 用户网页展示实际模型、渠道、Token、成本和请求状态。

### 不负责

- 解析任务语义；
- 保存完整代码上下文；
- 执行 Judge；
- 决定 ACU 模型；
- 识别 Coding Agent 阻塞；
- 在前台自行重新计算成本或节省率。

### 设计约束

- New API 只能相信由 ACU 内部签名或内网认证产生的 Usage Report；
- New API 网页使用记录中的模型、渠道和成本必须来自 ACU 账本，而不是根据用户请求模型猜测；
- New API 不得把 `acu-auto` 当成固定上游模型价格进行粗略扣费。

## 4.2 ACU Router Service

### 负责

- 原生请求接收和协议识别；
- 原始请求持久化；
- 内部统一请求对象构造；
- Session / Task / Routing Segment / Step 状态；
- Judge 触发和上下文构造；
- 难度评估；
- 模型、渠道和执行参数候选过滤；
- 价值路由；
- Provider 执行和服务恢复；
- 原生 Streaming 返回；
- 完整 Trace 和 Ledger；
- Usage Report 生成和可靠投递。

### 不负责

- 用户登录页面；
- 兑换码售卖；
- 用户余额作为业务主账；
- 公开支付网关；
- New API 用户权限管理；
- 在第一阶段提供完整用户轨迹浏览器。

## 4.3 Provider

Provider 是实际模型调用渠道，例如：

- OpenRouter；
- CloseAI；
- 后续兼容渠道。

Provider 不直接接触平台用户身份，只接收 ACU 转换或透传的模型请求及渠道凭证。

## 4.4 PostgreSQL

逻辑上分为两类数据：

### New API 业务数据

- 用户；
- API Key；
- 兑换码；
- 余额；
- 渠道配置；
- 业务扣费记录。

### ACU 任务与决策数据

- 原始请求 / 响应；
- Session / Task / Segment / Step；
- Judge / Route Decision；
- Attempt / Tool Event；
- Outcome Evidence；
- 成本账本；
- Usage Report Outbox。

第一阶段两类数据可以部署在同一 PostgreSQL 实例，但应使用独立数据库或独立 Schema，避免 New API 业务表与 ACU 轨迹表耦合。

## 5. ACU Router Service 内部模块

## 5.1 Protocol Ingress（协议入口）

### 职责

- 暴露 New API 可调用的内部协议端点；
- 接收原生请求体、请求头和 Streaming 配置；
- 识别请求属于 Responses、Messages 或 Chat Completions；
- 读取 New API 注入的可信用户上下文；
- 为请求生成或确认全链路 `request_id`；
- 保存原始请求；
- 将请求转换成内部 `NativeRequestEnvelope`。

### 第一阶段端点

- `/v1/responses`；
- `/v1/messages`；
- `/v1/chat/completions`；
- `/v1/models` 或内部模型同步接口；
- `/internal/health`；
- 后续内部管理接口。

### 设计原则

内部标准化是为了状态识别和路由，不代表必须把所有协议先转换成 Chat Completions 再执行。

应优先：

- Responses 原生链路；
- Messages 原生链路；
- 只有目标 Provider 确实需要转换时，才使用定向协议适配。

## 5.2 Trusted Request Context（可信请求上下文）

New API 在转发时加入内部身份和策略信息。字段名称在 `10-newapi-integration.md` 中确定，逻辑内容至少包括：

- `user_id`；
- `api_key_id`；
- 平台 `request_id`；
- 允许的模型白名单 / 黑名单；
- 账户或 Key 策略版本；
- 是否允许 `acu-auto` / `acu-high`；
- New API 已完成鉴权的证明。

这些字段由 New API 生成，不要求客户端提供，也不能信任公网客户端自行伪造。

## 5.3 Protocol Normalizer（协议标准化器）

### 输入

原始 Responses、Messages 或 Chat Completions 请求。

### 输出

内部统一的 `NativeRequestEnvelope`，至少描述：

- 协议类型；
- 请求模型或 ACU 模式；
- System / Developer 内容；
- 历史 Input Items / Messages；
- Tool 定义；
- Tool Calls / Results；
- 可见 Reasoning / Thinking；
- Streaming；
- 上下文关联字段；
- 请求能力需求；
- 原始载荷引用。

### 约束

- 原始请求必须完整保存；
- 标准化结果不能替代原始请求；
- 不得丢失 Tool ID、Response ID、Thinking Block 或客户端续接所需字段；
- 协议字段映射必须通过真实 Fixture 测试。

## 5.4 Conversation Identity Engine（对话身份引擎）

负责识别：

- Session；
- Task / Goal；
- Client Turn 观察记录；
- Step；
- Tool Event 因果关系。

第一阶段识别顺序：

1. 原生协议强关联字段；
2. Tool Call / Result 因果关系；
3. 精确上下文前缀链；
4. 同一 Key、System / Tool Schema 指纹和公共上下文的弱关联；
5. 无法确认时创建新 Session / Task。

该模块不运行独立 Session 识别模型。

## 5.5 Task State Engine（任务状态引擎）

负责维护：

- 当前 Task；
- 当前 Routing Segment；
- Task Phase；
- 当前 Execution Profile；
- Task 基础质量偏好；
- 能力升级下限；
- Planning 临时覆盖；
- Routing Lease；
- 最近错误和 Outcome Evidence。

所有状态以 PostgreSQL 为事实来源，不再依赖单实例内存 Map 作为生产状态。

可以使用短时内存缓存降低查询成本，但缓存不是唯一数据源。

## 5.6 Trigger Engine（重评估触发引擎）

根据 `04` 状态机产生四类动作：

- `REUSE_ROUTE`；
- `END_TEMP_OVERRIDE`；
- `REFILTER_ONLY`；
- `RUN_JUDGE`。

该模块只负责判断动作，不直接选择模型。

## 5.7 Judge Context Builder（Judge 上下文构造器）

负责构建 `JudgeContextEnvelope`：

- 当前原生 API 输入；
- Task 初始目标；
- 最近用户 / Goal 输入；
- 最近 Plan；
- 上一次 Judge 和 Route Decision；
- 最近 Step / Tool Event；
- Test / Build / Patch；
- 成功、失败和用户反馈；
- 当前模型和升级历史。

第一阶段不使用本地模型总结上下文。超限时只做确定性裁剪，并保存裁剪记录。

## 5.8 Judge Service（上下文与难度评估）

第一阶段在一次 LLM Judge 中暂时合并：

- Q-Context；
- Q-Difficulty。

负责输出：

- 难度分；
- 六项难度因子；
- 能力档位概率；
- 置信度；
- 当前 Phase；
- 关键 Evidence；
- 保持、提高或重新选择质量需求的建议。

Judge Service 必须记录：

- 模型和 Provider；
- Prompt 版本；
- 上下文 Hash；
- 输入 / 输出 Token；
- 成本；
- 延迟；
- 解析状态；
- Cache 状态；
- Fallback 状态。

## 5.9 Model Catalog & Capability Registry（模型目录与能力注册表）

负责维护：

- 模型身份；
- Channel；
- 输入 / 输出价格；
- Context Window；
- Tool Calling；
- Vision；
- Responses / Messages 支持；
- Streaming；
- Reasoning / Thinking 参数；
- Usage 解析能力；
- 健康状态；
- 自动路由资格。

关键设计：

> Model 与 Execution Profile 分离。

同一模型通过不同 Channel、不同 Thinking 配置调用，应是不同 Execution Profile。

New API 的模型和渠道配置是业务侧来源；ACU 维护路由所需的质量曲线、兼容性和健康扩展字段。两者通过稳定模型 / Channel 标识同步，不允许各自使用无法映射的临时名称。

## 5.10 Quality Curve Engine（质量曲线引擎）

负责：

- 根据难度插值各模型预计质量；
- 计算不确定性区间；
- 计算质量上界；
- 为 Route Decision 提供可比较的质量估计。

第一阶段的曲线是公开 Benchmark 和人工校准形成的冷启动先验，不是用户逐请求真实成功率。

## 5.11 Route Decision Engine（路由决策引擎）

输入：

- Judge Evaluation；
- Task / Segment 质量目标；
- 能力升级下限；
- 用户白名单 / 黑名单；
- 协议和 Tool 等硬条件；
- Execution Profile 健康；
- 价格；
- 预计输出长度；
- Judge 成本；
- 同 Segment 只允许保持或升级的约束。

输出：

- 推荐 Execution Profile；
- 质量上界 Profile；
- 候选列表和过滤原因；
- 预计质量、成本和不确定性；
- 相对质量上界的反事实成本下降；
- 路由策略版本。

## 5.12 Execution Orchestrator（执行编排器）

负责：

- 根据 Route Decision 选择实际 Attempt；
- 构造 Provider 请求；
- 配置 Timeout；
- 发起调用；
- 处理 Streaming；
- 记录 Usage；
- 分类 Provider / Protocol / Environment / Capability 错误；
- 在允许时执行轻量服务恢复；
- 产生最终执行结果。

显式模型：

- 不运行 Judge；
- 不替换模型；
- 第一阶段不跨 Channel；
- 仍由该模块调用 Provider 和记录数据。

`acu-auto` / `acu-high`：

- 优先使用 Route Decision；
- Provider 失败时先尝试同模型同配置的其他健康 Channel；
- 再重筛不低于当前质量下限的候选；
- 服务恢复不重新 Judge。

## 5.13 Provider Adapter（上游适配器）

每个 Adapter 负责：

- Base URL 和认证；
- Provider 模型 ID 映射；
- 协议能力；
- 请求参数差异；
- Streaming 事件；
- Usage 和成本字段；
- 错误结构和重试语义；
- Provider Request ID。

第一批：

- OpenRouter Adapter；
- CloseAI Adapter。

后续 Provider 通过统一接口增加，不把 `if provider === ...` 散落在核心状态机和路由代码中。

## 5.14 Stream Relay（流式中继）

负责：

- 将上游原生或适配后的 Streaming 事件返回给 New API；
- 保持事件顺序；
- 不向正文注入 ACU 信息；
- 记录首 Token 延迟、完成状态和 Usage；
- 处理客户端断开和上游取消；
- 将完整或聚合后的流式轨迹保存策略交给数据模块。

Streaming 不能由 New API 和 ACU 分别重复解析并重写。职责应明确：

- ACU 负责协议语义和上游流；
- New API 主要负责透明转发给客户端。

## 5.15 Evidence & Failure Engine（证据与失败引擎）

负责从原生 Tool Result、Test / Build 输出、Attempt 和用户输入中确定性提取：

- Outcome Evidence；
- Failure Signature；
- Provider Error；
- Protocol Error；
- Environment Error；
- Capability Failure Candidate；
- 用户满意 / 不满意 / 重试信号。

第一阶段只做高精度规则，不训练独立失败模型。

## 5.16 Trace & Ledger Service（轨迹与账本）

负责：

- 保存完整原始输入输出；
- 保存 Session / Task / Segment / Step；
- 保存 Judge、Decision、Attempt 和 Evidence；
- 统一计算实际总成本；
- 计算质量上界反事实成本；
- 生成可供 New API 展示的请求摘要；
- 生成 Usage Report。

账本是 ACU 的成本事实来源。New API 不重复实现第二套 ACU 成本算法。

## 5.17 Usage Report Outbox（用量上报发件箱）

因为 Streaming 完成后才能确定完整 Token、失败 Attempt 和 Judge 成本，ACU 不能只依赖初始响应头向 New API传递最终账单。

第一阶段建议使用：

```text
ACU 完成或终止请求
→ 在 PostgreSQL 事务中写 Ledger Entry
→ 同时写 Usage Report Outbox
→ 内部投递器调用 New API 内部结算接口
→ New API 完成最终扣费
→ ACU 标记 delivered
```

Outbox 至少包含：

- `request_id`；
- `user_id`；
- `api_key_id`；
- 请求模式；
- 实际模型；
- 实际 Channel；
- Token；
- Judge 成本；
- 各 Attempt 成本；
- 实际总成本；
- 最终状态；
- 幂等键；
- 策略和价格版本。

New API 结算接口必须幂等。

如果投递暂时失败，ACU 保存 Outbox 并重试，不能丢失账单。

## 5.18 Internal Admin API（内部管理接口）

第一阶段供管理员和调试使用：

- 按 request_id 查询 Trace；
- 按用户 / Session / Task 查询轨迹；
- 查询 Judge / Decision / Attempt；
- 查询 Provider 健康；
- 查询成本对账状态；
- 查询未投递 Usage Report；
- 支持现有 ACU Demo 获取必要数据。

这些接口不直接公开给普通用户。

## 6. 请求生命周期

## 6.1 通用入口流程

```text
1. Codex / Claude Code 向 New API 发送原生请求
2. New API 验证 API Key、账户状态、模型权限和余额
3. New API 为请求分配 request_id，并预留必要额度
4. New API 将原始请求与可信身份上下文转发到 ACU
5. ACU 保存原始请求并解析协议
6. ACU 判断显式模型还是 ACU 模式
7. ACU 执行对应路由与上游调用
8. ACU 将原生响应流经 New API 返回客户端
9. ACU 保存完整 Trace、Ledger 和 Usage Report Outbox
10. ACU 向 New API 内部结算接口上报实际成本
11. New API 幂等完成扣费，并在网页使用记录中展示实际信息
```

## 6.2 显式模型请求

```text
New API 鉴权
→ ACU 保存请求
→ 识别显式模型
→ 不运行 Judge
→ 将模型映射到允许的固定 Execution Profile / Channel
→ 调用 Provider
→ 原生返回
→ 保存完整数据和实际成本
→ 上报 New API 结算
```

第一阶段 Provider 失败时不静默更换模型或 Channel。

## 6.3 `acu-auto` 请求

```text
New API 鉴权
→ ACU 保存请求
→ 识别 Session / Task / Segment / Step
→ Trigger Engine 判断动作

REUSE_ROUTE
    → 复用现有 Execution Profile

END_TEMP_OVERRIDE
    → 撤销 Planning 临时覆盖
    → 使用已有 Judge Evaluation 重新价值路由或复用合格 Profile

REFILTER_ONLY
    → 保留难度
    → 根据兼容性 / Channel 健康重筛

RUN_JUDGE
    → 构造 JudgeContextEnvelope
    → Judge
    → Quality Curve
    → Route Decision

→ Execution Orchestrator
→ Provider
→ 原生返回
→ 保存 Trace / Evidence / Ledger
→ Usage Report
```

## 6.4 Planning 流程

```text
识别高置信度 Planning 开始
→ 新建 Planning Segment
→ 构造包含历史状态的 JudgeContextEnvelope
→ Judge
→ 临时质量覆盖 88
→ 选择 Planning Execution Profile
→ Planning 多 Step 复用

Planning 明确结束：
  无新能力需求
    → 撤销临时覆盖，不强制 Judge
  有新约束 / 范围扩大 / Replanning / 阻塞
    → 重新 Judge
```

## 6.5 能力阻塞流程

```text
Evidence Engine 识别重复高置信度失败
→ 当前 Segment 标记 blocked
→ 更新 Failure Signature 与 Evidence
→ 新建 Segment
→ Judge 读取过去尝试和失败
→ 只允许保持或升级
→ 更新 capability_escalation_floor
→ 继续执行
```

## 6.6 Provider 故障流程

### 显式模型

```text
Provider 失败
→ 记录 Attempt
→ 不 Judge
→ 不切换模型
→ 第一阶段不跨 Channel
→ 返回错误
```

### `acu-auto` / `acu-high`

```text
Provider 失败
→ 记录 Attempt
→ 不 Judge
→ 优先同模型同配置其他 Channel
→ 再重筛不低于质量下限的健康 Profile
→ 成功则继续
→ 无候选则返回错误
```

## 7. New API 与 ACU 的内部契约

详细字段在 `10-newapi-integration.md` 确定。总体分为三类。

## 7.1 请求转发契约

New API 向 ACU 传递：

- 原始 URL、Method、Query 和 Body；
- 必要原始协议 Headers；
- 可信 `user_id`、`api_key_id`、`request_id`；
- 用户模型白名单 / 黑名单或策略版本；
- 允许的 ACU 模式；
- 额度预留 / 结算关联 ID；
- 内部认证签名。

客户端不能覆盖这些可信字段。

## 7.2 原生响应契约

ACU 向 New API 返回：

- 原生协议 HTTP 状态；
- 原生响应 Headers；
- 原生非流式 Body 或 Streaming Body；
- 可选内部 Trace ID。

New API 不修改模型正文和 SSE 内容。

## 7.3 Usage Report 契约

ACU 在请求完成后调用 New API 内部结算接口，上报：

- 实际模型和 Channel；
- Token；
- Judge 成本；
- Attempt 成本；
- 实际总成本；
- 请求最终状态；
- 幂等键；
- 价格版本；
- 网页展示摘要。

## 8. 现有 ClawRouter 代码承接关系

当前仓库不是从零开始。已有代码可作为 ACU 数据面的初始基础，但应从 Demo 单体逐步抽取成模块，而不是继续把逻辑堆入 `proxy.ts`。

## 8.1 `src/proxy.ts`

### 已有能力

- HTTP 代理入口；
- Chat Completions 请求处理；
- Upstream 调用；
- Streaming 安全写入；
- Timeout；
- 429、5xx、Overload 等错误分类；
- 多 Attempt / Fallback；
- Tool / Vision / Context 候选过滤；
- Usage、Latency 和 Attempt Trace；
- ACU Demo API 与静态页面；
- OpenRouter 和第二上游转发。

### 承接方式

**复用并拆分。**

应提取为：

- Protocol Ingress；
- Execution Orchestrator；
- Provider Adapter；
- Stream Relay；
- Error Classifier；
- Trace Writer。

不应继续让 `proxy.ts` 同时承担协议、路由、状态、Provider、前端和数据库职责。

## 8.2 `src/router/*`

### 已有能力

- RulesStrategy；
- Tier 分类；
- Fallback Chain；
- Tool、Vision、Context 和排除列表过滤；
- 模型成本估算。

### 承接方式

- RulesStrategy 保留为 Judge 不可用时的降级先验或对照，不作为正式 ACU 主路由；
- 候选过滤和 Fallback 辅助函数可复用；
- 硬编码 Tier → 固定模型的主路径逐步退出；
- 固定 Claude Opus Baseline 逻辑必须移除，改用质量上界口径。

## 8.3 `src/session.ts`

### 已有能力

- Session 内模型 Pin；
- 30 分钟超时；
- 显式模型优先；
- 重复请求 Strike 和升级；
- Session 成本累计。

### 承接方式

**保留思想和部分测试，替换生产实现。**

现有问题：

- 状态只在内存；
- 依赖 `x-session-id` 或首个用户消息 Hash；
- 只记录一个 Session 模型；
- 不支持 Task / Routing Segment / Step；
- 不支持多实例；
- 30 分钟 Session 超时与 10 分钟 Routing Lease 混在一起。

新实现进入 PostgreSQL Task State Engine。

## 8.4 `src/acu/judge.ts`

### 已有能力

- 可见上下文序列化；
- Tool Call / Result 表达；
- 确定性 Token 估计；
- 确定性 Head-Tail 截断；
- Judge System Prompt；
- JSON 解析和字段校验；
- 六项难度因子；
- 难度指数计算；
- Judge Cache、Usage、成本和延迟记录。

### 承接方式

**重点复用并扩展。**

需要增加：

- Responses / Messages 原生结构；
- Task / Segment 状态；
- 历史成功、失败和用户反馈；
- 当前 Plan；
- 过去升级历史；
- Q-Context 输出；
- 更精细的确定性裁剪策略。

## 8.5 `src/acu/decision.ts`

### 已有能力

- 模型曲线插值；
- 调用成本估算；
- 不确定性和风险调整；
- Pareto 前沿；
- 质量与成本效用；
- Value Route 选择；
- 质量上界候选。

### 承接方式

**重点复用。**

需要增加：

- Execution Profile 级比较；
- Channel 价格与健康；
- 白名单 / 黑名单；
- 当前 Segment 最低质量约束；
- Planning 临时覆盖；
- Provider 故障后的 `REFILTER_ONLY`；
- 统一输出长度和反事实成本口径。

## 8.6 `src/acu/storage.ts`

### 已有能力

- SQLite WAL；
- Routing Request；
- Candidate Score；
- Feedback；
- Outcome；
- Attempt；
- Execution Profile Health；
- 文件权限控制。

### 承接方式

**Schema 思路复用，存储实现替换。**

迁移到 PostgreSQL，并扩展 Session / Task / Segment / Step、原始请求响应、Tool Event、Ledger 和 Usage Outbox。

## 8.7 `src/models.ts`

### 已有能力

- 模型 ID 和别名；
- 双上游；
- 价格；
- Context Window；
- Tool / Vision / Reasoning 能力；
- 上游模型参数差异。

### 承接方式

作为 Model Catalog 冷启动数据复用，但需要：

- 把模型与 Channel 拆分；
- 把静态 Upstream 枚举改为 Provider Adapter 注册；
- 支持 New API 渠道同步；
- 维护协议能力矩阵；
- 维护动态健康和价格版本；
- 避免模型元数据永久硬编码在单文件中。

## 8.8 `src/ledger.ts`

### 已有能力

- JSONL 追加账本；
- 请求、模型、Token、成本、Fallback 和摘要；
- Demo 查询。

### 承接方式

字段和 Demo 展示思路可复用，但 JSONL 存储替换为 PostgreSQL Ledger。

固定 Baseline、启发式质量分和旧 Savings 口径不进入产品化账本。

## 8.9 `src/validator/*`

现有 Validator 主要处理 JSON / Schema 格式。

承接原则：

- 可以保留为格式校验工具；
- 不把格式校验结果当作 Coding 任务质量；
- 不再用“关闭 Thinking 修复格式”代表模型能力 Fallback；
- Coding 质量主要来自 Test / Build / Tool / Retry / 用户反馈等 Outcome Evidence。

## 8.10 Dedup、Response Cache 与 Compression

这些模块不是第一阶段核心价值，并可能影响原生 Agent 的重试、Streaming、Tool ID 和上下文完整性。

第一阶段原则：

- 现有代码保留；
- 在 Responses / Messages 主链路默认关闭或保守使用；
- 只有通过协议 Fixture 和真实 Agent 回归测试后再启用；
- 不为了复用而强行进入关键路径。

## 9. 进程与部署建议

第一阶段建议最小部署单元：

```text
1. New API Service
2. ACU Router Service
3. PostgreSQL
4. 可选反向代理 / TLS
```

### 9.1 New API

- 公网可访问；
- 提供用户网页和 API Base URL；
- 只允许通过内部网络访问 ACU；
- 保存业务账户与扣费数据。

### 9.2 ACU Router Service

- 不直接公开给普通用户；
- 仅允许 New API 和内部管理员访问；
- 持有 Provider 凭证；
- 持有 Judge 凭证；
- 连接 ACU PostgreSQL Schema；
- 以无状态请求处理 + PostgreSQL 持久状态为主。

### 9.3 PostgreSQL

- 不公网开放；
- New API 和 ACU 使用不同数据库用户；
- ACU 原始轨迹表与 New API 用户余额表逻辑隔离；
- 关键 Ledger 和 Usage Outbox 使用事务写入。

### 9.4 第一阶段不引入

- Kubernetes；
- Kafka / RabbitMQ；
- 独立微服务网格；
- 分布式缓存集群；
- 多地域部署；
- 复杂数据湖。

Usage Report 的可靠投递先用 PostgreSQL Outbox 和轻量后台 Worker。

## 10. 安全与信任边界

### 10.1 公网信任边界

只有 New API 直接信任用户 API Key。

ACU 不信任客户端自己发送的：

- `user_id`；
- `api_key_id`；
- 白名单；
- 余额；
- 内部路由模式；
- 计费信息。

这些必须由 New API 通过内部认证传递。

### 10.2 ACU 与 Provider

- Provider Key 只保存在 ACU / New API 的服务端安全配置；
- 不返回给客户端；
- 日志中不得保存明文 Provider Key；
- Provider 错误正文保存前需要避免泄露密钥。

### 10.3 原始轨迹

- 完整输入输出保存在 ACU PostgreSQL；
- 普通用户前台不直接读取完整代码轨迹；
- 管理员查询需要内部权限；
- 原始内容对外告知口径默认保存 90 天；
- 第一阶段不运行自动定时删除。

## 11. 可观测性

第一阶段至少需要：

- 全链路 `request_id`；
- `session_id` / `task_id` / `segment_id` / `step_id`；
- 协议类型；
- 用户请求模式；
- Judge 状态、Token、成本和延迟；
- 推荐与实际 Execution Profile；
- Provider Request ID；
- Attempt 状态；
- 首 Token 和总延迟；
- Usage 来源；
- 实际总成本；
- Usage Report 投递状态；
- New API 结算状态。

日志、Trace 和数据库中的同一请求必须使用相同 ID。

## 12. 性能原则

### 12.1 显式模型

ACU 只增加必要的协议、日志和执行开销，不运行 Judge。

### 12.2 已有 Routing Segment

正常 Step 使用 `REUSE_ROUTE`，不运行 Judge。

### 12.3 新 Judge

只在事件触发时发生，并记录独立延迟。

### 12.4 Streaming

- 不等待完整模型输出后再返回；
- 首 Token 尽快透传；
- 轨迹和账本在流结束或中断后完成；
- Usage Report 异步可靠投递，不阻塞客户端最后一个事件。

## 13. 失败边界

### 13.1 New API 拒绝

鉴权、余额、权限或限流失败时，不进入 ACU，不产生 Provider 成本。

### 13.2 ACU 不可用

第一阶段不让 New API 静默绕过 ACU 直接调用 Provider，因为这会造成：

- 轨迹缺失；
- 计费口径不一致；
- `acu-auto` 语义失效；
- 用户无法判断实际行为。

应返回明确网关错误。后续可设计显式模型的受控旁路，但不进入 1.0。

### 13.3 Judge 不可用

详细策略由 `05` 确定。架构需要支持：

- 已有 Segment 继续复用；
- 新任务使用现有 RulesStrategy 的保守 Fallback；
- 或选择质量更高的安全默认 Profile；
- 全部记录 `judge_status` 和降级原因。

### 13.4 PostgreSQL 暂时异常

核心状态和账本不能长期依赖仅内存处理。

第一阶段建议：

- 新 `acu-auto` 请求无法读取必要状态时失败关闭，或使用明确的保守降级策略；
- 不允许成功调用 Provider 却完全不记录账单；
- Ledger / Usage Outbox 写入应与请求完成状态协同处理。

详细事务边界在 `09` 和 `10` 中确定。

## 14. 模块依赖方向

```text
Protocol Ingress
      ↓
Protocol Normalizer
      ↓
Conversation Identity / Task State
      ↓
Trigger Engine
      ↓
Judge Context Builder → Judge Service
      ↓
Catalog / Quality Curve / Route Decision
      ↓
Execution Orchestrator
      ↓
Provider Adapter / Stream Relay

所有阶段
      ↓
Trace / Evidence / Ledger / Usage Outbox
```

约束：

- Provider Adapter 不依赖 Task State；
- Judge Service 不直接调用 Provider Execution Orchestrator；
- Route Decision 不修改原始协议请求；
- New API 不直接查询 ACU 内部状态来决定模型；
- Ledger 不从前端展示字段反推成本；
- Demo 页面不成为核心请求链路依赖。

## 15. 第一阶段开发模块

根据架构边界，后续开发可分为以下模块，而不是按页面或日期拆分：

### 模块 A：New API 接入与内部信任

- New API 用户、Key、兑换码；
- 模型请求转发到 ACU；
- 可信身份上下文；
- 额度预留和 Usage Report 结算；
- 网页使用记录字段。

详细文档：`10-newapi-integration.md`。

### 模块 B：原生协议入口

- Responses；
- Messages；
- Chat Completions 保留；
- Streaming；
- Tool / Thinking / Usage Fixture。

详细文档：`02-native-protocol-observations.md`。

### 模块 C：Conversation / Task State

- Session / Task / Segment / Step；
- 连续性识别；
- Routing Lease；
- Trigger Engine。

设计基线：`04-session-task-routing-segment-state-machine.md`。

### 模块 D：Judge

- JudgeContextEnvelope；
- Q-Context；
- Q-Difficulty；
- Prompt、解析、Cache、Fallback。

详细文档：`05-judge-and-context-policy.md`。

### 模块 E：Planning

- Planning 开始 / 结束；
- 临时质量覆盖；
- Replanning。

详细文档：`06-planning-detection.md`。

### 模块 F：Failure & Evidence

- 错误分类；
- Failure Signature；
- 高置信度阻塞规则；
- 能力升级。

详细文档：`07-failure-taxonomy-and-rules.md`。

### 模块 G：Route & Provider Recovery

- Catalog；
- Execution Profile；
- Quality Curve；
- Value Route；
- Channel 健康；
- `REFILTER_ONLY`；
- Provider Adapter。

详细文档：`08-routing-and-provider-recovery.md`。

### 模块 H：PostgreSQL 与账本

- 所有领域表；
- 原始数据；
- Ledger；
- Usage Outbox；
- 索引和事务。

详细文档：`09-postgresql-data-model.md`。

### 模块 I：Alpha 验收

- Fixture；
- 端到端测试；
- 真实 OPC 用户；
- 成本对账；
- 回归场景。

详细文档：`11-alpha-acceptance.md`。

## 16. 架构验收标准

本文架构在进入模块开发前，应满足：

1. 用户只需要配置 New API Base URL 和 API Key；
2. ACU 独立于 New API 部署；
3. 所有模型请求经过 ACU 数据面；
4. 显式模型不运行 Judge，但完整记录；
5. `acu-auto` 使用事件驱动状态机；
6. ACU 直接执行 Provider 请求并保持原生协议响应；
7. New API 不需要理解 ACU 路由算法；
8. New API 能通过可信 Usage Report 完成准确扣费和网页展示；
9. PostgreSQL 是任务状态和账本事实来源；
10. 现有 ClawRouter 代理、Judge、曲线和 Attempt 能力被承接，而不是整体推倒重写；
11. `proxy.ts` 不继续成为所有业务逻辑的唯一容器；
12. Responses 和 Messages 的未知事实被明确留给协议观察文档确认。

## 17. 待后续文档确定的事项

以下问题不阻塞总体架构定稿，但必须在对应文档中解决：

- New API 转发到 ACU 的具体 Hook 或 Channel 配置方式；
- 内部认证采用共享密钥、HMAC 还是 mTLS；
- 额度预留的计算方法；
- Usage Report 内部接口字段；
- Usage Report 失败重试频率；
- Responses / Messages 在 New API 中的实际透传差异；
- OpenRouter / CloseAI 是否原生支持目标协议；
- 哪些情况下进行协议转换；
- Judge 不可用时的安全默认策略；
- Planning 结束后是否复用原 Profile 或重新价值路由；
- Provider Recovery 最大 Attempt 数；
- 原始 Streaming 逐事件保存还是聚合保存；
- PostgreSQL 与 New API 数据库是否共用实例；
- Demo 管理接口如何读取新 PostgreSQL 数据。

这些问题分别进入 `02`、`05`、`08`、`09` 和 `10` 文档，不应继续混在总体架构文档中。
