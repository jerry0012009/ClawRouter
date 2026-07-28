# ACU Router PostgreSQL 数据模型

> 状态：产品设计初稿，待创始人审阅  
> 版本：v0.1  
> 日期：2026-07-29  
> 依赖：`03-system-architecture.md`、`04-session-task-routing-segment-state-machine-v2.md`、`04a-alpha-state-machine-implementation-profile.md`、`05-judge-and-trigger-policy.md`、`06-planning-detection.md`、`07-failure-taxonomy-and-blockage-rules.md`、`08-routing-and-upstream-recovery-policy.md`

## 1. 文档目的

本文把已确认的 Session、Task、Segment、Event、Evaluation、Route、Attempt、Usage 和成本语义压缩成五日 Alpha 可实现的最小 PostgreSQL Schema。

目标不是一次建立完整数据平台，而是保证：

- 同一逻辑事件可幂等；
- 普通 Tool 循环可复用 Route；
- Retry 不重复 Judge 或计费；
- 当前 ACU 公式输入、候选、效用和选择可重放；
- 实际 Provider Attempt、Usage 和成本可审计；
- ACU 可通过 Outbox 向 New API 回写最终用量与扣费依据。

## 2. 数据所有权

### New API 是权威来源

- 用户与登录；
- API Key / Token；
- 余额、额度、兑换码；
- 用户前台使用记录；
- 最终余额扣减与充值账本。

### ACU PostgreSQL 是权威来源

- Session / Task / Routing Segment；
- 标准 Event 与 Trigger；
- Judge Evaluation；
- Route Decision 与当前公式中间量；
- Provider Attempt；
- 原生请求 / 响应 Trace；
- Provider Usage 与实际成本；
- 向 New API 回写的 Usage Report Outbox。

**最终扣费只由 New API 执行。** ACU 生成可审计的用量报告，不直接维护用户余额。

## 3. P0 表清单

五日 Alpha 使用 10 张核心表：

1. `acu_sessions`；
2. `acu_tasks`；
3. `acu_segments`；
4. `acu_events`；
5. `acu_judge_evaluations`；
6. `acu_route_decisions`；
7. `acu_attempts`；
8. `acu_usage_ledger`；
9. `acu_traces`；
10. `acu_usage_report_outbox`。

P0 不单独建立完整 Plan、Step、Failure 聚类、Model Catalog 和 Channel Health 表。Plan / Failure 结构先保存于 Event / Segment JSONB；`step_id` 作为关联字段。后续再规范化。

## 4. 通用约定

- 主键由应用生成 UUID；
- 时间统一 `timestamptz`；
- 金额统一使用 `numeric(20, 10)`，不使用浮点；
- Token 使用 `bigint`；
- 原生和版本化结构使用 `jsonb`；
- 所有租户数据必须带 `newapi_user_id` 或可追溯到 Session；
- 随机 ID 不进入 Judge 语义，只用于追踪；
- 所有计算结果保存公式、Prompt、曲线和价格版本；
- 不依赖 Client Request ID 作为唯一幂等键。

## 5. `acu_sessions`

用途：记录原生客户端连续对话身份。

核心字段：

```text
session_id uuid PK
newapi_user_id text NOT NULL
newapi_token_id text NULL
client_type text NOT NULL
client_version text NULL
native_protocol text NOT NULL
identity_status text NOT NULL
history_prefix_hash text NULL
system_fingerprint text NULL
tool_schema_fingerprint text NULL
last_tool_call_id text NULL
current_task_id uuid NULL
current_segment_id uuid NULL
last_activity_at timestamptz NOT NULL
created_at timestamptz NOT NULL
updated_at timestamptz NOT NULL
metadata jsonb NOT NULL DEFAULT '{}'
```

约束：

- Session 不按时间自动删除或失效；
- 强连续性证据可以长期恢复；
- `last_activity_at` 只用于审计和 Segment Lease；
- 弱信号不能单独合并 Session。

索引：

```text
(newapi_user_id, client_type, updated_at DESC)
history_prefix_hash
last_tool_call_id
```

## 6. `acu_tasks`

用途：记录 Session 内当前用户目标。

```text
task_id uuid PK
session_id uuid FK NOT NULL
initial_goal_text text NULL
initial_goal_hash text NULL
phase text NOT NULL
base_quality_target numeric(5,2) NOT NULL
capability_escalation_floor numeric(5,2) NOT NULL DEFAULT 0
status text NOT NULL
created_at timestamptz NOT NULL
updated_at timestamptz NOT NULL
completed_at timestamptz NULL
metadata jsonb NOT NULL DEFAULT '{}'
```

P0 简化为一个 Session 同时只有一个活动 Task。通过事务更新 `acu_sessions.current_task_id`。

## 7. `acu_segments`

用途：路由锁定和 Judge 复用的核心对象。

```text
segment_id uuid PK
task_id uuid FK NOT NULL
previous_segment_id uuid NULL
creation_reason text NOT NULL
phase text NOT NULL
status text NOT NULL
judge_evaluation_id uuid NULL
route_decision_id uuid NULL
selected_profile_id text NULL
base_quality_target numeric(5,2) NOT NULL
capability_escalation_floor numeric(5,2) NOT NULL
temporary_phase_override numeric(5,2) NOT NULL DEFAULT 0
effective_quality_target numeric(5,2) NOT NULL
accepted_model_responses_since_judge integer NOT NULL DEFAULT 0
last_activity_at timestamptz NOT NULL
created_at timestamptz NOT NULL
superseded_at timestamptz NULL
metadata jsonb NOT NULL DEFAULT '{}'
```

`effective_quality_target` 是当前 ACU 连续价值公式的偏好锚点，不是候选预测分硬阈值。

P0 约束：

```text
同一 task_id 最多一个 status='active' Segment
```

建议使用部分唯一索引。

## 8. `acu_events`

用途：保存协议 Normalizer 产生的确定性事实和 Trigger 输入。

```text
event_id uuid PK
session_id uuid FK NOT NULL
task_id uuid FK NOT NULL
segment_id uuid NULL
step_id uuid NULL
event_type text NOT NULL
event_hash text NOT NULL
evidence_strength text NOT NULL
source_protocol text NOT NULL
source_client text NOT NULL
source_client_version text NULL
tool_call_id text NULL
is_replay boolean NOT NULL DEFAULT false
is_duplicate boolean NOT NULL DEFAULT false
trigger_reason text NULL
raw_trace_id uuid NULL
payload jsonb NOT NULL DEFAULT '{}'
occurred_at timestamptz NOT NULL
created_at timestamptz NOT NULL
```

唯一约束：

```text
UNIQUE(session_id, event_hash)
```

一个请求可产生多个 Event；同一逻辑 Event 重放不得再次触发状态变化。

## 9. `acu_judge_evaluations`

用途：保存 Judge 调用、Fallback 和输出。

```text
judge_evaluation_id uuid PK
task_id uuid FK NOT NULL
segment_id uuid FK NOT NULL
trigger_event_id uuid NULL
idempotency_key text NOT NULL UNIQUE
judge_status text NOT NULL
judge_result_source text NOT NULL
judge_model text NULL
judge_provider text NULL
prompt_version text NOT NULL
policy_version text NOT NULL
context_hash text NOT NULL
context_token_estimate bigint NOT NULL
context_truncated boolean NOT NULL
output_schema_version text NOT NULL
difficulty_score_raw numeric(6,3) NOT NULL
difficulty_index numeric(6,3) NOT NULL
factors jsonb NOT NULL
tier_probabilities jsonb NOT NULL
confidence numeric(6,5) NOT NULL
evidence_tags jsonb NOT NULL
explanation text NULL
input_tokens bigint NOT NULL DEFAULT 0
cached_input_tokens bigint NOT NULL DEFAULT 0
output_tokens bigint NOT NULL DEFAULT 0
latency_ms integer NOT NULL DEFAULT 0
actual_cost numeric(20,10) NOT NULL DEFAULT 0
error_category text NULL
created_at timestamptz NOT NULL
```

幂等键：

```text
SHA256(policy_version + prompt_version + judge_model + trigger_event_id + context_hash)
```

同一 Trigger 的网络重放只产生一个逻辑 Evaluation。真实多次 Judge Provider Attempt 可记录在 `acu_attempts`，但只关联一个 Evaluation。

## 10. `acu_route_decisions`

用途：完整保存当前 ACU 公式输入、中间量和选择结果。

```text
route_decision_id uuid PK
segment_id uuid FK NOT NULL
judge_evaluation_id uuid NULL
mode text NOT NULL
policy_version text NOT NULL
routing_model_version text NOT NULL
quality_curve_version text NOT NULL
price_version text NOT NULL
effective_quality_target numeric(5,2) NOT NULL
selected_profile_id text NOT NULL
selected_model text NOT NULL
selected_provider text NOT NULL
selected_channel text NOT NULL
selected_predicted_score numeric(8,4) NULL
selected_conservative_score numeric(8,4) NULL
selected_risk_adjusted_cost numeric(20,10) NULL
selected_quality_utility numeric(20,10) NULL
selected_cost_utility numeric(20,10) NULL
selected_value_utility numeric(20,10) NULL
eligible_profiles jsonb NOT NULL
excluded_profiles jsonb NOT NULL
candidate_estimates jsonb NOT NULL
pareto_frontier jsonb NOT NULL
fallback_source text NULL
route_explanation text NULL
created_at timestamptz NOT NULL
```

`candidate_estimates` P0 必须保存每个候选：

- 质量曲线点；
- conservative quality；
- call cost；
- expected fallback cost；
- risk-adjusted cost；
- Pareto 标记；
- risk-adjusted score；
- quality / cost / value utility；
- `meetsQualityTarget` 展示字段；
- 排除或未选择原因。

这样才能证明 88 只是公式锚点，并重放 `src/acu/decision.ts` 的结果。

## 11. `acu_attempts`

用途：记录每次真实 Judge 或 Provider 调用。

```text
attempt_id uuid PK
session_id uuid FK NOT NULL
task_id uuid FK NOT NULL
segment_id uuid FK NOT NULL
step_id uuid NULL
logical_request_id uuid NOT NULL
attempt_kind text NOT NULL
attempt_number integer NOT NULL
retry_owner text NOT NULL
route_decision_id uuid NULL
judge_evaluation_id uuid NULL
requested_model text NULL
actual_model text NULL
provider text NOT NULL
channel text NULL
provider_request_id text NULL
status text NOT NULL
error_category text NULL
http_status integer NULL
started_at timestamptz NOT NULL
first_byte_at timestamptz NULL
finished_at timestamptz NULL
input_tokens bigint NOT NULL DEFAULT 0
cached_input_tokens bigint NOT NULL DEFAULT 0
output_tokens bigint NOT NULL DEFAULT 0
reasoning_tokens bigint NOT NULL DEFAULT 0
provider_usage jsonb NULL
provider_cost numeric(20,10) NOT NULL DEFAULT 0
was_provider_billed boolean NULL
bytes_sent_to_client bigint NOT NULL DEFAULT 0
metadata jsonb NOT NULL DEFAULT '{}'
```

唯一约束：

```text
UNIQUE(logical_request_id, attempt_number, attempt_kind)
```

P0 默认每个执行逻辑请求最多两个 Provider Attempt。

## 12. `acu_usage_ledger`

用途：将可计费事实与 Provider Attempt 分离，形成不可重复的 ACU 侧费用账本。

```text
ledger_entry_id uuid PK
newapi_user_id text NOT NULL
session_id uuid FK NOT NULL
task_id uuid FK NOT NULL
logical_request_id uuid NOT NULL
attempt_id uuid NULL
judge_evaluation_id uuid NULL
entry_type text NOT NULL
source text NOT NULL
source_usage_status text NOT NULL
input_tokens bigint NOT NULL DEFAULT 0
cached_input_tokens bigint NOT NULL DEFAULT 0
output_tokens bigint NOT NULL DEFAULT 0
reasoning_tokens bigint NOT NULL DEFAULT 0
amount numeric(20,10) NOT NULL
currency text NOT NULL DEFAULT 'USD'
provider_billed boolean NULL
billing_key text NOT NULL UNIQUE
created_at timestamptz NOT NULL
metadata jsonb NOT NULL DEFAULT '{}'
```

`entry_type` 至少支持：

- `judge_cost`；
- `provider_success_cost`；
- `provider_failed_billed_cost`；
- `provider_failed_unbilled`；
- `adjustment`。

只有 Provider 实际收费的失败 Attempt 才形成正向用户计费条目。

## 13. `acu_traces`

用途：保存原生协议、响应和内部证据引用。

```text
trace_id uuid PK
newapi_user_id text NOT NULL
session_id uuid NULL
logical_request_id uuid NULL
attempt_id uuid NULL
trace_type text NOT NULL
protocol text NULL
content_hash text NOT NULL
headers_sanitized jsonb NULL
body_sanitized jsonb NULL
sse_events_sanitized jsonb NULL
raw_storage_ref text NULL
contains_raw_content boolean NOT NULL DEFAULT false
created_at timestamptz NOT NULL
retention_class text NOT NULL DEFAULT 'raw-90d'
metadata jsonb NOT NULL DEFAULT '{}'
```

P0 允许 JSONB 保存小型脱敏内容；大体积原始 SSE 可保存仓库外对象存储引用。

产品默认原始内容保留目标为 90 天，但 Alpha 不实现自动删除任务；先支持管理员人工删除和完整审计。

## 14. `acu_usage_report_outbox`

用途：可靠、幂等地把最终 Usage / 成本报告给 New API。

```text
outbox_id uuid PK
newapi_user_id text NOT NULL
newapi_token_id text NULL
newapi_request_id text NULL
newapi_log_id text NULL
logical_request_id uuid NOT NULL
report_idempotency_key text NOT NULL UNIQUE
payload jsonb NOT NULL
status text NOT NULL
attempt_count integer NOT NULL DEFAULT 0
next_attempt_at timestamptz NULL
last_error text NULL
created_at timestamptz NOT NULL
sent_at timestamptz NULL
acknowledged_at timestamptz NULL
```

状态：`pending / sending / sent / acknowledged / failed`。

New API 必须按 `report_idempotency_key` 幂等扣费。ACU 重试 Outbox 不得重复扣款。

## 15. P0 事务边界

### 15.1 入站与路由事务

同一事务内：

1. 解析可信 New API 身份；
2. Resolve / Create Session、Task；
3. 插入去重 Event；
4. 判断 Trigger；
5. 创建 / 关闭 Segment；
6. 复用或创建 Evaluation；
7. 创建 Route Decision；
8. 创建首个 Provider Attempt 记录。

Provider 网络调用不应持有数据库长事务。

### 15.2 Provider 完成事务

同一事务内：

1. 完成 Attempt；
2. 保存 Provider Usage / Cost；
3. 插入 Ledger；
4. 更新 accepted Model Response 计数；
5. 保存输出 Trace；
6. 写入 Usage Report Outbox。

Outbox Worker 在事务外发送 New API 回写。

## 16. 并发与锁

P0 不强制 Redis。使用 PostgreSQL：

- `SELECT ... FOR UPDATE` 锁定当前 Session / Task；
- 活动 Segment 部分唯一索引；
- Event、Judge、Ledger、Outbox 唯一键；
- 短事务；
- 冲突后读取已有幂等结果。

只有真实压测证明 PostgreSQL 锁不足时再引入 Redis。

## 17. 最小索引

```text
acu_sessions(newapi_user_id, updated_at DESC)
acu_tasks(session_id, status)
acu_segments(task_id, created_at DESC)
acu_events(session_id, occurred_at DESC)
acu_judge_evaluations(task_id, created_at DESC)
acu_route_decisions(segment_id)
acu_attempts(logical_request_id, attempt_number)
acu_attempts(provider_request_id)
acu_usage_ledger(newapi_user_id, created_at DESC)
acu_usage_report_outbox(status, next_attempt_at)
acu_traces(logical_request_id, created_at)
```

## 18. P0 明确不做

- 完整 Plan 表；
- 完整 Step 状态机表；
- Failure 聚类与向量表；
- Model Catalog / Price / Curve 管理后台表；
- 实时 Channel Health 时序表；
- 用户偏好学习表；
- 训练数据特征仓库；
- 自动 90 天删除 Worker；
- 跨区域高可用和分库分表。

## 19. P0 验收

1. 同一 HumanMessage 重放不重复 Event 或 Judge；
2. 同一 Task 同时只有一个 active Segment；
3. Retry 只新增 Attempt；
4. 16-response safety refresh 可由字段确定性触发；
5. PlanStarted / PlanFinished Evaluation 可追溯；
6. Route Decision 保存完整 Pareto 和 Utility 中间量；
7. 固定 Fixture 可从数据库重放并得到同一 selected Profile；
8. Provider 失败与能力失败分开入账；
9. 每个实际收费 Attempt 只有一个 Ledger Entry；
10. Outbox 重试不重复 New API 扣费；
11. 跨用户查询无法访问其他用户 Trace；
12. ACU 崩溃重启后 Session、Segment、Route 和 Attempt 可恢复。
