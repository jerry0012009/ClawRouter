# ACU Router 产品化范围与 1.0 Alpha 边界

> 状态：产品化阶段 0 范围草案，待创始人终审  
> 版本：v0.1  
> 日期：2026-07-29  
> 依赖文档：`01-glossary-and-domain-model.md`、`04-session-task-routing-segment-state-machine.md`

## 1. 文档目的

本文件用于统一 ACU Router 第一阶段产品化的目标、用户、使用方式、必做范围、明确不做范围和验收标准。

本文件回答以下问题：

1. 第一阶段到底要做成什么产品；
2. 第一批用户是谁，他们如何接入；
3. 哪些能力必须在 1.0 Alpha 中完成；
4. 哪些能力虽然长期重要，但不进入第一阶段；
5. 什么状态可以宣布“产品已具备邀请制真实使用条件”；
6. 后续架构、数据库和模块文档应围绕什么目标展开。

本文件不是详细技术架构、数据库 Schema 或开发任务清单。具体实现由后续文档展开。

## 2. 产品定位

ACU Router 第一阶段是一个面向 Coding Agent 的任务级模型路由与成本管理服务。

它不是单纯的模型中转站，也不是只按模型价格做静态分流。它需要在原生 Codex / Claude Code 的多 Step 工作流中，结合：

- 当前任务上下文；
- 历史成功、失败和用户反馈；
- 任务难度；
- 模型难度—质量曲线；
- 用户允许使用的模型范围；
- 协议与工具兼容性；
- 上游渠道健康度；
- 实际 Token 成本；

选择当前 Routing Segment 的 Execution Profile，并在同一连续工作片段中保持模型稳定，只在新任务、Planning、Replanning、能力阻塞或路由租约过期等事件发生时重新评估。

第一阶段的核心价值主张是：

> 在不显著牺牲 Coding Agent 任务质量的前提下，以任务级路由降低相对质量上界的调用成本，并持续积累“任务—上下文—模型—过程—结果—成本”数据。

第一阶段不承诺正式 SLA，也不把当前质量曲线表述为逐请求真实成功概率。

## 3. 第一阶段产品目标

第一阶段目标是：

> 为 3—10 名 OPC 程序员提供邀请制 Coding Router Alpha。用户通过 New API 前台获得账户、兑换码余额和 API Key，在原生 Codex 或 Claude Code 中修改 Base URL 后，即可指定具体模型调用，或使用 `acu-auto` 进行任务级自动路由。系统通过 OpenRouter、CloseAI 及后续兼容渠道执行请求，并在本地 PostgreSQL 中完整记录 Session、Task、Routing Segment、Step、工具轨迹、Judge、路由、成本和结果证据。

第一阶段要证明的不是“平台已经是成熟企业 SaaS”，而是以下三件事：

1. 原生 Coding Agent 可以稳定接入并完成真实任务；
2. ACU 可以在多 Step 任务中稳定执行事件驱动路由，而不是每次请求无脑重选模型；
3. 系统可以产生第一批可信、可追溯的真实任务轨迹和成本数据。

## 4. 第一批目标用户

### 4.1 用户范围

第一批用户为：

- 3—10 名 OPC 程序员；
- 使用原生 OpenAI Codex 或 Claude Code；
- 愿意参与邀请制 Alpha 测试；
- 能够提供对任务结果、稳定性和路由体验的反馈。

第一阶段不面向陌生公众大规模开放，不以公开注册和流量增长为核心目标。

### 4.2 第一批主要使用场景

包括但不限于：

- 代码阅读与解释；
- 小型功能开发；
- Bug 修复；
- 单元测试生成与修复；
- 多文件修改；
- Repository 搜索与定位；
- Planning、实现、验证和 Repair 连续工作流；
- Claude Code / Codex 的 Tool Calling、Streaming 和多 Step Agent 循环。

第一阶段会记录复杂任务，但不对生产级高风险任务提供正式质量保证。

## 5. 用户接入方式

### 5.1 用户前台

第一阶段直接沿用 New API 前台，不重新开发完整用户中心。

New API 前台承担：

- 用户登录；
- API Key 查看与管理；
- 兑换码充值；
- 余额查看；
- 模型目录；
- 使用记录；
- 实际模型、渠道、Token 和成本展示。

当前 ACU Demo 页面继续用于：

- 产品说明；
- 路由逻辑展示；
- 管理员分析；
- 内部调试；
- 客户、导师和投资人演示。

第一阶段不把 ACU Demo 改造成完整用户工作台。

### 5.2 Coding Agent 接入

用户在原生客户端中配置：

- 平台 Base URL；
- New API 分配的 API Key；
- 指定模型、`acu-auto` 或可选的 `acu-high`。

第一阶段不要求用户：

- 安装 ACU 定制客户端；
- 修改 Codex 或 Claude Code 源码；
- 添加自定义 Session / Task Header；
- 使用 ACU 专用 SDK；
- 主动上报 Task ID、测试结果或路由标签。

### 5.3 API 响应原则

用户使用的是原生 Coding Agent，因此平台必须保持对应协议的响应语义和格式：

- OpenAI Responses 风格请求按兼容的 Responses 格式返回；
- Anthropic Messages 风格请求按兼容的 Messages 格式返回；
- Streaming、Tool Calling、Reasoning / Thinking 和 Usage 不得被 ACU 页面展示需求破坏；
- 不向模型正文、Tool Result 或 SSE 内容中注入 ACU 路由解释；
- 不为了展示节省率修改模型原始回答。

ACU 实际选择的模型、渠道、成本和路由信息保存在后台，并在 New API 网页前台的使用记录中展示。

## 6. 用户模型入口

### 6.1 指定具体模型

用户可以把平台当作模型中转与计费入口，明确指定具体模型。

第一阶段行为：

- 不运行 LLM Judge；
- 不执行 ACU 模型路由；
- 不替换成其他模型；
- 第一阶段不自动切换到其他渠道；
- 仍保存完整输入、输出、工具轨迹、Token、成本和错误。

指定模型模式不计算 ACU 节省率。

### 6.2 `acu-auto`

`acu-auto` 是第一阶段的核心自动路由入口。

行为：

- 新 Task、新外部输入、Planning、Replanning、能力阻塞或 Routing Lease 过期时运行 Judge；
- 正常连续 Step 共享 Judge Evaluation 和 Execution Profile；
- 使用任务难度、模型曲线、质量偏好、价格、兼容性、白名单和渠道健康度选择执行配置；
- 同一 Routing Segment 内只允许保持或升级；
- Planning 可以施加临时质量覆盖；
- 上游故障时可以在不重新 Judge 的前提下进行轻量候选重筛与服务恢复。

基础质量偏好参数可暂定为 80，但该参数不是对用户开放的固定承诺。

### 6.3 `acu-high`

`acu-high` 使用与 `acu-auto` 相同的状态机，但基础质量偏好更高，可暂定为 92。

第一阶段：

- 预留并尽量支持；
- 不作为 Alpha 上线的核心阻断项；
- 不开放用户自定义连续质量分；
- 不把它实现为某个固定最贵模型的别名。

### 6.4 未来质量偏好配置

第一阶段不向用户开放质量滑杆、任意分数或复杂策略编辑器。

架构必须预留未来能力，例如：

- 自定义质量偏好；
- 自定义成本上限；
- 自定义模型范围；
- 任务类型策略；
- 团队级质量契约。

这些不进入第一阶段用户界面。

## 7. 模型目录、白名单与自动路由资格

### 7.1 模型目录

第一阶段可以在 New API 前台展示 OpenRouter、CloseAI 中已配置且可调用的模型。

模型目录中的模型可以被用户显式指定，不代表它必然可以参加 ACU 自动路由。

### 7.2 自动路由资格

一个 Execution Profile 只有同时满足以下条件，才可以进入 `acu-auto` / `acu-high` 候选池：

- 已有难度—质量曲线；
- 当前渠道实际可调用；
- 当前原生协议兼容；
- Streaming、Tool Calling 和上下文能力满足当前请求；
- Thinking / Reasoning 配置可用；
- 价格和 Usage 解析明确；
- 当前健康状态允许；
- 用户 / API Key 白名单允许；
- 不在黑名单中。

### 7.3 白名单与黑名单

第一阶段必须具备策略层的模型白名单和黑名单能力，例如：

- 某个用户只允许使用 GPT 系列；
- 某个 API Key 禁止使用特定供应商；
- 某个模型可以显式调用，但暂不参与自动路由。

第一阶段可以由管理员配置，不要求立即完成复杂的用户自助策略编辑器。

## 8. 首要协议范围

第一阶段首要支持：

1. OpenAI Responses API 兼容链路，用于原生 Codex；
2. Anthropic Messages API 兼容链路，用于原生 Claude Code。

必须覆盖：

- 非流式请求；
- Streaming；
- Tool / Function Calling；
- Tool Result / Function Call Output；
- Reasoning / Thinking 可见结构；
- Usage；
- 错误返回；
- 多 Step 上下文延续。

已有 Chat Completions 兼容能力可以保留，但不作为第一阶段核心验收协议。

第一阶段不建设复杂通用协议自动修复系统。协议差异通过真实流量采集、兼容矩阵、定向适配和回归 Fixture 处理。

## 9. 上游渠道范围

### 9.1 第一批渠道

第一阶段上游包括：

- OpenRouter；
- CloseAI；
- 后续可增加其他兼容渠道。

架构不能把业务逻辑写死在两个渠道上。

### 9.2 上游故障处理

用户显式指定模型时，第一阶段：

- 不替换模型；
- 不自动跨渠道；
- 返回并记录上游错误。

`acu-auto` / `acu-high` 时，第一阶段允许：

1. 优先尝试同模型、同 Thinking / Reasoning 配置的其他健康渠道；
2. 若不存在，再重筛满足当前最低质量下限的健康 Execution Profile；
3. 此过程不重新 Judge；
4. 无合格候选时返回错误。

第一阶段不建设复杂的供应商采购、批量账号池或灰色订阅转 API 系统。

## 10. 路由与任务状态范围

第一阶段必须实现并持久化：

- Session；
- Task / Goal；
- Client Turn 观察记录；
- Routing Segment；
- Step；
- Tool Event；
- Execution Attempt；
- Judge Evaluation；
- Route Decision；
- Outcome Evidence；
- Ledger Entry。

核心行为以 `04-session-task-routing-segment-state-machine.md` 为准，包括：

- 原生协议字段优先识别连续性；
- 工具调用因果关系；
- 精确上下文前缀链；
- 10 分钟 Routing Lease；
- 任何有效活动续租；
- 新外部输入重新 Judge；
- Goal 自动继续不机械重复 Judge；
- Planning 临时质量覆盖；
- 高精度、低频的规则型能力阻塞识别；
- 同一 Segment 内只保持或升级；
- 不运行周期性定时 Judge。

## 11. Judge 范围

第一阶段 LLM Judge 暂时同时承担：

1. Q-Context：理解任务状态、阶段、历史尝试、成功、失败和用户反馈；
2. Q-Difficulty：判断下一 Routing Segment 的最低充分能力需求和风险水平。

JudgeContextEnvelope 必须以当前原生 API 请求为主要证据，并补充 PostgreSQL 中可确定性提取的：

- Task 初始目标；
- 最近用户输入；
- 当前 / 最近 Plan；
- 上一次 Judge 与 Route Decision；
- 最近 Step 和 Tool Event；
- Test / Build / Patch 结果；
- 成功 / 失败 Evidence；
- 用户满意 / 不满意 / 重试信号；
- 当前执行配置与升级历史。

第一阶段：

- 不使用本地模型做上下文总结；
- 不训练独立 Q-Context 模型；
- 不训练独立 Q-Difficulty 模型；
- 选择支持较长上下文的 Judge 模型；
- Judge 最大上下文长度必须可配置；
- 超限时只做确定性裁剪。

## 12. Planning 范围

第一阶段实现：

- 高精度识别 Planning 开始；
- Planning 开始时重新 Judge；
- 默认施加 88 的临时质量覆盖；
- Planning 内连续 Step 保持同一 Execution Profile；
- Read / Search 作为 Planning 模型控制的工具动作，不按单个工具调用切模型；
- 高精度识别 Planning 结束；
- 未发现新能力需求时撤销临时覆盖；
- Plan 暴露新约束、范围扩大、Replanning 或阻塞时重新 Judge。

第一阶段不实现：

- 固定“强模型负责 Plan、便宜模型负责执行”的硬编码分工；
- Planning 结束后无条件换便宜模型；
- 单纯因为出现 `plan` 文字就升级；
- 每次 Read / Search 都切换到其他模型。

## 13. 能力失败识别范围

第一阶段只做高精度、低频的确定性规则，主要覆盖：

- 不存在的工具或反复非法 Tool 参数；
- 同一 Test / Build 核心错误连续无改善；
- 反复引用已确认不存在的路径或符号；
- 修改—撤销—重复修改形成轨迹振荡；
- 用户明确指出同一问题未解决，并有轨迹证据支持。

以下情况不直接判定为模型能力不足：

- 第一次测试失败；
- 一次工具参数错误；
- 429、5xx、Timeout；
- 网络错误；
- 环境缺少依赖或权限；
- 上下文超限；
- 协议转换错误；
- Usage 解析缺失。

独立失败识别模型进入后续阶段。

## 14. 数据与 PostgreSQL 范围

### 14.1 数据存储分工

New API 数据库主要保存：

- 用户；
- API Key；
- 兑换码；
- 余额；
- 渠道；
- 基础用量和扣费记录。

ACU 本地 PostgreSQL 保存：

- Session、Task、Segment、Step；
- 原始请求和原始响应；
- Tool Call / Tool Result；
- JudgeContextEnvelope、Judge Evaluation；
- Route Decision；
- Execution Attempt；
- Outcome Evidence；
- 成本账本；
- 协议与错误元数据。

### 14.2 保存与查看

第一阶段：

- 完整输入、输出和过程数据保存到 PostgreSQL；
- 原始内容对外告知口径为默认保存 90 天；
- 不运行自动定时删除；
- 删除机制后续单独设计；
- 用户前台暂时不提供完整代码轨迹浏览器；
- 管理员可以按用户、Session、Task 和时间查询完整轨迹；
- 用户前台查看请求概要、实际模型、渠道、Token 和成本。

## 15. 充值与计费范围

### 15.1 充值

第一阶段使用 New API 兑换码充值。

未来可通过 `pay.ldxp.cn` 售卖兑换码，但支付平台集成本身不进入 ACU 1.0 核心开发范围。

第一阶段需要支持：

- 兑换码生成；
- 兑换码对应额度；
- 一次性兑换；
- 重复兑换幂等；
- 兑换记录；
- 管理员禁用或处理异常兑换码。

### 15.2 Alpha 计费

Alpha 阶段按平台实际总成本 1.0 倍扣费，包括：

- Judge 成本；
- 成功上游调用成本；
- 失败但上游实际收费的 Execution Attempt；
- 自动服务恢复中的实际调用成本。

第一阶段不做：

- 在线支付网关；
- 毛利分层；
- 套餐订阅；
- 复杂优惠券；
- 企业合同计费；
- 节省分成自动结算。

## 16. 成本、质量与节省口径

### 16.1 指定模型

仅记录实际模型、渠道、Token、成本和错误，不计算 ACU 节省率。

### 16.2 `acu-auto` / `acu-high`

质量上界定义为：

> 当前用户白名单、协议兼容条件、渠道可用性和任务难度下，预计质量最高的可用 Execution Profile。

必须记录：

- `actual_total_cost`；
- `quality_ceiling_counterfactual_cost`；
- `quality_gap_vs_ceiling`；
- `cost_reduction_vs_ceiling`。

所有前台、Trace 和 Ledger 必须使用相同的：

- 质量上界定义；
- 价格版本；
- 输入 Token；
- 预计输出 Token 口径；
- Judge 成本；
- 失败 Attempt 成本。

页面不得只写“节省 X%”，应写：

> 相对当前任务质量上界配置，成本下降 X%。

这是一项反事实比较，不代表用户原本一定会选择质量上界模型。

## 17. 用户网页可见范围

New API 网页前台至少应让用户看到：

- 请求时间；
- 用户请求模式：指定模型 / `acu-auto` / `acu-high`；
- ACU 实际执行模型；
- 实际渠道；
- 输入、输出、Reasoning 和缓存 Token；
- 实际总成本；
- 请求状态；
- `acu-auto` / `acu-high` 相对质量上界的成本下降。

第一阶段用户网页暂不要求展示：

- 完整 Prompt；
- 完整模型输出；
- 完整 Tool 轨迹；
- Judge 六项因子；
- 全部候选模型曲线；
- Failure Signature；
- 内部路由状态机详情。

这些信息保留在管理员和内部分析层。

## 18. 1.0 Alpha 必做范围

### 18.1 控制面

- New API 用户账户；
- API Key；
- 兑换码；
- 余额与扣费；
- 模型目录；
- 渠道配置；
- 使用记录；
- 网页展示实际模型、渠道和成本。

### 18.2 协议与执行

- 原生 Codex Responses 链路；
- 原生 Claude Code Messages 链路；
- Streaming；
- Tool Calling；
- Reasoning / Thinking；
- Usage；
- OpenRouter；
- CloseAI；
- 后续渠道扩展接口。

### 18.3 路由与状态

- 指定模型；
- `acu-auto`；
- `acu-high` 预留或基础支持；
- Session / Task / Routing Segment / Step；
- 10 分钟 Routing Lease；
- 事件驱动 Judge；
- Planning 临时质量覆盖；
- 规则型能力阻塞识别；
- 白名单 / 黑名单；
- 自动路由候选资格；
- `acu-auto` 上游故障轻量服务恢复。

### 18.4 数据与账本

- 本地 PostgreSQL；
- 完整请求 / 响应；
- Tool 轨迹；
- Judge / Route Decision；
- Attempt；
- Outcome Evidence；
- 统一成本账本；
- 前后台成本口径一致。

## 19. 第一阶段明确不做

以下事项不进入 1.0 Alpha 核心范围：

- 重做完整用户前端；
- 公开注册和大规模开放；
- 企业组织、复杂 RBAC；
- 私有化部署；
- 正式 SLA；
- 质量担保；
- 用户自有上游 Key（BYOK）；
- OpenAI / Anthropic 官方额度托管；
- 在线支付网关；
- 套餐、发票和复杂商业计费；
- 灰色订阅账号池；
- 独立 Session 识别模型；
- 独立 Q-Context 模型；
- 独立 Q-Difficulty 模型；
- 独立能力失败识别模型；
- 9B Router 训练；
- 用户自定义连续质量分；
- 复杂用户策略编辑器；
- 强模型 Plan、便宜模型执行的固定分工；
- 显式模型自动跨渠道容灾；
- 复杂协议自动修复；
- 周期性定时 Judge；
- 自动定时删除数据；
- 用户完整代码轨迹浏览器；
- 全量企业级审计、合规和数据治理能力。

## 20. 功能验收标准

第一阶段达到“可邀请真实用户使用”，至少需要满足：

### 20.1 用户与接入

- 至少 3 名 OPC 程序员完成接入；
- 用户可以通过兑换码获得余额；
- 每个用户拥有独立 API Key；
- Codex 可以通过 Base URL 正常使用；
- Claude Code 可以通过 Base URL 正常使用。

### 20.2 模型调用

- 指定模型请求正常；
- `acu-auto` 请求正常；
- 用户网页可以看到实际执行模型和渠道；
- API 响应不注入 ACU 文案，不破坏客户端格式；
- Streaming 和 Tool Calling 可以完成真实任务。

### 20.3 路由状态

- 同一正常 Routing Segment 的多个 Step 不重复调用 Judge；
- 新外部输入使用完整任务上下文重新 Judge；
- Goal 自动继续不会因内部 Turn 变化机械重复 Judge；
- Planning 可以触发临时质量覆盖；
- 第一次普通失败不会自动升级；
- 重复高置信度阻塞可以触发重新 Judge 和升级；
- 10 分钟无有效活动后，下一次请求重新 Judge。

### 20.4 数据与成本

- 完整请求、响应和 Tool 轨迹进入 PostgreSQL；
- Judge、上游调用和失败 Attempt 成本可追溯；
- New API 扣费与 ACU Ledger 使用同一成本来源；
- 前台、Trace 和 Ledger 的实际模型、Token 和成本一致；
- 用户间不存在数据串读；
- 成本对账误差目标小于 1%。

### 20.5 稳定性

- OpenRouter 与 CloseAI 至少各有一条经过真实验证的调用链路；
- 上游错误不会被误判为能力失败；
- `acu-auto` 可以在满足质量下限时进行轻量服务恢复；
- 显式模型失败时不静默替换成其他模型。

## 21. Alpha 数据验证目标

以下指标用于验证产品方向，不全部作为首次上线阻断项：

- 3—10 名真实用户；
- 至少 100 次真实 API 请求；
- 至少 20 个包含多个 Step 的 Coding Task；
- Codex 与 Claude Code 均产生真实轨迹；
- 获得 Planning、Execution、Verification、Repair 样本；
- 获得 Provider Error、普通失败和能力阻塞候选样本；
- 能够计算每个任务的实际总成本；
- 能够生成相对质量上界的成本对照；
- 能够识别当前规则最常见的误判和漏判。

第一阶段不以“必须立即证明 30% 节省”作为系统上线门槛。稳定接入、可信账本和真实任务数据优先于包装节省结果。

## 22. 主要风险与约束

### 22.1 协议事实不明确

Codex 和 Claude Code 是否稳定透传 Session、Goal、Plan 和关联字段尚需真实流量确认。

应对：先做协议侦察、保存原始 Fixture，再实现状态识别规则。

### 22.2 New API 协议转换差异

Responses、Messages、Tool Calling 和 Thinking 在 New API、OpenRouter、CloseAI 之间可能存在差异。

应对：优先原生透传，维护轻量兼容矩阵，不假定所有“OpenAI Compatible”行为相同。

### 22.3 当前质量曲线是冷启动先验

模型曲线并非客户任务上的逐请求实测成功概率。

应对：明确口径，保存真实轨迹，逐步校准曲线和 Router。

### 22.4 能力失败规则可能误判

第一阶段规则无法覆盖所有 Coding Agent 失败。

应对：采用高精度、低频触发；保存 Evidence；未来训练专门模型。

### 22.5 完整数据保存带来存储与管理压力

第一阶段会保存大量原始上下文、代码、Tool Result 和 Streaming 信息。

应对：PostgreSQL 独立存储；记录 Token 和大小；后续设计归档、删除和对象存储方案。

## 23. 与后续文档的关系

本文件确定产品范围。后续文档必须服从本文件边界：

- `01-glossary-and-domain-model.md`：核心术语与领域对象；
- `02-native-protocol-observations.md`：Codex / Claude Code 真实协议观察；
- `03-system-architecture.md`：总体系统架构和模块边界；
- `04-session-task-routing-segment-state-machine.md`：任务状态与 Judge 触发；
- `05-judge-and-context-policy.md`：Judge 输入、输出和 Prompt 版本；
- `06-planning-detection.md`：Planning 识别与临时质量覆盖；
- `07-failure-taxonomy-and-rules.md`：错误分类与能力阻塞规则；
- `08-routing-and-provider-recovery.md`：候选过滤、价值路由与上游恢复；
- `09-postgresql-data-model.md`：数据表、关联和索引；
- `10-newapi-integration.md`：New API 接入点、扣费和前台展示；
- `11-alpha-acceptance.md`：测试 Fixture、端到端场景和验收用例。

## 24. 待后续文档决定，但不阻塞本范围的事项

以下问题不改变 1.0 产品方向，可在对应设计文档中确定：

- `acu-auto` 基础质量参数的最终默认值；
- `acu-high` 是否与 1.0 同步上线；
- New API 使用记录页具体增加哪些字段；
- 白名单 / 黑名单是否由用户自助编辑；
- Planning 结束后复用当前 Profile 还是重新执行一次价值路由；
- `acu-auto` 服务恢复最多允许几个 Attempt；
- 原始 Streaming 事件逐条保存还是聚合保存；
- 90 天保存口径未来如何执行；
- 管理员完整轨迹查询采用现有页面、内部 API 还是独立工具。

这些事项需要在架构、数据模型和集成文档中明确，但不应继续阻塞产品范围定稿。
