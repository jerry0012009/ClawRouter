# ACU Router Alpha RC1：成本控制、真实客户端与用户验收补充 Goal

本补充立即追加到当前 Alpha RC1 任务。继续真实测试，但每一笔费用必须有明确目的、预算和可复核证据。

## Goal

在不重写 Gateway、状态机、PostgreSQL、New API 集成和 `acu-routing-model-v0.1` 的前提下，完成：

1. 解释 2026-07-29 测试费用，排除重复扣费、失控 Retry、并发和长上下文异常；
2. 用真实 `codex-acu` / `claude-acu` 通过实际 Base URL 跑真实仓库任务；
3. 建立用户级模型白名单，支持“所有当前真实可用且具备自动路由资格的模型”；
4. 为用户提供任务级 Difficulty、候选、选择、成本和解释可视化；
5. 验收通过后输出公网 Base URL 和创始人测试步骤；
6. 形成 Coding Agent 协议兼容矩阵，为后续更多客户端接入预留，不得在未验证前宣称所有客户端都已支持。

不得修改 main，不得 force push，不得自动修改生产 DNS。真实 Secret 只放服务器本地 `.env`。

## 一、先做费用归因，再恢复批量付费测试

继续单元测试、Fixture、Mock 和离线公式重放。真实 Provider 测试可以继续，但在费用归因完成前只允许串行、最小化 Smoke Test，不进行高价模型批量长任务或 Soak。

对截图所示当日费用逐项归因，至少输出：

- provider、requested_model、selected_model、actual_model；
- protocol、test_run_id、logical_request_id、task_id、segment_id；
- purpose：judge / preflight / routing / native_e2e / failure_injection / soak；
- input、cached input、output、reasoning Token；
- Provider 成本、ACU 计算成本、New API 最终扣费；
- Attempt、Retry、Fallback、Trigger；
- 是否显式模型；
- Judge 是 live / cache_hit / recent_evaluation / rules_fallback；
- 是否取消后仍发生 Provider 计费。

重点解释：`gpt-5.5`、`claude-sonnet-5`、`claude-sonnet-4-6`、`claude-opus-4-8`、GPT-5.6 Sol/Terra/Luna 的费用来源。

必须回答：

1. 哪些费用来自 `acu-auto`，哪些来自显式 Preflight；
2. 是否存在 New API Retry 和 ACU Retry 双重执行；
3. 是否存在相同 Trigger 重复 Judge；
4. 是否一次启动了多个并发 Agent；
5. 是否存在超长历史重发、无上限输出或推理 Token 异常；
6. Provider Usage、ACU 账本和 New API 扣费是否一致；
7. 为什么 GPT-5.6 已存在时仍调用大量 GPT-5.5。

生成：

`docs/implementation/alpha-rc1-cost-incident-report.md`

如发现重复扣费、无法解释的账单差异、失控循环或重复 Provider Attempt，视为 Stop-Ship，先最小修复并增加回归测试。

## 二、测试预算闸门

为测试 Harness / 运维层增加 fail-closed 预算保护，不修改正常用户路由公式。

建议支持：

```text
ACU_LIVE_TEST_ENABLED=false
ACU_TEST_RUN_BUDGET_CNY=5
ACU_TEST_TOTAL_BUDGET_CNY=30
ACU_TEST_MAX_CONCURRENCY=1
ACU_TEST_MAX_OUTPUT_TOKENS=4096
ACU_TEST_REQUIRE_APPROVAL_ABOVE_CNY=5
```

要求：

- 未显式开启时禁止 Harness 调用付费 Provider；
- 每轮开始前估算最坏成本；
- 达到单轮或累计预算立即停止后续请求；
- 默认并发 1，Preflight 串行；
- 高价模型只跑最小必要协议 Smoke；
- 状态机、非法 JSON、429/5xx 等优先使用 Fixture/受控故障入口；
- 只有协议、actual_model、Usage 和真实客户端行为需要取证时调用真实 Provider；
- 每个 Live Test Run 结束立即报告本轮花费与累计花费。

预算不是为了少测试，而是确保每一笔测试费产生新的证据。

## 三、GPT-5.5 与 GPT-5.6 的真实关系

不得因版本号更新自动替换 GPT-5.5。核对：

- GPT-5.5 是否仍是某协议唯一成功 Profile、显式 Preflight、Fallback 或 Frontier；
- GPT-5.6 Sol/Terra/Luna 在当前 Catalog 是否 `toolCallSupport=false`；
- CloseAI 是否真实支持 GPT-5.6 的原生 Responses / Messages、Streaming、Tool Call / Tool Result；
- actual_model 是否与请求一致；
- 价格、Usage、上下文和 Thinking 是否可计算；
- 曲线证据是否足以进入自动路由。

只有对应协议全部通过后，GPT-5.6 才可进入 `acu-auto`。若 GPT-5.5 仅因旧配置继续被大量调用，应修正 Profile；若它仍有不可替代的协议或有效前沿价值，应保留并说明。

## 四、Task Harness 是前戏，最终必须跑真实原生客户端

服务器 AI 自行编写 Task 的用途是确定性覆盖 Difficulty、状态机、Fallback 和公式边界，不等于用户验收。

完成 Harness 后，必须使用真实配置：

- `codex-acu` → New API / ACU Base URL → `/v1/responses`；
- `claude-acu` → New API / ACU Base URL → `/v1/messages`。

在一个专用、可丢弃但真实的 Git 仓库中分别完成：

- 代码阅读；
- 小功能开发；
- Bug 修复；
- 多文件修改；
- 单元测试失败后 Repair；
- Planning → Execution；
- Cancel 与 Resume。

不得只发送手工构造 HTTP Body 就宣称 Codex / Claude Code 已通过。

验收证据必须包括客户端版本、配置、真实命令、任务结果、测试结果、Route Trace、actual_model、Usage 和成本。

## 五、公网创始人测试 Gate

只有以下条件通过后，才输出可供创始人使用的公网 Base URL：

- 无重复扣费、身份伪造、Secret 泄露和协议破坏；
- Live Judge 可用，失败不阻断；
- Responses / Messages 真实客户端核心流程通过；
- Route、actual_model、Usage、成本和扣费一致；
- 每种协议候选数按实际准确报告；
- HTTPS、限流、余额、紧急停止和回滚可执行；
- 已设置测试账户预算和余额上限。

通过后报告：

```text
PUBLIC_BASE_URL=
OPENAI_BASE_URL=
ANTHROPIC_BASE_URL=
测试用户创建方式=
充值/兑换码步骤=
Token 创建步骤=
Codex 配置命令=
Claude Code 配置命令=
acu-auto 模型名=
查看 Route/成本的位置=
紧急停止联系人或命令=
```

不得在 Git 或报告中提交真实 Token。公网地址由服务器实际部署结果给出，不得猜测。

## 六、用户模型白名单

核对当前 Trusted Request Context 和 New API 前台是否已经真正开放模型白名单。区分：

- 后端已有 `allowedModelIds` 能力；
- 管理员可配置；
- 普通用户可在前台自助配置。

如普通用户前台尚未开放，本轮实现最小可用策略：

1. `all_routing_eligible`：允许所有当前可调用、协议兼容、价格明确且有曲线的模型；
2. `custom_allowlist`：用户选择允许参加自动路由的模型；
3. `explicit_only`：只允许显式模型，不使用 `acu-auto`。

默认建议为 `all_routing_eligible`，但不得包含 Preflight 失败、blocked、无价格或 `routingEligible=false` 的模型。

白名单改变后应有策略版本，并写入每次 Route Decision，避免事后无法复现。

## 七、任务过程可视化

在现有 New API 使用记录或最小独立页面中，至少展示：

- Task / Segment 时间线；
- Trigger 与 Judge 来源；
- Difficulty、Entropy、质量偏好；
- 初始候选、硬过滤原因、Pareto Frontier；
- 每个候选的预估质量、保守质量、预估成本和 Value Utility；
- 最终选择模型和简洁解释；
- actual_model；
- 输入、缓存、输出、推理 Token；
- Judge 成本、模型成本、总成本；
- 与最高能力合法模型的成本差异；
- Planning、PlanFinished、Failure 后的重新路由。

不得把预估质量表述为真实成功率，不得把单次估算节省表述为已验证长期节省。

## 八、更多 Coding Agent 接入规划

Alpha 当前首先保证：

- OpenAI Responses 原生客户端；
- Anthropic Messages 原生客户端；
- 保留 Chat Completions 兼容入口。

建立 Coding Agent 兼容矩阵，至少记录每个客户端的：

- 可配置 Base URL；
- 使用协议；
- Auth 方式；
- Streaming；
- Tool Call / Tool Result；
- Planning / Resume；
- Session 识别；
- Usage；
- 已实测版本和状态。

优先采用协议适配，不为每个 Agent 写独立业务路由。无法配置自定义 Base URL、使用封闭专有传输或证书固定的客户端，应如实标为暂不支持。

本轮不要求一次支持所有 Coding Agent，但架构和文档不得写死为只有 Codex / Claude Code。

## 九、测试成功后的 P1 筛选

只有真实创始人测试通过后，再从证据中筛选 P1，优先级只看用户能否稳定获得“成本更低且质量可接受”：

- 质量结果反馈与任务成功判定；
- 用户/团队质量偏好和成本上限；
- 模型/Provider 健康度与自动降权；
- 路由校准和真实任务曲线更新；
- 取消请求成本对账；
- 用户级成本预算与告警；
- Route 解释和节省报告；
- 更多 Coding Agent 协议验证。

不要在真实测试成功前扩散到完整 SaaS 工作台、复杂策略编辑器或大规模公开注册。

## 十、当前任务完成时的报告

在原 RC1 报告中增加：

- 当日费用归因与是否存在异常；
- 测试预算与实际花费；
- Harness 测试和真实客户端测试的分别统计；
- 白名单能力状态；
- 公网测试是否已具备条件；
- 尚需人工输入；
- 是否建议创始人开始充值和 Codex 公网接入测试。

没有通过 Gate 时，不得输出“可以开始用户测试”。通过后，明确告诉创始人公网 Base URL 和完整操作步骤。