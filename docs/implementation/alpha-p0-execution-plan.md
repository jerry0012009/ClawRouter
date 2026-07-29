# ACU Router Alpha P0 实施计划

> 状态：执行中  
> 日期：2026-07-29  
> 实现分支：`productization/alpha-p0-implementation`  
> 基线：`origin/productization/protocol-recon-v1@63e941a`  
> 直接依据：`docs/productization/04a-alpha-state-machine-implementation-profile.md`、`docs/productization/11-alpha-acceptance.md`

## 1. 五日目标和验收边界

本实现只交付邀请制 Alpha 的最小闭环：原生 Codex Responses 与 Claude Code Messages 经 New API 进入独立 ACU Router，由 PostgreSQL 持久化状态、Judge 和当前连续价值公式选择并锁定 Execution Profile，直接调用 Provider，透明转发 Streaming / Tool / Thinking，最后通过幂等 Usage Report 由 New API 扣费。

正式支持：

- `POST /v1/responses`；
- `POST /v1/messages`；
- `GET /v1/models`；
- 显式模型；
- `acu-auto`。

`acu-high`、OpenClaw、Hermes、10 分钟 Routing Lease、完整 Step Engine、实时健康路由和第二上游成功链路不作为 P0 阻断项。未获得真实凭证或外部日志时，相关 Gate 只报告 `blocked`，不使用 Mock 冒充真实支持。

## 2. 基线审计

### 2.1 工程命令

| 命令 | 结果 |
|---|---|
| `npm install` | 通过；依赖已是最新；审计报告 7 项漏洞（2 moderate、4 high、1 critical），不自动执行破坏性升级 |
| `npm run typecheck` | 通过 |
| `npm test` | 通过；17 files passed、1 skipped；106 tests passed、3 skipped |
| `npm run build` | 通过；ESM 与 DTS |
| `npm run lint` | 基线失败；46 errors，位于既有 `src/cli.ts`、`src/index.ts`、`src/models.ts`、`src/proxy.ts`、`src/response-store.ts` |

新增文件必须单独通过 ESLint；修改旧文件以基线差分验证不得新增错误。本轮不清理全部历史 lint。

### 2.2 代码事实

- `src/proxy.ts` 当前只正式处理 `/chat/completions`，但已具备 HTTP server、Abort、Timeout、错误分类、SSE 写入、Provider 调用、Attempt Trace 与 Usage 解析。
- `src/session.ts` 是带 30 分钟过期的进程内模型 Pin，不能承载 Alpha 状态事实。
- `src/acu/storage.ts` 是 SQLite Demo Store；保留只读开发用途，Alpha 新链路不得双写它。
- `src/acu/judge.ts` 已具备确定性上下文序列化、裁剪、严格 JSON 解析、Judge Usage / Cost 和 Rules fallback 基础。
- `src/acu/decision.ts` 已实现硬能力候选筛选后的曲线估计、Pareto Frontier 与连续 `valueUtility`；P0 不另写路由公式。
- `src/acu/catalog.ts`、`src/acu/execution-profile.ts`、`src/models.ts` 提供冷启动 Catalog、价格和能力元数据，但协议 / Channel 能力需 P0 配置覆盖。
- `src/ledger.ts` 的字段思路可复用，JSONL 不作为 Alpha 新流量账本。
- 侦察 Fixture 已确认 Codex 0.145.0 的 Responses 历史 / `call_id`，Claude Code 2.1.220 的 Messages 历史 / ToolResult 混合块 / Thinking Signature，以及当前 New API 的两条原生透传链路。

### 2.3 New API 事实

- 隔离镜像：`calciumion/new-api:v1.0.0-rc.22`；
- OCI Revision：`bc14c18f6024e79cba1c08d02cd007796e12d668`；
- Digest：`sha256:d600f20c2781e1a173c2a02f8c33b0c4b1b4e8e5a8b107bafaf2442ae2c9386c`；
- Source：`https://github.com/QuantumNous/new-api`；
- 当前仅有 Docker 镜像，需在 ClawRouter 同级独立检出该 Revision 并创建 `acu/alpha-p0-integration`。

## 3. 复用映射

| 当前模块 | P0 复用 | P0 边界 |
|---|---|---|
| `src/proxy.ts` | server 生命周期、请求取消、安全响应写入、错误 Envelope 的已验证行为 | 原生协议入口迁入独立小模块；不继续堆积状态机 |
| `src/upstream-proxy.ts` / Undici | 透明 HTTP 请求与流读取模式 | 关闭隐藏 Retry；每次调用必须对应一个 Attempt |
| `src/errors.ts` / `src/retry.ts` | 429 / 5xx / Timeout / Overload 分类思想 | ProviderError 不触发 Judge；总 Provider Attempt 上限为 2 |
| `src/acu/judge.ts` | Judge Prompt、解析、裁剪、Usage / Cost、Rules fallback | 输入增加 Canonical Envelope 与持久化状态；幂等由 PostgreSQL 保证 |
| `src/acu/strategy.ts` | Live Judge → Rules Strategy 降级链 | 加最近 Evaluation 与管理员安全 Profile 的显式来源 |
| `src/acu/decision.ts` | 原样复用 Pareto + 连续价值公式 | 只扩充 Profile 硬过滤和可重放快照，不设置 88 硬阈值 |
| `src/acu/catalog.ts` | 冷启动质量曲线、价格、工具能力 | Channel / native protocol 能力放入 Alpha Provider 配置 |
| `src/acu/storage.ts` | 字段和测试思路 | SQLite 不进入 Alpha 请求链，不双写 |
| `src/ledger.ts` | Usage / Attempt 字段命名 | JSONL 不作为 Alpha 成本事实来源 |
| Protocol Capture Fixture | Responses / Messages、Tool ID、Thinking、Retry 回归输入 | Mock 只证明网关行为，不证明真实 Provider 支持 |

## 4. 文件级修改计划

### Milestone 1：PostgreSQL 基础

- `migrations/acu/0001_alpha_p0.sql`：十张表、金额 `NUMERIC(20,10)`、唯一幂等键、活动 Segment 部分唯一索引、用户范围索引。
- `migrations/acu/0001_alpha_p0.down.sql`：只删除本 Migration 创建的对象。
- `src/alpha/database.ts`：轻量 `pg` Pool / Transaction 接口，不引入 ORM。
- `src/alpha/repository.ts`：Session、Task、Segment、Event、Judge、Route、Logical Request、Attempt、Payload、Usage Report 的最小 Repository。
- `src/alpha/secrets.ts`：持久化前 Header / Payload Secret 清理。
- `test/alpha/postgres-*`：Migration、约束、跨用户隔离、幂等与重启恢复。真实 PostgreSQL 测试使用显式测试 DSN；无 DSN 时只允许明确 skip，Docker Gate 必须实际执行。

### Milestone 2：原生协议 Gateway

- `src/alpha/protocol/types.ts`：保留原始 Payload 的 Canonical Envelope。
- `src/alpha/protocol/responses.ts`：Responses 增量历史、HumanMessage、`function_call` / `function_call_output`、`update_plan` 与 Usage 提取。
- `src/alpha/protocol/messages.ts`：Messages 历史、混合 `role=user` 中 Human Text / `tool_result` 拆分、Thinking / Signature、Plan 指纹与 Usage 提取。
- `src/alpha/provider.ts`：原生 Path、认证、模型映射和最多两次显式 Attempt；不粗暴转换为 Chat Completions。
- `src/alpha/stream-relay.ts`：逐字节转发并旁路采集，响应首字节后禁止切换，Cancel 传递。
- `src/alpha/gateway.ts`：`/v1/responses`、`/v1/messages`、`/v1/models` 和 health；请求正文不注入 ACU 文案。
- `src/proxy.ts`：仅增加清晰的 Alpha Gateway 委派 Hook，旧 Chat 路径保持。

### Milestone 3：状态与 Trigger

- `src/alpha/identity.ts`：用户范围内基于精确历史增长、Tool ID 因果链和版本化 Header 候选解析 Session；不设固定过期。
- `src/alpha/events.ts`：标准 Event、event hash、失败签名和进展规则。
- `src/alpha/state-machine.ts`：Task / active Segment、Trigger 优先级、16 accepted response refresh；不实现完整 Step Engine。
- `src/alpha/planning.ts`：Codex `update_plan`、Claude 版本化 Plan-only 指纹与 `ExitPlanMode`。

### Milestone 4：Judge 与 Route

- `src/alpha/judge-context.ts`：Canonical Envelope + Task / Plan / Failure / Route 状态。
- `src/alpha/routing.ts`：调用现有 `recommendModel`，保存全部候选 / Pareto / Utility；显式模型严格 Judge=0。
- `test/alpha/formula-replay.test.ts`：固定输入与 `src/acu/decision.ts` 一致，覆盖全低于 88、全高于 88和 `meetsQualityTarget` 非硬过滤。

### Milestone 5：Provider 恢复与 Usage

- `src/alpha/execution.ts`：Logical Request / Attempt 分离、Retry Owner、最大 2 Attempt、同模型等价 Channel 优先。
- `src/alpha/usage.ts`：保留 Provider 原始 Usage，成本来源明确，生成唯一 Usage Report。
- `src/alpha/usage-finalizer.ts`：PostgreSQL Outbox 的安全投递；响应成功不因 Finalize 短暂失败回滚。

### Milestone 6：New API 独立仓库

在同级 `new-api` 源码仓库的独立分支中定位并最小修改：

1. ACU Channel 转发前删除所有客户端 `x-acu-*`；
2. 对 user / token / log / request / timestamp / body hash 注入 HMAC-SHA256；
3. ACU Channel Retry=0 且静态最终扣费关闭 / 归零；
4. 增加唯一 `report_idempotency_key` 的 Usage Finalize，复用既有 Log / 扣费函数。

不可逆余额结构变更前停止请求人工选择；否则只做可回滚 Migration 和源码提交。

### Milestone 7：部署与验收

- `deploy/alpha/docker-compose.yml`：`new-api`、`acu-router`、`postgres-newapi`、`postgres-acu`；只有 New API 发布端口。
- `deploy/alpha/.env.example`：只包含变量名和安全说明。
- `docs/implementation/alpha-p0-runbook.md`：启动、Migration、健康检查、Fixture E2E 和回滚。
- `docs/implementation/alpha-p0-implementation-report.md`：逐 Gate 证据、Commit、测试、阻塞和 P1。
- `test/alpha/*`：Gate A—H 的自动化与原生客户端脚本；真实客户端 / Provider 场景使用隔离测试环境。

## 5. 依赖顺序与事务原则

```text
Migration / Repository
→ Protocol Normalizer
→ Identity / State / Trigger
→ Judge / Route
→ Provider / Stream / Attempt
→ Usage Outbox
→ New API Finalize
→ Compose E2E
```

Provider 调用前完成短事务并持久化 Logical Request 与 Attempt 占位；网络调用不持有事务。Provider 完成后以短事务完成 Attempt、Payload、Logical Request、Segment 计数和 Usage Report。自动路由无法持久化核心状态时失败关闭。

## 6. 里程碑测试

| Milestone | 必须通过的证据 |
|---|---|
| M1 | 十表 Migration up/down、唯一约束、active Segment、金额精度、Secret 清理、跨用户隔离、重启读取 |
| M2 | Responses / Messages 非流与流、Tool ID、Thinking Signature、错误 Envelope、Cancel、字节与事件顺序、无正文注入 |
| M3 | 历史重放去重、ToolResult 非 Human、六类 Trigger、首次失败不 Judge、第二次无进展 Judge、16 accepted response |
| M4 | 显式模型 Judge=0、Judge 幂等与 fallback、Formula Replay、低于 / 高于 88、普通 Tool 循环复用 Route |
| M5 | Provider 503 不改 Difficulty、最多两 Attempt、首字节后不切换、Usage 来源、失败计费标记、Outbox 幂等 |
| M6 | Header 伪造失败、签名校验、Retry=0、静态扣费禁用、Finalize 重放不重复扣费、Log 实际字段更新 |
| M7 | Docker 私网、Migration、Codex / Claude Code E2E、数据库恢复、Secret 扫描、Gate A—H 报告 |

## 7. 主要风险与处理

- **真实凭证 / Provider 日志缺失**：不阻塞 Mock 和离线 Gate；真实 E2E 标记 blocked，绝不提交凭证或伪造支持。
- **New API Revision 不一致**：必须检出 OCI 标注的精确 Revision；若源码行为与镜像不一致则停止集成修改并报告。
- **大 Payload 与 Streaming**：P0 在内存旁路采集当前请求流，完成 / 中断后单行写 PostgreSQL；设置可配置上限并保持客户端透传优先。
- **客户端多层 Retry**：仅在 ACU 内限制 Provider Attempt 为 2；Ingress 幂等识别重放，不用单个客户端 Header 作为成本幂等键。
- **状态并发**：对 Task 行锁定并依赖 active Segment 部分唯一索引；冲突安全重读。
- **旧代理回归**：Alpha 原生路径模块化委派，保留全部现有测试；不重写旧 Chat Completion 执行链。
- **依赖漏洞**：记录审计结果；只在不改变 P0 协议行为的情况下升级，不能用 `npm audit fix --force`。

## 8. 明确不做

- Embedding、pgvector、RAG、Memory、长期画像或训练；
- Redis、消息队列、微服务拆分、通用插件框架或大型 ORM；
- 完整 Step Workflow Engine；
- New API 前端、账户、余额、兑换码系统重写；
- Provider 账单自动对账和 90 天删除 Worker；
- OpenClaw / Hermes / 多 Agent 专门适配；
- 将 Responses / Messages 统一转为 Chat Completions；
- 全仓历史 lint 与全部旧 SQLite 数据迁移；
- 绕过 OpenRouter 的账户政策限制。

## 9. Commit 策略

每个里程碑在其测试通过后独立 Commit。ClawRouter 与 New API 分别提交、分别推送，不合并 main，不 force push，不提交 `acu-router.log`、`acu_export/`、真实 `.env`、数据库数据卷或任何 Secret。
