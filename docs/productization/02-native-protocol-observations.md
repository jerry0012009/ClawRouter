# ACU Router 原生协议观察记录

> 状态：产品化阶段 0 协议侦察部分执行，仍待 New API / Claude Code / 完整四段链路补全
> 版本：v0.2-recon-1
> 日期：2026-07-28
> 依赖文档：`00-product-scope.md`、`01-glossary-and-domain-model.md`、`03-system-architecture.md`、`04-session-task-routing-segment-state-machine.md`

## 1. 文档目的

本文件用于记录原生 Codex 与 Claude Code 在经过 New API、ACU Router 和不同 Provider 时的真实协议行为。

它不是根据官方文档推测客户端会发送什么，也不是提前规定客户端必须发送什么。它要通过可复现的真实请求样本回答：

1. 原生客户端实际请求哪个路径；
2. 请求头、请求体、Streaming 事件和错误结构是什么；
3. 客户端如何表达上下文延续、工具调用、Planning、Goal、重试和恢复；
4. 哪些字段可以用于 Session、Task、Routing Segment 和 Step 识别；
5. New API 是否原样透传、转换、删除或新增字段；
6. OpenRouter、CloseAI 和其他 Provider 对两套协议支持到什么程度；
7. 哪些现有 ClawRouter 代码可以直接复用，哪些必须定向改造；
8. 哪些协议事实会直接影响后续 Judge、Planning、失败分类、数据库和集成设计。

本文件在完成真实采集前，不应被标记为“设计定稿”。

## 2. 文档使用规则

### 2.1 事实状态

所有结论必须标注以下状态之一：

- `官方规范`：来自 OpenAI、Anthropic 或原生客户端官方仓库 / 官方文档；
- `当前仓库事实`：来自当前 `jerry0012009/ClawRouter` 代码；
- `实测确认`：通过指定版本客户端和指定链路抓取真实流量确认；
- `暂时推断`：有证据但尚未完成真实链路确认；
- `未确认`：需要采集；
- `已否定`：实测证明此前假设不成立。

“官方规范”不等于“原生客户端一定这样使用”。最终状态机必须以 `实测确认` 为主。

### 2.2 版本绑定

每个样本必须绑定：

- Codex / Claude Code 客户端版本；
- New API Commit 或镜像版本；
- ClawRouter / ACU Commit；
- Provider；
- 模型；
- 操作系统；
- 采集时间；
- 是否 Streaming；
- 是否 Tool Calling；
- 是否 Thinking / Reasoning；
- 是否通过 New API 转发。

客户端升级后，关键样本必须重跑，不能长期依赖一次抓包结果。

### 2.3 原始样本与观察结论分离

原始流量保存为 Fixture；本文件只记录从 Fixture 得出的结构化观察。

每条关键结论都应能追溯到：

```text
fixture_id
+ 客户端版本
+ 请求序号
+ 原始请求 / 响应文件
+ 观察人
+ 观察时间
```

### 2.4 不改写原生客户端

协议侦察期间不要求用户或测试人员：

- 添加自定义 Session Header；
- 添加 Task ID；
- 修改 Codex / Claude Code 源码；
- 安装 ACU 专用 SDK；
- 手动上报 Tool Result；
- 为了便于识别而改变正常使用方式。

我们需要观察的是原生客户端真实行为。

## 3. 已知基线

## 3.1 OpenAI Responses 基线

状态：`官方规范`

当前官方 Responses API 支持：

- `/v1/responses`；
- Input Item 列表；
- `previous_response_id`；
- `function_call` 与 `function_call_output`；
- Reasoning Item；
- Streaming SSE 事件；
- `input_tokens`、`cached_tokens`、`output_tokens`、`reasoning_tokens` 等 Usage 字段。

官方规范同时允许两种上下文管理方式：

1. 使用 `previous_response_id` 由服务端关联历史；
2. 客户端自行把历史 Output Item、Reasoning Item 和 Tool Output 重新放回下一次请求的 `input`。

需要实测确认 Codex 当前版本采用哪一种，或者是否混合使用。

## 3.2 Codex 客户端基线

状态：`官方规范 + 未确认`

Codex 支持配置自定义 Model Provider，并可指定：

- `base_url`；
- `wire_api = "responses"`；
- 自定义 Header；
- 自定义环境变量 API Key；
- Request Retry 和 Stream Retry 等连接配置。

但仍需实测：

- 当前正式版本是否稳定遵守自定义 Base URL；
- 实际请求路径是否为 `/v1/responses` 或其他路径；
- 是否发送 `previous_response_id`；
- 是否重发完整历史；
- Plan 模式和 `update_plan` 在网络请求中的实际形态；
- Codex 自己执行的本地 Shell / Tool 事件如何进入下一次模型请求；
- Resume / Continue 后上下文如何重建。

## 3.3 Anthropic Messages 基线

状态：`官方规范`

当前 Anthropic Messages API 基础形式包括：

- `/v1/messages`；
- `x-api-key` 或 Authorization；
- `anthropic-version`；
- `system`；
- `messages`；
- `tools`；
- `tool_use`；
- `tool_result`；
- `thinking`；
- Streaming 事件；
- 输入、输出及缓存相关 Usage。

`tool_result` 通常作为 `user` 角色消息中的内容块出现，因此不能仅根据 `role = user` 判断出现了新的真实人类输入。

## 3.4 Claude Code 客户端基线

状态：`官方规范 + 未确认`

Claude Code 支持通过 `ANTHROPIC_BASE_URL` 指向统一 LLM Gateway，并支持：

- API Key / Auth Token；
- Plan 权限模式；
- `--continue`；
- `--resume <session_id>`；
- `--max-turns`；
- `--verbose`；
- Streaming / JSON 输出模式。

但仍需实测：

- Claude Code Session ID 是否会出现在网关请求；
- Continue / Resume 是否重新发送完整 Messages 历史；
- Plan 模式是否有稳定 Header、System Prompt、Tool 集合或其他可观察信号；
- Goal / Agent 循环中无人工输入的内部 Turn 如何体现在请求中；
- Tool Error 是否稳定通过 `tool_result.is_error` 表达；
- Thinking Block、Prompt Cache 和 Usage 的实际字段。

## 3.5 当前 ClawRouter 仓库基线

状态：`当前仓库事实`

当前仓库已具备的基础能力包括：

- Node HTTP Proxy；
- OpenAI Chat Completions 兼容入口；
- Streaming 转发；
- 双上游调用；
- Timeout、429、5xx、Overload 分类；
- 多 Attempt 和 Fallback；
- Tool、Vision、Context 候选过滤；
- Session Pin 雏形；
- Judge 上下文序列化；
- Judge 调用和规则回退；
- 模型质量曲线、Pareto 前沿和价值路由；
- Usage、成本、Attempt、Feedback 和 Outcome 数据雏形。

当前仓库尚未发现原生 `/v1/responses` 与 `/v1/messages` 处理链路。主请求处理仍以 `/chat/completions` 为核心，因此 Codex Responses 和 Claude Messages 不能视为已支持。

现有 `SessionStore` 主要依赖：

- 自定义 Session Header；
- 第一条 User Message Hash；
- 进程内 Map；
- 30 分钟超时。

它不能直接满足已确认的 Session / Task / Routing Segment / Step 状态模型，但相关 Pin、Touch、Escalation 和成本累计思路可以复用。

## 4. 协议侦察链路

每个协议至少需要观察以下四个位置：

```text
A. 原生客户端 → New API
B. New API → ACU Router
C. ACU Router → Provider
D. Provider → ACU Router → New API → 原生客户端
```

需要同时保存：

- 入站请求；
- 出站请求；
- 入站响应；
- 出站响应；
- Streaming 原始事件；
- Header 差异；
- Body 差异；
- Usage 差异；
- Error 差异；
- New API 和 ACU 产生的内部 Request ID 映射。

只有观察 A 而不观察 B，无法判断 New API 是否转换请求。只有观察 B 而不观察 C，无法判断 ACU / Provider Adapter 是否改变协议。

## 5. 采集工具与实现边界

## 5.1 Protocol Capture Harness

协议侦察需要一个轻量独立采集工具或 Debug Mode，不应把临时抓包逻辑散落在生产 Router 中。

建议职责：

- 原样记录 HTTP Method、Path、Query；
- 记录经过白名单过滤的 Header；
- 记录原始 Body；
- 逐条记录 SSE Event；
- 记录连接中断与客户端取消；
- 记录转发前后的字段差异；
- 生成 Fixture Manifest；
- 对 Secret 做确定性脱敏；
- 保留内容 Hash，确认脱敏前后是否为同一请求。

采集工具不做：

- 任务路由；
- Judge；
- 内容摘要；
- 自动修复协议；
- 修改客户端请求；
- 模型响应内容注入。

## 5.2 脱敏要求

必须脱敏：

- API Key；
- Authorization；
- Cookie；
- 用户 Token；
- 真实用户名、邮箱和账户 ID；
- 本地绝对路径中的个人目录；
- Git Remote 中的私有凭证；
- Provider Secret。

默认保留：

- 请求结构；
- Tool Schema；
- 测试仓库中的代码内容；
- Tool Call 参数；
- Tool Result；
- 错误文本；
- Usage；
- Streaming 事件顺序。

## 5.3 测试仓库

协议侦察默认使用一个专门的、可丢弃的 Git 测试仓库，包含：

- 若干可读文件；
- 一个明确 Bug；
- 一组失败测试；
- 一个多文件小功能；
- 一个需要 Planning 的架构任务；
- 一个会产生环境错误的任务；
- 一个会触发 Tool 参数失败的可控工具。

这样可以稳定复现不同轨迹，并避免真实项目内容影响协议判断。

## 6. Fixture 目录结构

建议建立：

```text
test/protocol-fixtures/
├── manifest.schema.json
├── codex/
│   └── <client-version>/
│       ├── 001-basic-streaming/
│       │   ├── manifest.json
│       │   ├── client-to-newapi-request.json
│       │   ├── newapi-to-acu-request.json
│       │   ├── acu-to-provider-request.json
│       │   ├── provider-to-acu-stream.sse
│       │   ├── acu-to-newapi-stream.sse
│       │   └── observation.md
│       └── ...
└── claude-code/
    └── <client-version>/
        └── ...
```

每个 `manifest.json` 至少包含：

```json
{
  "fixture_id": "codex-<version>-001",
  "captured_at": "ISO-8601",
  "client": "codex",
  "client_version": "",
  "os": "",
  "newapi_version": "",
  "acu_commit": "",
  "provider": "",
  "model": "",
  "protocol": "responses",
  "stream": true,
  "scenario": "basic_streaming",
  "request_count": 1,
  "contains_tools": false,
  "contains_reasoning": true,
  "sanitized": true
}
```

## 7. Codex 测试矩阵

以下场景均应使用原生 Codex，不编写自定义 API 客户端替代。

### C01：最简单单轮文本请求

目的：确认基础请求路径、Header、Input 结构、模型字段、Reasoning 参数和完整响应结构。

需要观察：

- Method / Path；
- Content-Type；
- Authorization；
- `model`；
- `input`；
- `instructions`；
- `stream`；
- `store`；
- `reasoning`；
- `text`；
- `tools`；
- `include`；
- Response ID；
- Usage。

### C02：Streaming 文本请求

目的：建立最小 SSE 事件序列。

需要观察：

- 首个事件；
- Text Delta；
- Reasoning Summary 事件；
- Response Completed；
- Usage 出现在哪个事件；
- 客户端能否容忍额外 Header；
- 客户端取消时连接行为。

### C03：单次 Function / Shell Tool Call

目的：确认 `function_call`、`call_id`、参数增量和下一 Step 的 `function_call_output` 关联。

需要观察：

- Tool Schema；
- Function Call Item；
- `call_id`；
- Arguments Delta / Done；
- Tool Result 返回方式；
- 下一次请求是否包含前一 Response 的其他 Output Item；
- Reasoning Item 是否被重新发送。

### C04：同一个用户任务的连续多个 Step

目的：判断多个 Step 的上下文延续方式。

关键问题：

- 是否使用 `previous_response_id`；
- 是否重发完整 Input History；
- 是否只发送增量 Item；
- 是否携带前一步 Reasoning Item；
- Tool Call ID 是否稳定关联；
- 每一步 System / Instructions 是否重复；
- Prompt Cache 相关字段是否变化。

### C05：新的真实用户输入

目的：区分同 Task 延续、新 Task 和短输入“继续”。

分别测试：

- “继续”；
- 添加一个新约束；
- 明显更换任务；
- 要求重做；
- 明确表示上一结果不满意。

需要观察客户端发送的是：

- 完整历史；
- 新 Input Item；
- 新 Response 链；
- 某种 Thread / Conversation 标识。

### C06：Plan 模式 / 自主 Planning

目的：确认复杂任务时 Planning 的可观察信号。

至少测试：

- 用户明确要求先 Plan；
- 用户未说 Plan，但复杂任务由 Codex 自主 Planning；
- Plan 被更新；
- Plan 完成后开始 Edit；
- 执行失败后 Replanning。

重点观察：

- `update_plan` 或相关 Tool 是否出现在 `tools`；
- Tool Name、Schema 和 Arguments；
- Plan 状态是否回传到后续 Input；
- Plan Mode 是否改变 Reasoning Effort；
- Plan 开始和结束是否有稳定事件；
- 只读工具与写工具的变化。

### C07：Goal / 长任务自动循环

目的：观察没有新的人类输入时客户端如何连续发起多个内部 Step / Turn。

需要观察：

- 每次请求之间的强关联字段；
- 上下文是增量还是全量；
- Client 是否产生新的内部 Goal / Subgoal 标识；
- 何时停止；
- `max_turns` 或内部预算如何体现；
- 是否存在阶段性压缩 / Compaction。

### C08：Resume / Continue

目的：确认客户端进程退出后恢复任务时如何重建上下文。

需要观察：

- Session ID 是否出现在请求；
- 是否重发全部历史；
- Response ID 是否延续；
- Tool Call / Result 是否重建；
- Plan 是否恢复；
- 首次恢复请求与普通连续 Step 的差异。

### C09：上游 429 / 5xx / Timeout

目的：确认 Codex 自己的 Retry 行为，避免与 New API / ACU 重试叠加。

需要观察：

- 客户端最大重试次数；
- 重试间隔；
- 请求 Body 是否相同；
- 是否复用 Request ID；
- 是否在错误后启动新 Response；
- 用户界面最终看到的错误。

### C10：Protocol / Invalid Request Error

目的：确认 Codex 对 400、413、Tool Schema 错误和上下文超限的处理。

### C11：用户取消与中断

目的：确认中断后的请求状态、是否会产生孤立 Tool Call、以及下一次继续时如何恢复。

### C12：模型切换和 Reasoning Effort

目的：确认用户在原生 Codex 中切换模型或推理档位后，请求字段如何变化。

## 8. Claude Code 测试矩阵

### A01：最简单单轮文本请求

需要观察：

- Method / Path；
- `anthropic-version`；
- `anthropic-beta`；
- Authorization / `x-api-key`；
- `model`；
- `system`；
- `messages`；
- `max_tokens`；
- `stream`；
- `tools`；
- `tool_choice`；
- `thinking`；
- `metadata`；
- Usage。

### A02：Streaming 文本请求

目的：建立 Claude Code 实际使用的 SSE 事件序列。

重点观察：

- `message_start`；
- `content_block_start`；
- `content_block_delta`；
- Text Delta；
- Thinking Delta；
- Input JSON Delta；
- `message_delta`；
- `message_stop`；
- Usage 更新位置。

### A03：单次 Tool Use

需要观察：

- Tool Schema；
- `tool_use.id`；
- Tool Input；
- 下一次请求中的 `tool_result.tool_use_id`；
- Tool Result 是否使用 `role = user`；
- Tool Error 是否包含 `is_error`；
- 同一 User Message 是否还包含人类文本。

### A04：同一用户任务连续多个 Step

目的：确认 Claude Code 是否每次重发完整 Messages History，以及如何区分人类输入和 Tool Result。

### A05：新的真实用户输入

分别测试：

- “继续”；
- 新约束；
- 新任务；
- 用户不满意；
- 要求重做。

观察新文本在 Messages 中的位置，以及是否存在 Session / Conversation 关联字段。

### A06：Plan Permission Mode

至少测试：

- `--permission-mode plan` 启动；
- 普通模式下自主 Planning；
- Plan 更新；
- 从 Plan 切换到执行；
- 执行失败后 Replanning。

重点观察：

- System Prompt 差异；
- Tool 白名单差异；
- 是否禁用 Edit / Write；
- 是否存在 Plan Tool；
- Permission Mode 是否进入 Header / Metadata；
- Planning 结束信号。

### A07：Goal / Agent 循环 / 多内部 Turn

目的：验证没有新的人类输入时多个内部 Turn 的实际请求形态。

需要观察：

- 每次请求是否重发全部历史；
- Messages 是否交替出现 Assistant `tool_use` 和 User `tool_result`；
- 是否存在内部 Task / Subagent Tool；
- 多 Agent / Subagent 结果如何回到主上下文；
- Client Turn 与网络请求的对应关系。

### A08：Continue / Resume

至少测试：

- `claude --continue`；
- `claude --resume <session_id>`；
- 进程重启后恢复；
- 当前目录相同 / 不同。

重点观察 Session ID 是否透传到网关，或只是客户端本地读取历史后重发 Messages。

### A09：Tool Error 与环境失败

分别制造：

- Tool 参数错误；
- 命令不存在；
- 权限不足；
- 文件不存在；
- 测试失败；
- 长命令 Timeout。

观察：

- `is_error`；
- Error 文本结构；
- 客户端是否自动重试；
- 是否产生新的 Planning；
- 是否发生 Context Compaction。

### A10：上游 429 / 5xx / Timeout

目的：确认 Claude Code 自己的 Retry 和退避行为，避免三层重复重试。

### A11：Thinking 与 Prompt Cache

观察：

- Thinking Request 字段；
- Thinking Content Block；
- Thinking Signature；
- Cache Control；
- Cache Creation Input Tokens；
- Cache Read Input Tokens；
- Model 切换后历史 Thinking 是否仍发送。

### A12：用户取消与中断

重点观察中断后的孤立 `tool_use` / `tool_result`、恢复行为和错误结构。

## 9. New API 观察矩阵

对 Codex 和 Claude Code 的每个关键 Fixture，至少比较：

1. 客户端直连一个标准兼容测试上游；
2. 客户端经过 New API；
3. 客户端经过 New API + ACU；
4. ACU 分别走 OpenRouter 与 CloseAI。

需要记录 New API 是否：

- 修改 Path；
- 改写 `model`；
- 转换 Responses 与 Chat Completions；
- 转换 Messages 与 OpenAI 格式；
- 删除未知字段；
- 修改 Tool ID；
- 修改 Thinking / Reasoning；
- 聚合或丢弃 Streaming 事件；
- 重算 Usage；
- 自己执行 Retry；
- 把上游错误包装成统一错误；
- 提供可供 ACU 使用的用户和 Token 身份；
- 支持把 ACU 实际模型、渠道和最终成本回写到使用记录。

## 10. Provider 兼容矩阵

每个 Execution Profile 至少记录：

| 字段 | 含义 |
|---|---|
| Provider | OpenRouter、CloseAI 或其他 |
| Model | 实际模型 ID |
| Native protocol | Responses / Messages / Chat Completions |
| Direct pass-through | 是否原生透传 |
| Streaming | 是否完整支持 |
| Tool Calling | 是否通过真实 Agent 测试 |
| Reasoning / Thinking | 是否支持及字段 |
| Context | 实测可用上下文 |
| Usage | Token、Cache、Reasoning 是否完整 |
| Error fidelity | 是否保留原始错误类别 |
| Actual model returned | 是否能确认最终模型 |
| Pricing source | 成本来源 |
| Last verified | 最近验证日期 |
| Fixture | 对应样本 ID |

不能因为 Provider 宣称“OpenAI Compatible”就自动标记全部能力为支持。

## 11. Session / Task / Routing Segment 关键问题清单

02 完成后必须能够回答：

### 11.1 Session

- 是否存在客户端原生 Session / Thread 标识；
- 是否稳定透传到 New API；
- Continue / Resume 是否仍使用该标识；
- 没有原生 ID 时，精确上下文前缀链是否可行；
- Tool ID 因果关系能否作为强关联。

### 11.2 新的外部输入

- 如何区分真实用户文本与 Claude `tool_result`；
- Codex Input Item 中如何识别人类新增内容；
- Goal 自动继续是否存在 User Role 但并非人工输入的情况；
- “继续”是否能与原 Task 可靠关联。

### 11.3 Planning

- 是否有强协议信号；
- Plan Tool 名称与 Schema；
- Plan Mode 是否改变 System Prompt 或 Tool 集；
- Planning 开始和结束能否高精度识别；
- 无强信号时，哪些组合规则最可靠。

### 11.4 Routing Lease

- Tool 长时间执行期间是否有网络活动；
- Streaming Heartbeat 是否存在；
- 10 分钟“任何有效活动续租”在两个客户端下如何落地；
- 客户端本地执行 Tool 时，网关是否完全看不到活动。

这里尤其需要确认：如果本地 Tool 执行超过 10 分钟且网关没有任何事件，下一次请求是否应视为 Lease 过期。当前默认答案是“是”，除非协议侦察发现可观察的客户端活动信号。

## 12. Planning 识别观察表

每个 Planning Fixture 填写：

| 观察项 | 结果 |
|---|---|
| 用户是否明确说 Plan |  |
| 客户端是否处于 Plan Mode |  |
| 原生字段 / Header |  |
| System Prompt 差异 |  |
| Tool Schema 差异 |  |
| Plan Tool 名称 |  |
| Plan Tool 参数 |  |
| Read / Search 比例 |  |
| 首次 Edit / Write 时间点 |  |
| Planning 结束强信号 |  |
| 是否发生 Replanning |  |
| 推荐规则置信度 |  |
| 对应 Fixture |  |

## 13. Failure 与 Error 观察表

每个错误样本必须先记录协议事实，再进入 `07-failure-taxonomy-and-rules.md` 设计规则。

| 字段 | 说明 |
|---|---|
| error_source | client / newapi / acu / provider / tool / environment |
| http_status | HTTP 状态 |
| protocol_error_type | 协议错误类型 |
| raw_message | 脱敏后的原文 |
| tool_name | 相关工具 |
| tool_call_id | Tool ID |
| is_error | Anthropic Tool Result 标识 |
| retry_by_client | 客户端是否重试 |
| retry_by_newapi | New API 是否重试 |
| retry_by_acu | ACU 是否重试 |
| request_body_same | 重试请求是否相同 |
| model_changed | 是否换模型 |
| channel_changed | 是否换渠道 |
| user_visible_error | 用户看到什么 |
| capability_failure_candidate | 是否可能属于能力型失败 |
| fixture_id | 样本 |

## 14. Streaming 观察要求

Streaming 不能只保存最终拼接文本。必须保存：

- Event Name；
- Event 原始 JSON；
- Event Sequence；
- 到达时间；
- 首 Token 延迟；
- Tool Arguments Delta；
- Thinking / Reasoning Delta；
- Usage Event；
- Completed / Stop Event；
- Error Event；
- 客户端取消时间；
- New API / ACU 转发后的 Event 差异。

需要确认 ACU 是否能够在不缓存完整响应后再返回的情况下：

- 实时转发；
- 同步记录；
- 获取最终 Usage；
- 确认 Actual Model；
- 生成最终 Ledger；
- 异步回写 New API。

## 15. Usage 与计费观察要求

对每个协议和 Provider 记录：

- Input Tokens；
- Cached Input Tokens；
- Cache Creation Tokens；
- Output Tokens；
- Reasoning Tokens；
- Total Tokens；
- Provider 返回的实际成本；
- New API 计算成本；
- ACU 计算成本；
- 最终扣费；
- Usage 出现在哪个响应 / Streaming Event；
- 失败 Attempt 是否返回 Usage；
- 客户端取消时是否计费；
- Tool Schema 和 Tool Result 是否计入输入。

最终需要形成一套“哪个来源是账本事实”的优先级规则，但该规则在完成真实样本前不在 02 中提前定稿。

## 16. 当前需要验证的高风险假设

### H01：Codex 会稳定发送 `previous_response_id`

当前状态：`未确认`。

不能把它作为唯一 Session 识别方式。历史版本曾存在 Codex 不使用该字段、改为自行管理历史的情况。

### H02：Claude Code Session ID 会透传到网关

当前状态：`未确认`。

`--resume` 支持 Session ID，只证明客户端本地存在 Session，不证明该 ID 出现在 Messages API 请求。

### H03：Planning 有稳定的原生强信号

当前状态：`未确认`。

Codex 和 Claude Code 都有 Plan 相关功能，但必须确认网络请求中是否可观察。

### H04：一个网络请求等于一个 Client Turn

当前状态：`暂时推断为错误`。

Goal 模式、Tool Use 和自动 Agent 循环可能产生多个内部 Turn 和多个网络请求，二者不能直接等同。

### H05：New API 可以无损支持两套原生协议

当前状态：`未确认`。

必须分别测试 Responses 与 Messages 的 Streaming、Tool、Reasoning / Thinking 和 Usage，不以“支持 OpenAI 兼容”为替代证据。

### H06：Provider 返回的 Model 字段能代表实际执行模型

当前状态：`未确认`。

中转渠道可能改写模型 ID 或只返回请求别名，需要对照 Provider 日志与响应。

### H07：本地 Tool 执行可以持续为 Routing Lease 续租

当前状态：`大概率不能直接观察`。

如果 Tool 在客户端本地运行，网关可能直到下一次模型请求才看到 Tool Result。需要实测并决定 Lease 计算细节。

## 17. 02 文档完成标准

本文件达到“协议观察基线完成”，至少需要：

### 17.1 Codex

- 完成 C01—C06、C08、C09、C11 的真实 Fixture；
- 至少一条真实多 Step Coding Task；
- 至少一条真实 Plan → Execution → Test → Repair 轨迹；
- 明确当前版本的上下文延续方式；
- 明确 Tool Call / Result 因果字段；
- 明确 Streaming 与 Usage 结构。

### 17.2 Claude Code

- 完成 A01—A06、A08—A12 的真实 Fixture；
- 至少一条真实多 Step Coding Task；
- 至少一条 Plan Mode 轨迹；
- 明确真实用户输入与 Tool Result 的区分方式；
- 明确 Continue / Resume 对网关可见的信号；
- 明确 Thinking、Cache 和 Usage 结构。

### 17.3 New API 与 Provider

- Codex 与 Claude Code 均通过 New API 成功完成真实任务；
- OpenRouter 与 CloseAI 至少各有一条经过验证的链路；
- 明确 New API 在请求和响应中的所有关键改写；
- 形成第一版 Provider Compatibility Matrix；
- 形成第一版 Retry Ownership 结论；
- 形成第一版 Usage Source of Truth 结论。

### 17.4 对后续文档的输出

02 完成后必须能为以下文档提供事实输入：

- `04`：Session、Task、Segment 和 Lease 规则修订；
- `05`：JudgeContextEnvelope 原始字段；
- `06`：Planning 强信号与组合规则；
- `07`：错误结构和能力失败 Evidence；
- `08`：Provider Retry、Fallback 和协议过滤；
- `09`：原始协议表、Streaming 表和索引；
- `10`：New API Hook、身份、扣费和前台回写方式；
- `11`：真实 Fixture 和端到端验收测试。

## 18. 协议侦察阶段不做

- 不在没有 Fixture 的情况下定死 Session 字段；
- 不在没有 Fixture 的情况下定死 Plan 规则；
- 不把官方 API 字段当成客户端实际行为；
- 不因为单个 Provider 测试成功就宣布协议通用兼容；
- 不训练 Session、Planning 或 Failure 模型；
- 不建设生产级流量审计平台；
- 不把临时 Capture Harness 变成第二套 Gateway；
- 不为了抓包修改模型正文或 Tool Result；
- 不在该阶段优化路由质量或节省率。

## 19. 首轮执行顺序

建议首轮协议侦察按以下顺序：

```text
1. 搭建专用测试仓库
2. 固定 Codex、Claude Code、New API 和 ACU 版本
3. 建立 Protocol Capture Harness
4. Codex 直连 Capture Harness，完成 C01—C04
5. Claude Code 直连 Capture Harness，完成 A01—A04
6. 加入 New API，比较 A / B 链路差异
7. 加入 ACU 透明转发，比较 B / C 链路差异
8. 接入 OpenRouter、CloseAI，形成 Provider Matrix
9. 完成 Planning、Resume、Error 和 Cancel 场景
10. 根据 Fixture 修订 04，并开始 05、06、07、08
```

优先先跑最小正常链路，再跑复杂错误。否则很难区分是协议基本适配错误，还是状态机与路由问题。

## 20. 参考来源

本文件的官方规范基线来自：

- OpenAI Responses API Reference；
- OpenAI Responses Streaming Events；
- OpenAI Codex 官方仓库中的 Model Provider 配置；
- Anthropic Messages API 与 Tool Use 文档；
- Anthropic Claude Code LLM Gateway、CLI 和 Plan Mode 文档。

所有参考链接和访问日期应在首次真实协议采集时补入 Fixture Manifest。官方资料用于确定“允许出现什么”，Fixture 用于确定“我们的客户端、New API 和 Provider 实际出现什么”。

## 21. 2026-07-28 首轮实测环境

本节只记录本轮 Fixture 能证明的事实；第 3—20 节的原始矩阵和侦察原则继续有效。

| 项目 | 本轮值 | 事实状态 |
|---|---|---|
| OS | Ubuntu 24.04.4 LTS，Linux 6.8.0-134-generic，x86_64 | 环境实测 |
| Node.js / npm / pnpm | 22.23.1 / 10.9.8 / 10.34.0 | 环境实测 |
| 基线 main | `bf5e4421635c35343c1ce20a1d33f191f30392b0` | Git 实测 |
| Recon 分支 | `productization/protocol-recon-v1` | Git 实测 |
| Codex | `codex-cli 0.145.0` | 客户端实测 |
| Claude Code | 未安装，命令不存在 | 阻塞 |
| New API | 未发现进程、版本、测试用户、Key 或余额配置 | 阻塞 |
| 当前 ACU | 本地 8402/8403 可访问；运行中 `dist` 的加载 Commit 无法确认 | 部分实测 |
| OpenRouter 凭证 | 测试凭证存在；不记录值 | 环境实测 |
| CloseAI 凭证 | OpenAI-compatible 测试凭证存在；不记录值 | 环境实测 |
| Capture 点 | 仅 A；B/C/D 部署插入权限不可用 | 部分实测 |

本轮原始数据保存在仓库外临时目录；仓库只提交确定性脱敏 Fixture。所有 Fixture 已通过自动 Secret 扫描。

## 22. Fixture 索引

| Fixture | 场景 | 原生链路 | 结果 | 状态 |
|---|---|---|---|---|
| `codex-0.145.0-C01-mock-001` | C01 最小文本 | Codex → Capture A → controlled Mock | 成功；8 个 SSE 事件 | `partial` |
| `codex-0.145.0-C01-closeai-001` | C01/C02 文本与 Streaming | Codex → Capture A → CloseAI | 成功；13 个 SSE 事件 | `partial` |
| `codex-0.145.0-C01-openrouter-001` | C01 Provider 尝试 | Codex → Capture A → OpenRouter | 6 次 403 后失败 | `failed` |
| `codex-0.145.0-C03-C04-closeai-001` | C03 Tool + C04 多 Step | Codex → Capture A → CloseAI | 2 Step 成功 | `partial` |
| `codex-0.145.0-C06-closeai-001` | C06 明确 Planning | Codex → Capture A → CloseAI | 8 Step，最终测试通过 | `partial` |
| `codex-0.145.0-C01-acu-current-001` | 当前 ACU Responses ingress | Codex → Capture A → current ACU | 6 次 404 后失败 | `failed` |

`partial` 表示原生客户端确实执行，但 New API、ACU 或全部四个采集点没有进入链路；不是能力“部分猜测”。

## 23. Codex 0.145.0 实测结论

### 23.1 路径与 Streaming

状态：`实测确认`
客户端：Codex 0.145.0
链路：Codex → Capture A → CloseAI
Fixture：`codex-0.145.0-C01-closeai-001`
结论：模型调用使用 `POST /v1/responses`，请求 `stream = true`；成功响应为 `text/event-stream`。客户端还会先请求 `GET /v1/models?client_version=0.145.0`。
生产规则适用性：Path 可作为强协议信号；`/models` 探测是辅助行为，不能创建 Step。
局限性：只验证自定义 Responses Provider 配置。

### 23.2 模型元数据影响请求形态

状态：`实测确认`
客户端：Codex 0.145.0
链路：Mock 与 CloseAI 对照
Fixture：`codex-0.145.0-C01-mock-001`、`codex-0.145.0-C01-closeai-001`
结论：当模型元数据缺失并使用 fallback metadata 时，请求声明完整工具和 `instructions`；CloseAI 文本样本中 `gpt-5.6-terra` 请求没有 `tools`/`instructions`。客户端请求形态会受模型元数据影响。
生产规则适用性：工具是否声明只能作为能力需求事实，不能单独判断 Task Phase。
局限性：模型也不同，尚不能把差异全部归因于 metadata。

### 23.3 多 Step 上下文

状态：`实测确认`
客户端：Codex 0.145.0
链路：Codex → Capture A → CloseAI
Fixture：`codex-0.145.0-C03-C04-closeai-001`
结论：两 Step 未出现 `previous_response_id`。第二次 `input` 重发消息，并包含上一 Step 的 `reasoning`、`function_call` 和匹配的 `function_call_output`。
生产规则适用性：Function Call/Output 因果 ID 与精确历史链可作为强 Session/Task/Segment 关联信号。
局限性：不能否定其他模式或版本使用 `previous_response_id`。

### 23.4 Correlation Header

状态：`实测确认`
客户端：Codex 0.145.0
链路：Codex → Capture A → CloseAI
Fixture：`codex-0.145.0-C03-C04-closeai-001`、`codex-0.145.0-C06-closeai-001`
结论：`session-id`、`thread-id`、`x-client-request-id` 在同一多 Step 运行中取值一致；Fixture 中确定性映射到同一占位符。
生产规则适用性：当前版本强候选，但必须在 C05/C08/Resume 与并发 Session 中验证后才能确定优先级。
局限性：只观察新建、未 Resume 的非交互 `codex exec`。

### 23.5 Tool Calling

状态：`实测确认`
客户端：Codex 0.145.0
链路：Codex → Capture A → CloseAI `gpt-5.5`
Fixture：`codex-0.145.0-C03-C04-closeai-001`
结论：Function arguments 通过多个 `response.function_call_arguments.delta` 到达；Codex 本地执行 shell 后，把 `function_call_output` 放入下一请求并保持 Call ID 因果关系。
生产规则适用性：Call ID 匹配是强连续性信号；Arguments 必须逐 delta 保存。
局限性：仅一次只读 shell 调用。

### 23.6 Planning

状态：`实测确认`
客户端：Codex 0.145.0
链路：Codex → Capture A → CloseAI `gpt-5.5`
Fixture：`codex-0.145.0-C06-closeai-001`
结论：实际 `update_plan` Function Call 创建五项计划；测试失败后再次调用以更新完成状态；最终调用完成计划。Plan 没有单独顶层 Responses 字段，而是通过 Function Call/Output 历史进入后续请求。
生产规则适用性：实际 `update_plan` Call 是 Planning 强信号；仅在 `tools` 中声明 `update_plan` 是弱信号。
局限性：用户明确要求 Plan；自主 Planning、Plan Permission Mode 不适用 Codex 且未测试；修改后失败的 Replanning 未发生。

## 24. Claude Code 实测结论

状态：`未执行/阻塞`
客户端：未安装
链路：无
Fixture：无
结论：A01—A12 均没有原生 Claude Code Fixture，不对 Messages、Tool Use、Thinking、Cache、Plan Permission、Continue/Resume 或 Retry 作实测声明。
生产规则适用性：不可使用。
所需最小条件：安装并固定 Claude Code 版本；提供隔离测试 Auth；允许指向 Capture A；最好提供 New API 测试链路。

## 25. New API 字段改写结论

状态：`未执行/阻塞`
客户端：Codex 0.145.0；Claude Code 未安装
链路：New API 未进入任何 Fixture
Fixture：无
结论：Path、Header、Model、Responses/Chat、Messages/OpenAI、Tool ID、Reasoning/Thinking、SSE、Usage、Error、Retry 与成本回写是否改写均未确认。
生产规则适用性：不可使用。

## 26. Provider 兼容矩阵 v0

| Provider / model | Native protocol | Streaming | Tool Calling | Reasoning | Usage | Actual model | Result | Fixture |
|---|---|---|---|---|---|---|---|---|
| CloseAI / `gpt-5.6-terra` | Responses | 文本成功 | 未测 | 请求字段存在；输出 0 reasoning token | completed event 完整 | 响应值匹配请求；无独立日志 | 成功 | `codex-0.145.0-C01-closeai-001` |
| CloseAI / `gpt-5.5` | Responses | 成功 | shell + multi Step 成功 | Reasoning Item 与 token 可见 | 含 cached/reasoning details | 响应值匹配请求；无独立日志 | 成功 | C03/C04、C06 CloseAI |
| OpenRouter / `openai/gpt-4.1-mini` | Responses | 未开始 | 未测 | 未测 | 无 | 未确认 | 403 TOS policy，失败 | `codex-0.145.0-C01-openrouter-001` |
| controlled Mock / `mock-model` | Responses | 成功 | 未测 | 未测 | 合成 | Mock 回显 | 仅 Harness/客户端测试 | `codex-0.145.0-C01-mock-001` |

OpenRouter 没有成功样本；不得标记为支持。CloseAI 成功也只适用于表中模型与能力，不外推 Messages 或其他模型。用户提供的 Anthropic Base URL `/anthropic` 因 Claude Code 缺失未测试。

## 27. Session 关联信号首版排序

基于现有 Codex Fixture，建议在 04 中暂时按以下顺序处理，同时保留版本门控：

1. Tool `call_id` → `function_call_output.call_id` 精确因果关系：实测强信号。
2. `session-id` / `thread-id` 一致且通过可信入口透传：强候选，待 Resume/并发验证。
3. 精确 Input Item 前缀链：实测可行；本轮多 Step 采用历史重发。
4. `x-client-request-id`：同一普通多 Step 一致，但 Provider 重试也复用；只能标识客户端 Turn/运行候选，不能去重计费。
5. `prompt_cache_key`、`x-codex-window-id`、`x-codex-turn-metadata`：已观察但语义未拆解，暂作辅助信号。
6. 同 Key、时间和 Tool Schema 指纹：仍是弱关联。

任何 Header 在 New API 是否保留均未确认，因此不能直接写成全链路生产规则。

## 28. 人类输入与 Tool Result 区分

Codex 本轮强结构规则：

- `function_call_output` 是 Tool Result，不是新的真实人类输入；
- 新的人类输入应来自新增 Message/Input 文本，并结合上一请求尾部做增量比较；
- `role` 单独不足以跨协议通用判断，Claude Messages 仍未实测；
- 测试输出、shell 输出和 Plan Tool Output 均不能触发 `new_external_input`。

C05 的“继续/新约束/换任务/重做/不满意”未执行，因此这些文本如何进入 Codex Input 仍未实测。

## 29. Planning 强信号与弱信号

强信号候选：

- 实际 `update_plan` Function Call；
- 后续 `update_plan` 更新同一计划状态；
- 全部计划项完成并伴随最终验证，可作为 Plan 结束组合强信号。

弱信号：

- `tools` 中声明 `update_plan`；
- 用户文本出现 plan；
- 单次 Read/Search；
- 第一次 Edit；
- Assistant 自述“开始计划/执行”。

首次 Edit 可以辅助识别 execution 开始，但本轮不足以证明它总是 Planning 结束。

## 30. Resume / Continue

状态：`未执行`。C05、C08、A05、A08 均无 Fixture。不得假定 Header 在进程重启后稳定，也不得假定 `previous_response_id` 或完整历史重发。当前 04 中“请继续属于新的外部输入并重新 Judge”保持产品设计，但协议提取规则仍待验证。

## 31. Retry Ownership

状态：`实测确认（客户端层）`
Fixture：`codex-0.145.0-C01-openrouter-001`、`codex-0.145.0-C01-acu-current-001`。

Codex 对 403 和 404 都显示 1/5—5/5 reconnect，并产生六次 POST。OpenRouter 样本的起始间隔约为 0.62s、0.76s、1.09s、1.74s、4.77s。同一 `x-client-request-id` 被复用，但 Body Hash 不同。New API/ACU/SDK Retry 未进入完整链路，无法确定总 Attempt 上限。

生产建议：不得用 `x-client-request-id` 单独做响应 Dedup 或成本 Dedup；后续必须给每一真实 Provider Attempt 独立 ID，并在多层 Retry 测试后设置总预算。

## 32. Usage Source of Truth

本轮可确认：

- Responses 成功流的最终 `response.completed.response.usage` 被 Codex接受；
- Usage 包含 input、cached input、output、reasoning output 和 total；
- C03/C04 中缓存输入从 0 增至 12,672；C06 后续 Step 超过 15k；
- 403/404 失败无 Usage，无法确认是否计费；
- Provider 响应的模型字段与请求相同，但无 Provider 日志独立佐证；
- New API 扣费与 ACU Ledger 未进入链路。

因此首版优先级只能暂定为：Provider 最终 Usage 事件（若可信且完整）→ Provider 账单/日志对账 → 明确标记的估算。New API 或 ACU 自算值不能在未对账时覆盖 Provider Usage。

## 33. Streaming 事件差异

CloseAI 文本样本出现 `response.created`、`response.in_progress`、Item/Content start、多个 Text Delta、done 和 `response.completed`。Tool 样本还出现大量 `response.function_call_arguments.delta` 与 done。Capture Harness 按原始事件边界保存，未先聚合再返回。

只有 Capture A，故无法判断 New API/ACU 是否聚合、丢弃、重排或改写事件。Mock 的 8 事件序列只能验证客户端/Harness接受受控事件，不能作为 Provider 基线。

## 34. Actual Model 判定

本轮判定层级：

1. Provider `response.completed.response.model`：CloseAI 两个模型与请求一致；
2. Provider Request/Generation 日志：本轮不可访问；
3. New API/ACU 回写：未执行；
4. 仅请求别名：不能证明实际后端。

因此 CloseAI 表中写“响应声明匹配”，不写“物理后端独立确认”。OpenRouter/ACU 失败样本写 `unconfirmed`。

## 35. 对 04 状态机的事实修订建议

1. 在 Codex 0.145.0 解析器中加入已观察的 Session/Thread Header，但在 New API 透传、Resume 和并发验证前使用版本门控，不作为唯一主键。
2. 将 Function Call/Output 精确因果关系提升为已实测强信号。
3. 支持“客户端重发完整/增长的 Responses Item 历史”作为主要上下文链；不能依赖 `previous_response_id`。
4. `update_plan` 仅声明不触发 `plan_start`；实际 Call 才是强触发。
5. Plan 更新 Tool Result 属于内部 Tool Event，不是 `new_external_input`。
6. `x-client-request-id` 跨 Provider Retry 复用，禁止用作 Attempt 唯一键或计费幂等键。
7. `/models` 探测失败不应自动创建 Task/Step 或能力失败；本轮两种 Provider 上均为非致命。
8. 本轮没有证据修改 10 分钟 Routing Lease、新外部输入重新 Judge、同 Segment 不降级等已确认产品设计。

## 36. 尚未确认的问题

- C05 五类新人类输入的协议增量；C08 Resume；C11 Cancel。
- C06 自主 Planning、修改后失败的 Replanning 和 Plan Mode 差异。
- Claude Code A01—A12 全部协议事实。
- New API A/B 差异、ACU B/C 差异和响应 D 差异。
- OpenRouter 成功的 Responses/Tool/Usage/Actual Model。
- CloseAI Anthropic `/anthropic/v1/messages`。
- Provider、New API、ACU、SDK 多层 Retry Ownership 与总预算。
- 客户端取消后的 Provider 计费和孤立 Tool Call。
- Header 在 New API 中是否保留、可信和可防伪。
- New API 是否能接收 ACU 实际模型、渠道、Usage 和成本回写。
