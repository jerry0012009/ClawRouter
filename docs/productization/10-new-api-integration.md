# ACU Router 与 New API 集成方案

> 状态：五日 Alpha 产品设计初稿，待创始人审阅  
> 版本：v0.1  
> 日期：2026-07-29  
> 依赖：`02-native-protocol-observations.md`、`03-system-architecture.md`、`04a-alpha-state-machine-implementation-profile.md`、`08-routing-and-upstream-recovery-policy.md`、`09-postgresql-data-model.md`

## 1. 文档目的

本文定义五日 Alpha 中 New API 与独立 ACU Router Service 的最小集成方式。

最终用户链路固定为：

```text
Codex / Claude Code
→ 用户配置 New API Base URL
→ New API 鉴权、余额与用户前台
→ ACU Router Service
→ OpenRouter / CloseAI / 后续 Provider
```

用户不直接连接 ACU。ACU 不写入 New API 进程内部，也不维护用户账户和余额。

## 2. P0 架构边界

### New API 负责

- 登录与用户；
- API Key / Token；
- 兑换码和余额；
- 请求准入；
- 用户可见使用记录；
- 最终扣费；
- 对公网提供 Base URL。

### ACU 负责

- `/v1/responses` 与 `/v1/messages` 原生入口；
- Session / Task / Segment；
- Trigger、Judge、Planning 和 Failure；
- 连续价值公式与模型路由；
- Provider 调用与最多两次 Attempt；
- 实际模型、Channel、Usage 和成本；
- PostgreSQL 完整轨迹；
- 向 New API 回写最终 Usage Report。

### Provider 凭证

Provider Key 只保存在 ACU 环境中。New API 不直接持有 ACU 上游 Provider 的真实密钥。

## 3. P0 暴露的模型

New API 模型列表至少包含：

```text
acu-auto
具体显式模型名
```

`acu-high` 可以保留配置，但不作为五日上线阻断项。

行为：

```text
model = acu-auto
→ ACU Judge + Route

model = 具体模型
→ ACU 执行与账本
→ Judge = 0
→ 不替换模型
```

显式模型和自动路由使用同一 ACU 执行链，避免双套 Provider、Streaming、Usage 和账本代码。

## 4. 原生协议转发

P0 正式支持：

```text
POST /v1/responses
POST /v1/messages
GET /v1/models
```

`/v1/models` 可以由 New API 直接响应，不进入 Judge。

协议侦察已经确认：

- New API 的 OpenAI Channel 可保持 `/v1/responses` Body、Model、Tool ID 和成功 SSE；
- New API 的 Anthropic Channel 可保持 Messages Body、Model、Tool ID、Thinking / Signature；
- New API 会重写 Authorization、Host、Content-Length 等网关 Header；
- New API 当前会删除 Claude Session Header；
- Claude SSE 尾部可能追加 `data: [DONE]`。

因此 ACU：

- 不依赖 Claude Session Header；
- 依靠历史前缀、Tool ID 和可信身份关联 Session；
- 不向响应正文注入 ACU 文案；
- 不改写 Tool ID、Thinking 或原生错误结构；
- 接受 New API 已实测的 Claude `[DONE]` 行为，但保存该差异用于回归测试。

## 5. New API 到 ACU 的可信身份

ACU 不能信任客户端自行发送的 `x-acu-*` Header。

P0 要求 New API：

1. 删除所有来自客户端的内部身份 Header；
2. 在转发 ACU Channel 时注入签名身份 Envelope；
3. ACU 只接受来自私有网络且签名有效的请求。

建议内部 Header：

```text
X-ACU-NewAPI-User-ID
X-ACU-NewAPI-Token-ID
X-ACU-NewAPI-Log-ID
X-ACU-Request-ID
X-ACU-Timestamp
X-ACU-Body-SHA256
X-ACU-Signature
```

签名：

```text
HMAC-SHA256(
  shared_secret,
  user_id
  + token_id
  + log_id
  + request_id
  + timestamp
  + body_sha256
)
```

P0 使用 Docker 私有网络 + 共享 HMAC Secret。mTLS 和密钥轮换列入 P1。

## 6. New API Channel 配置

P0 为 ACU 建立专用 Channel：

```text
Base URL = http://acu-router:<port>
Failure Retry Count = 0
```

New API 不得在 ACU 不知情时透明重试 Provider 调用。网关侧 Provider Retry 由 ACU 统一控制和记录。

ACU Channel 应承载：

- `acu-auto`；
- `acu-high`；
- P0 允许的显式模型。

不得配置形成以下循环：

```text
New API → ACU → New API → Provider
```

ACU 必须直接调用最终 Provider Channel。

## 7. 准入与扣费

### 7.1 请求前

New API 在转发 ACU 前完成：

- API Key 有效性；
- 用户状态；
- 模型权限；
- 余额 / 额度基础准入；
- 请求日志占位。

五日 Alpha 为邀请制用户，不实现复杂预授权和金额冻结。P0 可以使用：

```text
余额 > 0
→ 允许请求
```

实际用量完成后再结算。额度预留、上限冻结和并发消费控制列入 P1。

### 7.2 请求后

ACU 根据真实执行生成唯一 Usage Report：

```text
actual_model
provider
channel
input_tokens
cached_input_tokens
output_tokens
reasoning_tokens
judge_cost
provider_cost
failed_billed_cost
final_user_cost
```

New API 根据 `report_idempotency_key` 执行一次最终扣费，并更新原请求日志。

### 7.3 禁止双重扣费

ACU 虚拟模型 Channel 不应再按 New API 的静态模型价格自动进行最终扣费，否则会与 ACU Usage Report 重复。

P0 必须在 New API 集成层中明确选择一种方式：

```text
ACU Channel 自动扣费 = 关闭 / 归零
最终扣费 = ACU Usage Report
```

Judge 成本和 Provider 成本均按实际 1.0 倍计入。Provider 未收费的失败 Attempt 不计入用户费用。

## 8. Usage Report 内部接口

需要在 New API 侧增加或复用一个只对 ACU 开放的内部 Finalize 接口。

建议逻辑契约：

```text
POST /internal/acu/usage/finalize
```

请求：

```json
{
  "report_idempotency_key": "...",
  "newapi_user_id": "...",
  "newapi_token_id": "...",
  "newapi_log_id": "...",
  "logical_request_id": "...",
  "actual_model": "...",
  "provider": "...",
  "channel": "...",
  "usage": {},
  "cost_breakdown": {},
  "final_user_cost": "0.0000000000",
  "display_summary": "..."
}
```

响应：

```json
{
  "status": "acknowledged",
  "already_processed": false
}
```

要求：

- `report_idempotency_key` 唯一；
- 重复提交返回原结果，不重复扣费；
- 只能修改匹配的用户、Token 和 New API Log；
- 记录 ACU Logical Request ID；
- 管理员可追溯实际模型、Channel 和成本。

具体 New API 源码 Hook 需要在开工时对 v1.0.0-rc.22 做最小代码审计后落点，不在本文虚构现有 API。

## 9. Streaming 时序

```text
1. New API 鉴权并创建 Log
2. New API 注入签名身份并转发 ACU
3. ACU 在首个 SSE 前完成 Route
4. ACU → Provider Streaming
5. ACU 原样转发 New API
6. New API 原样转发客户端
7. ACU 完成 Attempt、Payload 和 Usage Report
8. ACU Outbox 异步 Finalize New API
```

已经向客户端输出可见内容后：

- ACU 不在同一响应中静默拼接其他模型；
- New API 不透明重试；
- 连接中断由客户端后续 Retry；
- ACU 保存已输出前缀和 Attempt 状态。

Usage Report 发送失败不改变已经返回给客户端的成功结果，由 PostgreSQL Outbox 重试。

## 10. 错误边界

### New API 拒绝

鉴权、权限或余额准入失败时，请求不进入 ACU。

### 内部身份失败

签名错误、时间窗口过期或身份字段缺失时，ACU Fail Closed，不调用 Provider。

### ACU 路由失败

无兼容 Profile、Judge Fallback 无安全候选或路由状态无法持久化时，返回明确可重试错误，不静默使用不合格模型。

### Provider 失败

按 `08` 最多两次 Provider Attempt。预算耗尽后返回原生兼容错误。

### Finalize 失败

客户端成功响应不回滚。Usage Report 保持 `pending / failed` 并继续重试，管理员可查看未结算项。

## 11. 用户前台展示

New API 用户页面 P0 展示：

- 请求时间；
- 用户请求的模式或显式模型；
- 实际模型；
- 实际 Channel；
- Token；
- Judge 成本；
- Provider 成本；
- 最终总成本；
- 完整历史 Route Decision：任务 Difficulty、Routing Preference、阶段、全部合法候选及其历史质量曲线与现金成本、Pareto Frontier、最终选择与原因、被排除模型主因；
- 实际 Provider / Channel、最多三次 Channel Attempt 时间线、实际成本、质量上界反事实成本和相对成本下降；
- 可折叠但不截断保存数据的 Judge Explanation。

用户页面不展示：

- 完整 Judge Prompt；
- 原始 Tool 轨迹；
- 完整输入输出；
- 内部失败签名。

以上详细信息只对 ACU 管理员开放。

## 12. P0 需要修改的 New API 范围

控制在四个最小能力：

1. ACU Channel 转发时注入可信签名身份；
2. ACU Channel `Retry = 0`；
3. ACU 虚拟模型关闭静态最终扣费，避免双扣；
4. 实现幂等 Usage Finalize 和 Log 更新。

不重写 New API 前端，不重写用户、API Key、余额、兑换码或充值系统。

## 13. P0 部署

```text
new-api
acu-router
postgres-newapi
postgres-acu
```

P0 不要求 Redis。

网络：

- New API 对公网；
- ACU 仅 Docker 私有网络可访问；
- PostgreSQL 不对公网；
- ACU 可访问 Provider；
- Finalize 接口只接受 ACU 内部身份。

## 14. P1 与延期

P1：

- 额度预留与最终结算；
- mTLS 与 Secret 轮换；
- Provider 账单自动对账；
- Usage Report 告警；
- OpenClaw / Hermes Channel 验收；
- 更完善的 New API 管理员展示；
- 多 ACU 实例和高可用 Outbox Worker。

延期：

- 重写 New API 前端；
- 自建用户和充值系统；
- 让 New API 直接执行 ACU Judge；
- 把 ACU 路由逻辑写入 New API；
- Webhook 事件架构；
- 多区域结算。

## 15. P0 验收

1. Codex 只配置 New API Base URL 即可使用 `/v1/responses`；
2. Claude Code 只配置 New API Base URL 即可使用 `/v1/messages`；
3. 未授权请求不会到达 ACU；
4. 客户端伪造 `x-acu-*` Header 不会获得其他用户身份；
5. `acu-auto` 和显式模型都经过 ACU；
6. 显式模型 Judge = 0；
7. New API 对 ACU Channel 不透明 Retry；
8. New API、ACU、Provider 不形成代理循环；
9. Streaming、Tool ID 和 Thinking 可正常工作；
10. ACU 可获得稳定 New API 用户、Token 和 Log 标识；
11. 一个 Logical Request 只生成一个最终 Usage Report；
12. Usage Report 重试不会重复扣费；
13. New API 前台显示实际模型、Channel 和最终成本；
14. ACU Finalize 故障不会丢失待结算记录；
15. New API 数据库和 ACU PostgreSQL 职责分离。
