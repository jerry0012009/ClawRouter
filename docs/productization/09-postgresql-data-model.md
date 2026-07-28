# ACU Router PostgreSQL 数据模型

> 状态：五日 Alpha 产品设计初稿，待创始人审阅  
> 版本：v0.2  
> 日期：2026-07-29  
> 依赖：`03-system-architecture.md`、`04-session-task-routing-segment-state-machine-v2.md`、`04a-alpha-state-machine-implementation-profile.md`、`05-judge-and-trigger-policy.md`、`06-planning-detection.md`、`07-failure-taxonomy-and-blockage-rules.md`、`08-routing-and-upstream-recovery-policy.md`

## 1. 文档目的

本文只定义五日 Alpha 为完成原生 Coding Agent 路由闭环所需的最小 PostgreSQL Schema。

P0 需要做到：

1. 保存完整原生输入、输出和可审计轨迹；
2. 表达 Session、Task、Routing Segment、Event、Judge、Route、逻辑请求和 Provider Attempt；
3. 支持 Trigger、Route 和扣费幂等；
4. 保存当前 ACU 连续价值公式的全部输入、候选、中间量和结果；
5. 将最终模型、Channel、Usage 和成本可靠回写 New API；
6. 防止跨用户数据混淆。

本文不是数据平台、长期记忆或训练数据系统设计。

## 2. 第一阶段明确不做

P0 不实现：

- `pgvector`；
- Embedding；
- 向量检索；
- RAG Memory；
- 用户长期画像；
- 自动偏好学习；
- 语义 Session 匹配；
- 在线训练数据流水线；
- 数据仓库、湖仓或复杂 OLAP；
- 自动内容摘要；
- 自动删除后台任务；
- 对象存储或外部原始内容仓库。

第一阶段只把完整事实保存到 PostgreSQL。未来团队引入专家后，再从这些原始事实建设向量化、Memory 和训练管线。

## 3. 数据所有权边界

### 3.1 New API 是控制面事实来源

New API 继续负责：

- 用户与登录；
- API Key / Token；
- 余额、额度与兑换码；
- 用户网页使用记录；
- 最终余额扣减与充值账本。

ACU 不复制真实 API Key、密码或余额账本，只保存 New API 提供的稳定外部标识：

```text
newapi_user_id
newapi_token_id
newapi_log_id
```

### 3.2 ACU PostgreSQL 是路由数据面事实来源

ACU 负责：

- Session / Task / Routing Segment；
- 标准 Event 与 Trigger；
- Judge Evaluation；
- Route Decision 与当前公式中间量；
- Logical Request 与 Provider Attempt；
- 原生请求、响应和 SSE；
- Provider Usage 与实际成本；
- 向 New API 回写的最终 Usage Report。

**最终扣费只由 New API 执行。** ACU 生成可审计、幂等的 Usage Report，不直接维护用户余额。

## 4. P0 表清单

五日 Alpha 只使用十张核心表：

1. `acu_sessions`；
2. `acu_tasks`；
3. `acu_segments`；
4. `acu_events`；
5. `acu_judge_evaluations`；
6. `acu_route_decisions`；
7. `acu_logical_requests`；
8. `acu_attempts`；
9. `acu_payloads`；
10. `acu_usage_reports`。

不为每个 JSON 内部结构单独建表。候选模型、Factor、概率、Plan、Failure Evidence 和 Route Explanation 优先保存为版本化 `JSONB`，避免五日内过度规范化。

## 5. 通用字段约定

- 主键使用应用生成的带前缀 `TEXT` ID，例如 `ses_`、`task_`、`seg_`、`evt_`、`judge_`、`route_`、`req_`、`att_`；
- 时间统一使用 `TIMESTAMPTZ`；
- Token 使用 `BIGINT`；
- 美元金额使用 `NUMERIC(20,10)`，不得使用浮点金额；
- 公式分数允许使用 `DOUBLE PRECISION`，但必须保存 Formula Version；
- 原生结构和版本化快照使用 `JSONB`；
- 原始 SSE 或非 JSON 文本使用 `TEXT`；
- 所有租户数据必须带 `newapi_user_id`，或可沿外键确定用户范围；
- 所有普通查询必须显式带用户范围，管理员查询除外；
- 不依赖 Client Request ID 作为唯一幂等键。

## 6. `acu_sessions`

用途：保存原生客户端连续对话身份，不设置固定时间过期。

核心字段：

```text
session_id                  TEXT PK
newapi_user_id              TEXT NOT NULL
newapi_token_id             TEXT
client_name                 TEXT NOT NULL
client_version              TEXT
native_protocol             TEXT NOT NULL
continuity_fingerprint      TEXT
history_prefix_hash         TEXT
system_fingerprint          TEXT
tool_schema_fingerprint     TEXT
last_tool_call_id           TEXT
current_task_id             TEXT
current_segment_id          TEXT
last_activity_at            TIMESTAMPTZ NOT NULL
created_at                  TIMESTAMPTZ NOT NULL
updated_at                  TIMESTAMPTZ NOT NULL
metadata_json               JSONB NOT NULL DEFAULT '{}'
```

约束：

- Session 不因时间自动失效；
- 强历史前缀、Tool ID 因果链或可信 Resume 成立时可以长期恢复；
- 工作目录、时间相近或单个 Session Header 不能单独作为主键；
- 连续性不确定时创建新 Session，而不是错误合并。

最小索引：

```text
(newapi_user_id, updated_at desc)
(newapi_user_id, history_prefix_hash)
(newapi_user_id, last_tool_call_id)
```

## 7. `acu_tasks`

用途：保存用户目标级 Task。Alpha 简化为一个 Session 同时只有一个活动 Task。

核心字段：

```text
task_id                     TEXT PK
session_id                  TEXT FK -> acu_sessions
newapi_user_id              TEXT NOT NULL
root_goal_text              TEXT
root_goal_hash              TEXT
phase                       TEXT NOT NULL
base_quality_target         DOUBLE PRECISION NOT NULL
capability_escalation_floor DOUBLE PRECISION NOT NULL DEFAULT 0
status                      TEXT NOT NULL
created_at                  TIMESTAMPTZ NOT NULL
updated_at                  TIMESTAMPTZ NOT NULL
metadata_json               JSONB NOT NULL DEFAULT '{}'
```

“继续”“补充约束”“重做”“还是不行”默认延续当前 Task；明确 New Goal / Reset、明显目标替换或连续性无法确认时创建新 Task。

## 8. `acu_segments`

用途：保存一次 Judge / Route 共享的路由边界。

核心字段：

```text
segment_id                         TEXT PK
task_id                            TEXT FK -> acu_tasks
newapi_user_id                     TEXT NOT NULL
previous_segment_id                TEXT
creation_reason                    TEXT NOT NULL
phase                              TEXT NOT NULL
status                             TEXT NOT NULL
judge_evaluation_id                TEXT
route_decision_id                  TEXT
selected_execution_profile_id      TEXT
task_base_quality_target           DOUBLE PRECISION NOT NULL
capability_escalation_floor        DOUBLE PRECISION NOT NULL
temporary_phase_override           DOUBLE PRECISION NOT NULL
effective_quality_target           DOUBLE PRECISION NOT NULL
accepted_responses_since_judge      INTEGER NOT NULL DEFAULT 0
last_activity_at                    TIMESTAMPTZ NOT NULL
created_at                          TIMESTAMPTZ NOT NULL
superseded_at                       TIMESTAMPTZ
metadata_json                       JSONB NOT NULL DEFAULT '{}'
```

约束：

- 同一 Task 最多一个 `active` Segment；
- P0 默认 `max_unjudged_model_responses = 16`；
- 每个被接受的逻辑 Model Response 递增一次；
- Retry、Provider Attempt、SSE Event 和历史重发不递增；
- Judge 成功或 Fallback Evaluation 形成新 Segment 时归零；
- 88 只保存为连续价值公式偏好锚点，不代表候选预测分硬阈值。

建议部分唯一索引：

```sql
CREATE UNIQUE INDEX uq_active_segment_per_task
ON acu_segments(task_id)
WHERE status = 'active';
```

## 9. `acu_events`

用途：保存 Protocol Normalizer 产生的确定性事实和 Trigger 输入。

核心字段：

```text
event_id                    TEXT PK
session_id                  TEXT FK
task_id                     TEXT FK
segment_id                  TEXT FK
logical_request_id          TEXT
event_type                  TEXT NOT NULL
event_hash                  TEXT NOT NULL
evidence_strength           TEXT NOT NULL
source_protocol             TEXT NOT NULL
source_client               TEXT NOT NULL
source_client_version       TEXT
source_payload_id           TEXT
tool_call_id                TEXT
failure_signature           TEXT
failure_signature_version   TEXT
is_duplicate                BOOLEAN NOT NULL DEFAULT false
occurred_at                 TIMESTAMPTZ NOT NULL
metadata_json               JSONB NOT NULL DEFAULT '{}'
```

P0 Event：

```text
human_message
tool_call
tool_result
plan_started
plan_updated
plan_finished
execution_failure
provider_error
```

幂等约束：

```text
UNIQUE(session_id, event_hash)
```

同一历史重发不得重复生成 Event 或触发 Judge。

## 10. `acu_judge_evaluations`

用途：保存 Judge 调用、Fallback、输出、成本和幂等状态。

核心字段：

```text
judge_evaluation_id         TEXT PK
newapi_user_id              TEXT NOT NULL
task_id                     TEXT FK
segment_id                  TEXT FK
trigger_event_id            TEXT FK
judge_idempotency_key       TEXT NOT NULL UNIQUE
judge_status                TEXT NOT NULL
judge_result_source         TEXT NOT NULL
judge_model                 TEXT
judge_provider              TEXT
prompt_version              TEXT NOT NULL
policy_version              TEXT NOT NULL
difficulty_method_version   TEXT NOT NULL
context_hash                TEXT NOT NULL
context_token_estimate      BIGINT
context_truncated           BOOLEAN NOT NULL
input_payload_id            TEXT
output_payload_id           TEXT
difficulty_score_raw        DOUBLE PRECISION
difficulty_index            DOUBLE PRECISION
factors_json                JSONB NOT NULL
probabilities_json          JSONB NOT NULL
confidence                  DOUBLE PRECISION
judge_entropy               DOUBLE PRECISION
evidence_tags_json          JSONB NOT NULL
explanation                 TEXT
prompt_tokens               BIGINT
completion_tokens           BIGINT
latency_ms                  INTEGER
actual_cost_usd             NUMERIC(20,10) NOT NULL DEFAULT 0
error_category              TEXT
created_at                  TIMESTAMPTZ NOT NULL
```

Judge Fallback 仍生成 Evaluation，`judge_status` 标明：

```text
live
cache_hit
rules_fallback
safe_profile_fallback
live_error
```

幂等键：

```text
SHA256(
  policy_version
  + prompt_version
  + judge_model
  + trigger_event_id
  + context_hash
)
```

同一 Trigger 的 Client / New API 重放只产生一个逻辑 Evaluation。

## 11. `acu_route_decisions`

用途：完整保存当前 `src/acu/decision.ts` 连续价值公式的可重放快照。

核心字段：

```text
route_decision_id           TEXT PK
newapi_user_id              TEXT NOT NULL
segment_id                  TEXT FK
judge_evaluation_id         TEXT FK
mode                        TEXT NOT NULL
policy_version              TEXT NOT NULL
routing_model_version       TEXT NOT NULL
quality_curve_version       TEXT NOT NULL
price_version               TEXT NOT NULL
effective_quality_target    DOUBLE PRECISION NOT NULL
formula_inputs_json         JSONB NOT NULL
candidate_estimates_json    JSONB NOT NULL
pareto_frontier_json        JSONB NOT NULL
selected_profile_json       JSONB NOT NULL
route_explanation           TEXT
fallback_source             TEXT
created_at                  TIMESTAMPTZ NOT NULL
```

`candidate_estimates_json` 至少保存每个候选：

```text
predicted_score
conservative_score
estimated_call_cost
expected_fallback_cost
risk_adjusted_cost
risk_adjusted_score
quality_utility
cost_utility
value_utility
pareto_efficient
meets_quality_target
excluded_reason
```

`meets_quality_target` 只用于解释和分析，不参与正常 P0 硬过滤。

固定 Formula Version 下必须能够重放：

```text
硬兼容过滤
→ Pareto frontier
→ argmax(value_utility)
```

## 12. `acu_logical_requests`

用途：表示一次逻辑模型动作，严格区别于真实 Provider Attempt。

核心字段：

```text
logical_request_id          TEXT PK
newapi_user_id              TEXT NOT NULL
newapi_token_id             TEXT
newapi_log_id               TEXT
session_id                  TEXT FK
task_id                     TEXT FK
segment_id                  TEXT FK
step_id                     TEXT
ingress_idempotency_key     TEXT NOT NULL
request_protocol            TEXT NOT NULL
requested_model             TEXT NOT NULL
request_payload_id          TEXT
response_payload_id         TEXT
selected_profile_id         TEXT
accepted_attempt_id         TEXT
status                      TEXT NOT NULL
had_tools                   BOOLEAN NOT NULL DEFAULT false
streaming                   BOOLEAN NOT NULL
started_at                  TIMESTAMPTZ NOT NULL
completed_at                TIMESTAMPTZ
error_category              TEXT
metadata_json               JSONB NOT NULL DEFAULT '{}'
```

幂等约束：

```text
UNIQUE(newapi_user_id, ingress_idempotency_key)
```

`ingress_idempotency_key` 由用户范围、协议、规范化历史增量、最新逻辑输入和状态版本共同生成，不能只使用 `x-client-request-id`。

## 13. `acu_attempts`

用途：每次真实 Judge 或 Provider 调用一行。

核心字段：

```text
attempt_id                  TEXT PK
logical_request_id          TEXT FK
attempt_index               INTEGER NOT NULL
attempt_kind                TEXT NOT NULL
retry_owner                 TEXT NOT NULL
route_decision_id           TEXT
judge_evaluation_id         TEXT
execution_profile_id        TEXT
requested_model             TEXT
actual_model                TEXT
provider                    TEXT NOT NULL
channel                     TEXT
provider_request_id         TEXT
status                      TEXT NOT NULL
error_category              TEXT
http_status                 INTEGER
input_tokens                BIGINT NOT NULL DEFAULT 0
cached_input_tokens         BIGINT NOT NULL DEFAULT 0
output_tokens               BIGINT NOT NULL DEFAULT 0
reasoning_tokens            BIGINT NOT NULL DEFAULT 0
usage_source                TEXT
input_price_per_million     NUMERIC(20,10)
output_price_per_million    NUMERIC(20,10)
actual_cost_usd             NUMERIC(20,10) NOT NULL DEFAULT 0
provider_billed             BOOLEAN
latency_ms                  INTEGER
visible_output_bytes        BIGINT NOT NULL DEFAULT 0
started_at                  TIMESTAMPTZ NOT NULL
completed_at                TIMESTAMPTZ
metadata_json               JSONB NOT NULL DEFAULT '{}'
```

约束：

```text
UNIQUE(logical_request_id, attempt_index, attempt_kind)
```

P0：

```text
max_provider_attempts_per_logical_request = 2
```

失败 Attempt 只有 Provider 实际计费时才进入最终用户成本。

## 14. `acu_payloads`

用途：只在 PostgreSQL 中保存完整原生输入输出，不做向量化。

核心字段：

```text
payload_id                  TEXT PK
newapi_user_id              TEXT NOT NULL
logical_request_id          TEXT
attempt_id                  TEXT
payload_kind                TEXT NOT NULL
protocol                    TEXT
content_type                TEXT
headers_sanitized_json      JSONB
body_json                   JSONB
body_text                   TEXT
body_sha256                 TEXT NOT NULL
is_complete                 BOOLEAN NOT NULL
retention_until             TIMESTAMPTZ
created_at                  TIMESTAMPTZ NOT NULL
metadata_json               JSONB NOT NULL DEFAULT '{}'
```

`payload_kind`：

```text
client_request
judge_request
judge_response
provider_request
provider_response
provider_stream
client_response
```

实现规则：

- JSON 请求优先存 `body_json`；
- SSE 原始序列和非 JSON 文本存 `body_text`；
- PostgreSQL TOAST 负责大字段压缩；
- Streaming 不按每个 Delta 写一行，完成或中断时保存聚合的原始 Event Stream；
- 中断时保存已采集前缀并标记 `is_complete=false`；
- P0 不把原始内容写到文件系统、对象存储或独立 Trace 服务；
- P0 不运行自动删除任务；
- 可以写入默认 `retention_until = created_at + 90 days`，但删除必须由后续管理员流程显式执行。

严禁保存：

- 真实 Authorization；
- New API Key；
- Provider Key；
- Cookie；
- 数据库密码。

## 15. `acu_usage_reports`

用途：同时承担 ACU 侧不可重复的最终费用汇总和向 New API 发送的 Outbox。

核心字段：

```text
usage_report_id             TEXT PK
newapi_user_id              TEXT NOT NULL
newapi_token_id             TEXT
newapi_log_id               TEXT
logical_request_id          TEXT NOT NULL UNIQUE
report_idempotency_key      TEXT NOT NULL UNIQUE
actual_model                TEXT
provider                    TEXT
channel                     TEXT
input_tokens                BIGINT NOT NULL DEFAULT 0
cached_input_tokens         BIGINT NOT NULL DEFAULT 0
output_tokens               BIGINT NOT NULL DEFAULT 0
reasoning_tokens            BIGINT NOT NULL DEFAULT 0
judge_cost_usd              NUMERIC(20,10) NOT NULL DEFAULT 0
provider_cost_usd           NUMERIC(20,10) NOT NULL DEFAULT 0
failed_billed_cost_usd      NUMERIC(20,10) NOT NULL DEFAULT 0
final_user_cost_usd         NUMERIC(20,10) NOT NULL DEFAULT 0
cost_breakdown_json         JSONB NOT NULL
status                      TEXT NOT NULL
send_attempt_count          INTEGER NOT NULL DEFAULT 0
next_send_at                TIMESTAMPTZ
last_error                  TEXT
created_at                  TIMESTAMPTZ NOT NULL
sent_at                     TIMESTAMPTZ
acknowledged_at             TIMESTAMPTZ
```

状态：

```text
pending
sending
sent
acknowledged
failed
```

规则：

- Judge 和 Provider 实际成本均按 1.0 倍汇总；
- Provider 未收费的失败 Attempt 不进入正向用户成本；
- 一个 Logical Request 只有一个最终 Usage Report；
- New API 必须按 `report_idempotency_key` 幂等扣费；
- ACU 重试发送不得重复扣款。

## 16. 事务边界

### 16.1 Provider 调用前

一个短事务内：

1. Resolve / Create Session；
2. Resolve / Create Task；
3. 插入去重 Event；
4. 判断 Trigger；
5.创建或复用 Segment；
6. 写入或复用 Judge Evaluation；
7. 写入 Route Decision；
8. 创建 Logical Request；
9. 创建首个 Attempt 占位记录。

Provider 网络调用不得持有数据库长事务。

自动路由新请求在上述状态无法可靠持久化时应失败关闭，避免无账本执行。

### 16.2 Provider 完成后

一个短事务内：

1. 完成 Attempt；
2. 保存 Provider / Client Response Payload；
3. 更新 Logical Request；
4. 更新 Segment 的 accepted response 计数；
5. 生成最终 Usage Report。

Usage Report 发送失败不回滚已经返回给客户端的成功响应；Worker 或下次请求继续发送。

## 17. 并发与锁

五日 Alpha 不引入 Redis。

P0 使用 PostgreSQL：

- 行级锁；
- `SELECT ... FOR UPDATE`；
- 部分唯一索引；
- Event、Judge、Logical Request 和 Usage Report 唯一键；
- 短事务；
- 必要时 PostgreSQL Advisory Lock。

同一 Task 创建或更新活动 Segment 时，对 Task 行加锁，防止并发请求同时创建两个活动 Segment。

## 18. 从现有 SQLite 的迁移映射

当前 `src/acu/storage.ts` 的能力不推倒重写：

```text
routing_requests
→ acu_judge_evaluations
+ acu_route_decisions
+ acu_logical_requests

model_candidate_scores
→ acu_route_decisions.candidate_estimates_json

routing_attempts
→ acu_attempts

user_feedback / execution_outcomes
→ P1 继续保留或映射为 Event / Outcome 表

execution_profile_health
→ P1 独立健康度表
```

现有 Difficulty、Factor、概率、候选分数、Attempt、Usage 和成本字段继续复用；新增的主要是 Session / Task / Segment、完整 Payload、逻辑请求、幂等和 Usage Report。

## 19. P0 实施范围

五日内只实现：

1. PostgreSQL Migration；
2. 上述十张表；
3. 最小 Repository / Transaction 层；
4. Session / Task / Segment 状态写入；
5. Event 去重；
6. Judge / Route 幂等；
7. Logical Request / Attempt 分离；
8. 完整原生 Payload 仅存 PostgreSQL；
9. Usage Report 幂等回写；
10. 用户范围隔离测试。

不要求五日内迁移所有历史 SQLite 数据。旧数据可以保留为只读开发证据；Alpha 新流量写 PostgreSQL。

## 20. P1 与延期

P1：

- 用户 Feedback 与 Outcome 独立表；
- Execution Profile Health；
- Provider 账单自动对账；
- 管理员删除和保留策略；
- OpenClaw / Hermes 轨迹字段；
- 更完整 Step 生命周期。

延期：

- pgvector；
- Embedding；
- Memory；
- 训练样本派生；
- 数据仓库；
- 在线学习；
- 自动长期用户偏好。

## 21. P0 验收

1. 同一 HumanMessage 重放不重复 Event、Judge 或 Route；
2. 不同用户相同 Prompt 不会关联到同一 Session；
3. 同一 Task 任一时刻最多一个活动 Segment；
4. 16 个 accepted Model Response 计数准确，Retry 不计数；
5. PlanStarted / PlanFinished 各自形成独立 Evaluation 与 Segment；
6. 88 保存在公式参数快照中，不作为候选硬过滤；
7. 当前 `src/acu/decision.ts` 候选估计和 `valueUtility` 可完整重放；
8. 每个 Provider Attempt 独立保存 Usage、成本和错误；
9. 每个执行 Logical Request 最多两次 Provider Attempt；
10. Streaming 完成或中断均在 PostgreSQL 保存可审计原始响应；
11. Usage Report 重试不会重复 New API 扣费；
12. 数据库中不存在真实 API Key 或 Provider Secret；
13. 未安装 pgvector，也没有 Embedding / Memory 表；
14. ACU 崩溃重启后可恢复 Session、Segment、Route、Logical Request 和 Attempt；
15. 管理员可以从一个 Logical Request 追溯 Session → Task → Segment → Event → Judge → Route → Attempt → Payload → Usage Report。