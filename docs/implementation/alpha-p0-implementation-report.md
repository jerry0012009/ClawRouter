# ACU Router Alpha P0 实施与验收报告

> 日期：2026-07-29
>
> ClawRouter 分支：`productization/alpha-p0-implementation`
>
> New API 分支：`acu/alpha-p0-integration`
>
> 结论：五日 P0 工程闭环和 Gate A—H 的工程验证已完成；邀请制上线样本门槛尚未达到，因此本报告不宣称 Alpha 已完成真实用户规模验收。

## 1. 执行摘要

本轮实现了以下闭环：

```text
Codex 0.145.0 / Claude Code 2.1.220
→ New API 鉴权、钱包准入、可信身份
→ 独立 ACU Router
→ 原生 Responses / Messages
→ Session / Task / Segment / Trigger / Judge / Route
→ CloseAI 原生 Provider 执行与最多一次恢复
→ PostgreSQL 十表完整轨迹
→ New API 幂等最终扣费与日志展示
```

所有显式模型请求也经过 ACU，但不调用 Judge、不更换模型。`acu-auto` 只在 Trigger 上 Judge，普通 Tool 循环复用 Segment Profile。当前连续价值公式继续复用 `src/acu/decision.ts`，没有引入“低于 88 淘汰”的第二套路由逻辑。

工程 Gate A—H 均有自动化或隔离真实链路证据。最终上线标准仍未满足的原因是：隔离工程流量只有 94 个 Logical Request、13 个多请求 Task、1 个测试用户，不等同于 `≥100 / ≥20 / ≥3 名真实邀请用户`。OpenRouter 仍受合法账户 TOS 403 阻塞；P0 成功 Provider 为 CloseAI。

## 2. 版本与环境

| 项目 | 实测值 |
|---|---|
| OS | Ubuntu 24.04，Linux 6.8.0-134-generic x86_64 |
| Node.js | v22.23.1 |
| npm | 10.9.8 |
| Codex | 0.145.0 |
| Claude Code | 2.1.220 |
| Docker Engine | 29.1.3 |
| Docker Compose | 2.40.3 |
| PostgreSQL | 16-alpine，New API 与 ACU 独立数据卷 |
| New API 基线 | v1.0.0-rc.22 / `bc14c18f6024e79cba1c08d02cd007796e12d668` |
| New API 页面版本 | `/api/status` 的 `version` 为空；以源码 Revision、分支 SHA 和镜像 ID 为准 |
| ACU 镜像 ID | `sha256:94a262aa7645611274e77ea6795b7b53f2fdafb81d142f603eb745c44a5a753c` |
| New API 镜像 ID | `sha256:b2a25dc428ee209041a4de9562ceb77d797d878ba5363dcadfacd0de3a18a356` |
| 成功 Provider | CloseAI OpenAI Responses / Anthropic Messages |
| OpenRouter | blocked：403 TOS policy，未绕过 |

镜像 ID 是本机可复现构建的 content ID，不冒充 Registry Digest。部署只发布 `127.0.0.1:3200 → New API:3000`；ACU 与两个 PostgreSQL 没有宿主机 published port。

## 3. 分支与 Commit

### 3.1 ClawRouter

基于 `origin/productization/protocol-recon-v1` 的实施提交：

| Commit | 内容 |
|---|---|
| `c608206dd7610ac113955b0ed107df0fbd828454` | Alpha P0 实施计划 |
| `f001fa3fef36648ec792c2f7e4a639bd9cd483d5` | PostgreSQL persistence foundation |
| `bb30624ea05ca4e95af6065e0ed47ec6fd2746d2` | 原生协议 Canonical Envelope |
| `046ec3ac3d9437b9e077526d14044e9b4296bdf2` | Responses / Messages Gateway |
| `74463988c6d93a85257af9e68aaf3cfb6f8e5da8` | Session / Task / Segment / Trigger |
| `74db57f991667641ccfad08da715ce69829e6dbc` | Judge 与连续价值路由 |
| `a9c4342e1bb92ad2d22decd1505fa64ddab512ef` | Provider Attempt 与恢复控制 |
| `17721d046a1b6936134fcf5b1f4cc5c526940782` | Usage Report durable outbox |
| `6a720ce733a81d3071eb2e0ca9fb554415129723` | 原生客户端 Planning 信号修订 |
| `fb639c39dea255ebb58941d2db9ddf67e2c03fcd` | 独立管理员完整 Trace |
| `d8ce07737ee1f68691fe26e49d7b77081607067a` | 隔离 Compose 与运行手册 |
| `7af1eaa39a56dba92795c5b2dbb9379e6c18bf11` | 修复生产 HTTP 依赖安全告警 |

本报告自身 Commit 以最终 Git handoff 为准，避免在文件中产生不可满足的自引用 SHA。

### 3.2 New API

基于固定 Revision `bc14c18f6024e79cba1c08d02cd007796e12d668`：

| Commit | 内容 |
|---|---|
| `7b33a4c9785eda835f8ef45c1724cd6d0330f7c0` | ACU Channel 可信身份与 Header 清理 |
| `5547f37279f67fe5c55db6057a4acb8a6c679b04` | 幂等 Usage Finalize |
| `c7c36854233e70ed92aeacea0fa1d5ff3bd3956e` | ACU Channel 原生协议候选选择 |
| `3fd30aad21f43c6753beee126d28cf687f466a83` | ACU 请求只做钱包准入，最终价格由 Finalize 决定 |
| `0c3be471126093126e82f8623160e5393d9a12ae` | 可信原生客户端版本签名 |
| `787562500fad5dc79d5a3bf9742730dc3c56a5d5` | New API 日志详情展示最终 ACU Route |

## 4. Milestone 完成情况

| Milestone | 状态 | 主要证据 |
|---|---|---|
| 0 基线与计划 | 完成 | `alpha-p0-execution-plan.md`，保留 46 个历史 lint 错误基线 |
| 1 PostgreSQL | 完成 | 十张表、NUMERIC 金额、唯一幂等键、active Segment 唯一索引、恢复与用户隔离测试 |
| 2 原生 Gateway | 完成 | `/v1/responses`、`/v1/messages`、`/v1/models`；SSE/Tool/Thinking/Cancel 透明测试 |
| 3 状态与 Trigger | 完成 | Codex/Claude 连续性、Human/Tool 分离、Planning、Failure、去重、16-response refresh |
| 4 Judge 与 Route | 完成 | Trigger-only Judge、回退链、完整公式快照、Formula Replay |
| 5 Provider 与恢复 | 完成 | CloseAI 两种原生协议、Attempt 上限 2、visible-output 禁止静默切换 |
| 6 New API | 完成 | 私网 HMAC、Retry=0、静态扣费旁路、Finalize 幂等、最终日志展示 |
| 7 部署与工程验收 | 完成 | 四服务 Compose、健康检查、Migration、回滚、真实客户端与运行中 Trace 验证 |
| 邀请用户样本验收 | 未完成 | 当前 94 / 13 / 1，未达到 100 / 20 / 3 |

## 5. 核心实现

### 5.1 PostgreSQL

Migration：

- `migrations/acu/0001_alpha_p0.sql`
- `migrations/acu/0001_alpha_p0.down.sql`

创建且只创建十张 `acu_*` P0 表：Session、Task、Segment、Event、Judge Evaluation、Route Decision、Logical Request、Attempt、Payload、Usage Report。没有 vector、embedding 或 memory 表。Alpha 新流量不写 SQLite。

管理员内部接口：

```text
GET /internal/admin/traces/<logical_request_id>
Authorization: Bearer <REDACTED_ADMIN_TRACE_TOKEN>
```

接口只允许私网来源，管理员 Token 与 New API HMAC Secret 分离；无 Token 为 401，错误 Token 为 403，正确 Token 返回 Session → Task → Segments → Events → Judges → Routes → Attempts → Payloads → Usage。响应为 `no-store`，普通用户查询仍必须带用户范围。

### 5.2 原生协议

- Responses 与 Messages 请求不会先粗暴转换为 Chat Completions。
- Provider 请求只替换目标模型和 Provider 凭证；Tool ID、Thinking Signature 与原生 SSE 字节保持因果一致。
- Canonical Envelope 只供状态与路由使用，原始 Payload 同时保存。
- 客户端取消通过 AbortSignal 传至 Provider，Attempt 保存取消状态和已输出前缀。

### 5.3 状态、Planning 与 Trigger

- Codex 通过 Responses Item 历史重发和 `call_id` 维持连续性；不依赖 `previous_response_id`。
- Claude Code 通过 Messages 历史、`tool_use.id` / `tool_result.tool_use_id` 维持连续性；`role=user` 内的 Tool Result 不被误判为 HumanMessage。
- Codex `update_plan` 是 PlanStarted 强信号；实际 Patch/Edit/Test/Build 且无 Plan 重建是 PlanFinished 强信号。
- Claude Code 2.1.x 的版本化 Plan-only 指纹是 PlanStarted；`ExitPlanMode` 是 PlanFinished。
- Planning Segment 使用 88 临时质量偏好；PlanFinished 新建 Execution Segment、撤销 88 并重新 Judge。
- Provider Retry、普通 Tool 循环和 PlanUpdated 不重复 Judge；16 个 accepted Model Response 才触发 safety refresh。

### 5.4 路由与恢复

- 显式模型：Judge=0、不改模型、P0 不自动跨 Channel failover，但完整记账。
- `acu-auto`：硬兼容过滤 → Pareto Frontier → 风险调整 → quality/cost/value utility → `argmax(valueUtility)`。
- `meetsQualityTarget` 仅解释；所有候选低于 88 仍可选择，全部高于 88 时成本仍参与。
- New API 对 ACU Channel Retry 固定为 0；ACU 是网关 Retry Owner。
- 每个 Logical Request 最多 2 个 Provider Attempt。首次客户端可见 SSE 后禁止在同一响应静默拼接其他结果。
- Provider Error 不改变 Difficulty；第二次相同核心 Execution Failure 且无进展才重新 Judge，并只允许保持或升级。

### 5.5 计费

- New API 在转发前做用户、Token 与余额准入，不用静态模型价格做 ACU 最终扣费。
- ACU 从 Provider 原生 Usage 生成唯一 Usage Report，并通过 durable outbox 回写。
- New API 用 `report_idempotency_key` 和 `logical_request_id` 原子幂等扣款；同 key 不同 Body 拒绝。
- Finalize 更新实际模型、Provider、Channel、Token、输入/输出/缓存/推理 Token 与最终成本。
- New API 网页 Usage Log 详情新增 ACU Route 区域显示上述最终路由与成本。

## 6. 真实链路证据

所有下列测试均使用隔离测试用户、Token、余额、目录和 Provider Key；未使用生产数据。

### 6.1 Codex 0.145.0

| 场景 | 结果 |
|---|---|
| Responses Text Streaming | 通过，原生客户端输出 `NATIVE-CODEX-ALPHA-OK` |
| Shell / Function Tool | 通过，18 次命令、2 个文件修改，Sandbox 测试通过 |
| 多 Step | 通过，历史前缀与 Tool Call/Result 保持连续 |
| PlanStarted / PlanFinished | 通过，`update_plan → Planning(88) → Patch/Test → Execution(0)`，三次对应 Judge |
| Repair | 通过，失败后继续执行并通过测试 |
| Cancel | 通过，7 个取消 Attempt 可审计，保存已输出字节 |
| Resume | 通过，同目录恢复同一客户端 Thread，并正确记得先前标记 |

### 6.2 Claude Code 2.1.220

| 场景 | 结果 |
|---|---|
| Messages Streaming | 通过，原生客户端输出 `NATIVE-CLAUDE-ALPHA-OK` |
| tool_use / tool_result | 通过，10 次 Tool Use（7 Bash、3 Edit），Tool ID 因果一致 |
| Thinking / Signature | 通过，透明转发 |
| 多 Step | 通过，11 Turn，修改 3 个文件，测试 4/4 通过 |
| Plan Mode / ExitPlanMode | 通过，Plan-only 指纹 → Planning；ExitPlanMode → Execution |
| Repair | 通过，执行错误进入 Evidence 并继续修复 |
| Cancel | 通过，Streaming 2 秒取消后 request/attempt 均为 cancelled，已输出 480 字节 |
| Resume | 通过，同一 Session UUID，正确重建并复述 3 个文件历史 |

### 6.3 Provider 与数据状态

隔离数据库最终统计：

- 94 个 Logical Request：86 个 Provider success，8 个 cancelled；
- Responses：31 success / 7 cancelled；Messages：55 success / 1 cancelled；
- 94 个 Usage Report 全部 `acknowledged`；
- 35 Session、35 Task，13 个 Task 有多个请求，单 Task 最大 11 个请求；
- New API 日志中 38 条最终 `gpt-5.5 / closeai-openai-primary`，56 条最终 `claude-sonnet-5 / closeai-anthropic-primary`；
- ACU Router、New API、两个 PostgreSQL 容器均为 healthy；
- ACU 与 PostgreSQL 均没有 published port。

## 7. 测试结果

### 7.1 ClawRouter

| 命令 | 结果 |
|---|---|
| `npm install` | 通过，lockfile 可复现 |
| `npm run typecheck` | 通过 |
| `npm test`（带临时 PostgreSQL） | 25 files 通过、160 tests 通过；2 files / 10 tests 因独立外部条件跳过 |
| `alpha-processor.test.ts`（独立临时 PostgreSQL） | 7/7 通过 |
| `npm run build` | 通过 |
| 修改源码 eslint | 0 error / 0 warning |
| 全仓 `npm run lint` | 基线仍为 46 errors / 0 warnings，位于 `cli.ts`、`index.ts`、`models.ts`、`proxy.ts`、`response-store.ts`；本轮未新增 |
| `npm audit --omit=dev` | 0 finding；运行时 `undici` 已升级到 6.28.0 |
| 全依赖 `npm audit` | 6 个 dev-only 告警：2 moderate、3 high、1 critical；修复要求 Vitest 主版本升级，列入 P1 |

`full-flow.test.ts` 的 3 个测试需要外部 funded BlockRun Wallet，不属于本次 CloseAI Alpha 链路；`alpha-processor` 因使用独立数据库变量而单独执行。测试中的 OpenClaw scanner 在服务器未安装 OpenClaw 全局包时会打印不可用提示；本轮 Secret Gate 使用仓库内协议 Scanner 和 staged-diff 扫描验证。

### 7.2 New API

| 命令 | 结果 |
|---|---|
| `/opt/go1.25.1/bin/go test ./...` | 所有含测试的 Go package 通过 |
| ACU 专项 Go 测试 | 身份、防伪、私网、Retry=0、协议选择、静态价格旁路、Finalize 幂等均通过 |
| 两个修改前端文件 oxlint | 0 error / 0 warning |
| 两个修改前端文件 oxfmt | 通过 |
| `bun run typecheck` | 通过 |
| `bun run build` | 通过；最终镜像内确认包含 ACU Route UI |

### 7.3 Secret 与部署

- `npm run protocol:scan`：0 finding；
- 部署 staged diff scanner：0 finding；
- Fixture Schema 与 Secret 测试包含在 160 项测试内；
- `docker compose config --quiet`：通过；
- `execution-profiles.json`：JSON 解析通过；
- 运行中管理员 Trace：401 / 403 / 200 鉴权矩阵与十类链路键通过；
- `.env`、Provider Key、数据库密码、HMAC、管理员 Token、`acu-router.log`、`acu_export/` 和原始 Capture 均未提交。

## 8. Gate A—H

| Gate | 工程状态 | 证据与边界 |
|---|---|---|
| A 原生协议 | PASS | 两个原生客户端真实 Streaming、Tool、多 Step、Cancel；透明性自动测试 |
| B 模式与 Judge | PASS | 显式模型 Judge=0；acu-auto Trigger/去重/16 refresh 自动测试及真实路由 |
| C Planning | PASS | Codex 和 Claude 原生 Planning 实测；88 与 PlanUpdated 行为自动测试 |
| D 路由公式 | PASS | Formula Replay、低于/高于 88、Pareto/Utility 固定测试 |
| E Failure/恢复 | PASS | 重复失败、Provider 503、Attempt≤2、visible-output 边界自动测试；真实 CloseAI 成功/取消链路 |
| F PostgreSQL/恢复 | PASS | 十表、唯一约束、隔离、重启恢复、管理员全 Trace 的临时库与运行栈验证 |
| G New API/扣费 | PASS | 未授权阻断、防伪、Retry=0、幂等重放不二扣、真实日志和最终 UI 字段 |
| H 安全 | PASS | 私网部署、独立管理员身份、Payload 清理、Fixture/差异扫描 0 finding、生产依赖审计 0 |

这里的 PASS 表示五日 P0 工程 Gate 已验证，不覆盖第 11 文档要求的真实邀请用户样本数量。

## 9. Stop-Ship 与尚未完成项

### 9.1 当前 Stop-Ship

工程验证未发现 11 文档列出的十类 Stop-Ship 行为。但在邀请用户前仍必须完成真实样本门槛；未达到样本门槛时不得将本报告解释为全面上线批准。

### 9.2 尚未完成 / Blocked

1. 真实邀请用户样本：当前工程流量 94 请求 / 13 多请求 Task / 1 测试用户，要求为 100 / 20 / 3；必须由至少 3 名真实设计伙伴完成，不能用脚本补数。
2. OpenRouter：403 TOS policy，保持 blocked，不规避。扩大外部 Alpha 前需合法成功账户，或书面确认只使用 CloseAI。
3. Live Judge Provider：当前隔离实测使用确定性 Rules fallback；Judge Runner 与失败回退有测试，但真实 Judge API 成本/延迟仍需受控凭证验证。
4. 取消计费：客户端在 Provider 最终 Usage Event 前取消时，ACU 只能记录可见字节和零最终 Usage；Provider 可能已经产生不可观测成本。邀请制阶段需监控 Provider 控制台并人工对账，P1 增加取消成本证据。
5. 开发依赖审计：Vitest/Vite 工具链仍有 6 个 dev-only 告警；生产 `npm ci --omit=dev` 为 0 finding。P1 在独立兼容性任务中升级 Vitest 4。
6. `acu-high`、OpenClaw、Hermes、第二 Provider、Provider 自动账单对账、90 天删除 Worker均按范围留到 P1。

## 10. P1 建议

优先级顺序：

1. 完成 3 名邀请用户的 100/20 样本与人工任务质量复核；
2. 验证真实 Judge Provider，并量化延迟、成本和 Rules fallback 触发率；
3. 增加取消请求与 Provider 账单对账，明确 failed billed cost；
4. 建立第二条合法 Provider 成功链路和健康度；
5. 升级 Vitest/Vite 开发工具链并恢复 OpenClaw Scanner 环境；
6. 增加管理员 Trace 审计日志、细粒度角色和显式保留/删除流程；
7. 再评估 Subscription Billing、并发额度冻结、10 分钟 Routing Lease 和更完整 Step 生命周期。

## 11. 启动与回滚

环境模板、启动、客户端配置、管理员 Trace、Migration、停止和回滚命令见 `docs/implementation/alpha-p0-runbook.md`。

一条命令启动：

```bash
cd deploy/alpha
cp .env.example .env
# 仅在本地填写测试 Secret
docker compose --env-file .env up -d --build
```

禁止提交 `.env`，禁止 `down -v`，禁止合并 main 或 force push。
