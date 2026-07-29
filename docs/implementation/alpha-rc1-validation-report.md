# ACU Router Alpha RC1 验证报告

> 日期：2026-07-29；ClawRouter 分支 `productization/alpha-rc1-validation`；New API 分支 `acu/alpha-rc1-validation`。
>
> 总体结论：Live Judge 与真实 5/6 模型原生候选池已验证；**尚不具备邀请 3 名创始人用户进行公网测试的条件**。

## 1. 环境与范围

- Linux 6.8.0-134-generic x86_64；Node v22.23.1；npm 10.9.8；Docker 29.1.3；Compose 2.40.3。
- Codex 0.145.0；Claude Code 2.1.220。
- New API 基线 Commit `787562500fad5dc79d5a3bf9742730dc3c56a5d5`，隔离 PostgreSQL；New API 仅绑定 `127.0.0.1:3200`，ACU/PostgreSQL 无宿主机端口。
- Provider：CloseAI 合法测试账户。OpenRouter 仍因 403 TOS policy blocked，未规避。
- 无生产用户、生产账户或生产数据；Secret 仅在服务器本地环境。

## 2. Live Judge

本轮落库 70 次真实 `upstream_live`，覆盖六类 Trigger：`task_start/new_task=59`、`human_message=1`、`plan_started=8`、`plan_finished=1`、`repeated_failure=1`、`safety_refresh=1`。

| 指标 | 结果 |
|---|---:|
| 成功调用 | 70/70 |
| Prompt / Completion Token | 405,544 / 10,005 |
| 总成本 | USD 0.0638331 |
| 平均成本 | USD 0.0009119014 |
| P50 / P95 延迟 | 2,999.5 / 4,104.55 ms |
| Difficulty 范围 | 2.4–83.2 |

独立验证结果：首次真实调用 `upstream_live`；同输入第二次 `cache_hit/cost=0`；受控非法 JSON 为 `rules_fallback/cost=0`；有近期评估时为 `recent_evaluation/cost=0`。非法 JSON 是测试 Fetch，不是 CloseAI 主动返回。所有路径复用 `readAcuRuntimeConfig`、`AcuJudgeClient` 和现有 Judge Runner，没有第二套配置、缓存或难度公式。

`plan_finished` 会建立新 Segment、重新 Judge、重新生成候选并重新选择；该样本前后都选择 Luna，不能把“重新选择”误写成“一定换模型”。`repeated_failure` 使用 `hold_or_upgrade`，样本未降级。

## 3. 原生能力与 Execution Profile

最终配置 11 个协议级 Profile、每协议模型不重复：Responses 5 个，Messages 6 个。

| 协议 | Economy | Value | Strong | Frontier / Recovery |
|---|---|---|---|---|
| Responses | GPT-5.4 Mini | GPT-5.6 Luna | GPT-5.6 Terra | GPT-5.5、GPT-5.6 Sol |
| Messages | GPT-5.4 Mini | GPT-5.6 Luna | GPT-5.6 Terra、Claude Sonnet 5 | Claude Opus 4.8、GPT-5.5 |

上述模型均真实通过各自精确原生 Path、Text Streaming、Tool Call→Tool Result、Thinking/Reasoning 请求接受、Provider Usage、价格计算、actual_model 一致和上下文下界探针。GPT Profile 验证下界为 32,768 Token；Claude 原生 Profile 为 65,536 Token。探针下界不等于宣称完整广告窗口。

Thinking 结论：Responses 模型提供 reasoning item/token 证据；Claude Opus 返回带签名 Thinking Block；其他 Messages 候选接受 adaptive thinking 但简单探针未必产生可见 Thinking Block，因此只能标记“协议行为明确”，不能标记“每次都可见”。

明确排除示例：Qwen/GLM/DeepSeek 等模型在 `/v1/responses` 返回不支持原生 Responses；部分 Messages 模型返回非 Anthropic 原生事件形状；Gemini 一条路径 404。它们没有被虚构为 Profile。

## 4. 路由矩阵与分布

矩阵设计为每协议 14 项：4 simple、4 medium、4 hard、2 Planning。Codex 14/14 客户端进程成功；Claude 的 8 个 simple/medium 成功，4 hard 和 2 Planning 因测试账户余额不足失败。任务分类是场景设计，实际 Difficulty 由 Judge 决定，没有人为修改 Difficulty 或曲线。

| 协议 | 配置 Profile | 每次合法 modelId | 初始/硬过滤候选 | Pareto 范围 | 实际选择 |
|---|---:|---:|---:|---:|---|
| Responses | 5 | 5 | 5/5 | 1–3 | Luna 17、Sol 4 |
| Messages | 6 | 6 | 6/6 | 1–4 | Luna 33、Opus 5 |

两种协议都从 4–6 个真实合法候选进行价值路由；每协议选择过至少两个模型，合计三个模型。未被选择的主要原因不是硬阈值：Mini、GPT-5.5、Sonnet 多数被 Pareto 支配；Terra 多次进入 Frontier，但 Value Utility 未超过 Luna/Sol/Opus。质量偏好 88 只进入连续效用，测试中简单任务仍选择 Luna而非强行 Frontier。

Difficulty 选择分布：Responses 0–29 Luna 13、30–54 Luna 61、55–79 Sol 17；Messages 0–29 Luna 28、30–54 Luna 33、55–79 Opus 4、80+ Opus 1。数据库中的 Route Decision 保存全部候选的预测质量、保守质量、调用成本、Fallback 成本、总成本、Pareto 和 Value Utility；新增观测字段记录配置/协议/初始/硬过滤/Pareto 数量与排除原因，未修改 `acu-routing-model-v0.1`。

显式 GPT-5.5 真实验证：Judge=0、候选数组为空、不替换模型、requested/selected/actual 一致、Provider/最终成本均 USD 0.00057，不计算 ACU 节省率。

## 5. 一致性、Retry 和成本

- 185 个 Logical Request 对应 185 个 Attempt，均为 index 1；本轮没有 ACU Retry/Fallback Attempt，也没有 New API Retry。
- 成功 Attempt 的 selected model 与 actual_model 不一致数为 0；成功 Provider Usage 与 Usage Report 成本不一致数为 0。
- 已知 ACU Provider 成本 USD 0.5215872，Judge USD 0.05758605，已确认最终扣费 USD 0.57917325。
- 28 个 cancelled Attempt 的 `provider_billed` 未知且账本成本为 0，是 Stop-Ship；详见 `alpha-rc1-cost-incident-report.md`。
- 真实 Preflight 和独立 Judge Smoke 在 ACU 外执行，不能与 New API 扣费混算；预算事故报告单列。

## 6. 用户白名单与可视化

本轮完成最小用户白名单链路：

- `all_routing_eligible`：默认，仍受 Catalog、协议、工具、Thinking、Context、健康和管理员策略硬过滤；
- `custom_allowlist`：普通用户在设置页填写允许参加 `acu-auto` 的 modelId；
- `explicit_only`：`acu-auto` fail-closed，仅允许显式模型请求。

New API 删除客户端伪造的 `x-acu-*`，从用户设置生成策略版本并纳入 HMAC；ACU 验签后把策略用于现有 `allowedModelIds` 过滤，并将策略版本写入 Route Decision。没有新增第二套路由公式。

任务过程可视化尚未完成。当前完整数据只能通过 ACU 管理员 Trace 和 New API Usage Log 组合查看，不能声称普通用户已有完整 Timeline/Pareto UI。

## 7. 原生客户端与状态机缺口

- Codex 通过 Responses Item 历史重发维持连续性；其 14 项任务可形成多 Step/Planning Segment。
- Claude Code 通过 Messages 历史与 `tool_use/tool_result` 维持协议连续性，但本样本出现过多 `task_start`：38 个 Route Decision 对应 14 个设计任务，说明当前 Session/Task 关联仍可能把连续请求拆成新 Task。
- `role=user` 不能直接等同 HumanMessage；必须先排除纯 `tool_result`。Planning 强信号分别是 Codex `update_plan` 与 Claude `ExitPlanMode/Plan Tool`。
- Claude 高难和 Planning 未完成真实成功闭环；余额不足失败是有效结果，不是协议支持证明。

## 8. 公网 Gate 与 P1

结论：**不建议创始人充值或开始公网 Codex/Claude 测试，不输出 PUBLIC_BASE_URL。**

阻塞项：取消成本对账、1 个 pending Logical Request、CloseAI 余额不足、Claude 高难/Planning 未成功、Claude Session/Task 关联过度切分、普通用户 Route 可视化缺失、域名/证书/公网反向代理未由人工配置、尚无 3 名真实邀请用户证据。

P1 只保留证据驱动项：取消成本对账、任务成功反馈、用户预算/告警、健康降权、路由校准、Route 解释与更多客户端协议矩阵；不扩散为完整 SaaS 工作台。

## 9. 已知测试状态

- RC1 Profile/公式/预算单测通过；真实 Provider 验证结果见上文。
- 新增代码要求单独 lint 通过；仓库全量 lint 仍有历史基线错误，未在 RC1 扩散修复。
- 最终 Commit、全量 Typecheck/Test/Build 和 Secret Scan 结果在提交后补入本报告的最终交付回复，以 GitHub SHA 为准。
