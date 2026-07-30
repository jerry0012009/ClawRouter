# ACU Router Alpha P0 部署与回滚手册

> 适用分支：ClawRouter `productization/alpha-p0-implementation`；New API `acu/alpha-p0-integration`
>
> New API 基线：`v1.0.0-rc.22` / `bc14c18f6024e79cba1c08d02cd007796e12d668`
>
> 范围：3—10 名邀请制、钱包余额计费的隔离 Alpha；不用于生产数据。

## 1. 安全前提

- 两个源码仓库必须是同级目录，且处于上面的固定分支和 Revision。
- 只使用独立测试管理员、用户、Token、余额和 Provider Key。
- `deploy/alpha/.env` 只保存在服务器本地，权限建议为 `0600`；不得提交。
- 数据库密码使用 URL-safe 随机字符；HMAC、Session Secret 与管理员 Trace Token 分别生成，均至少 32 随机字节。管理员 Token 不得复用 New API HMAC Secret。
- Compose 只发布 New API。ACU、两个 PostgreSQL 只有 Docker 网络地址，没有宿主机端口。
- P0 ACU 扣费只支持 New API 钱包余额；订阅计费和并发额度冻结属于 P1。

## 2. 准备

```bash
cd deploy/alpha
cp .env.example .env
chmod 600 .env
```

填写所有占位符。CloseAI 测试入口默认为：

```text
Responses: https://api.openai-proxy.org/v1
Messages:  https://api.openai-proxy.org/anthropic
```

不得在命令行、Git、Issue 或验收报告中粘贴真实值。

## 3. 一条命令启动

```bash
docker compose --env-file .env up -d --build
```

启动顺序为：两个 PostgreSQL健康 → ACU Migration → New API 健康 → ACU。Migration 首次创建十张 `acu_*` 表；已有 `acu_sessions` 时安全跳过。

检查：

```bash
docker compose --env-file .env ps
curl --fail --silent http://127.0.0.1:${NEW_API_PORT:-3100}/api/status
docker compose --env-file .env exec new-api wget -q -O - http://acu-router:8403/internal/health
```

最后一条从 New API 容器访问 ACU，宿主机不应能直接访问 `8403`。`docker compose ps` 中两个 PostgreSQL 也不应出现 published port。

## 4. New API 邀请制配置

首次启动后通过 New API 页面完成初始化，只创建测试数据：

1. 创建独立测试管理员和 3—10 个邀请用户；给每个用户非零钱包余额。
2. 每位用户分别创建 Codex 与 Claude Code 测试 Token；两个 Token 使用该用户的普通测试 Group。New API 会按原生 Path 对 ACU Channel 做协议候选过滤，不需要拆成两个用户账户。
3. 创建 OpenAI 类型 Channel：
   - Name：`ACU Responses Alpha`；
   - Tag：`acu-router`；
   - Base URL：`http://acu-router:8403`；
   - Group：与邀请测试用户相同（默认 `default`）；
   - Models：`acu-auto,gpt-5.5`；
   - Failure Retry Count：0（源码仍会对 Tag 为 `acu-router` 的 Channel 强制为 0）。
4. 创建 Anthropic 类型 Channel：
   - Name：`ACU Messages Alpha`；
   - Tag：`acu-router`；
   - Base URL：`http://acu-router:8403`；
   - Group：与邀请测试用户相同（默认 `default`）；
   - Models：`acu-auto,claude-sonnet-5`；
   - Failure Retry Count：0。
5. 不要创建 `New API → ACU → New API` 回路；ACU Profile 必须直接指向 CloseAI。

New API 的 Channel Tag 是可信集成开关。客户端发送的任何 `x-acu-*` 均会被删除；只有 Tag 精确为 `acu-router` 的 Channel 会关闭静态扣费、强制 Retry=0，并对最终上游 Body 注入 HMAC 身份。候选选择同时强制 `/v1/responses → OpenAI Channel`、`/v1/messages → Anthropic Channel`，避免 `acu-auto` 被协议转换 Adapter 改写。

## 5. 客户端设置

Codex 使用 Codex Group Token：

```bash
export OPENAI_BASE_URL="http://127.0.0.1:${NEW_API_PORT:-3100}/v1"
export OPENAI_API_KEY="<LOCAL_CODEX_TEST_TOKEN>"
```

Claude Code 使用 Claude Group Token：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:${NEW_API_PORT:-3100}"
export ANTHROPIC_AUTH_TOKEN="<LOCAL_CLAUDE_TEST_TOKEN>"
```

真实值只放客户端本地环境，不写入仓库。先执行文本与 Tool 场景，再执行 Plan、Repair、Cancel、Resume；每次通过 New API Request ID 对照 `acu_logical_requests`、`acu_attempts`、`acu_payloads` 和 `acu_usage_reports`。

## 6. 管理员完整轨迹

完整 Payload 只能通过 ACU 私网内部端点查询，并使用独立的 `ACU_ADMIN_TRACE_TOKEN`：

```text
GET /internal/admin/traces/<logical_request_id>
Authorization: Bearer <REDACTED_ADMIN_TRACE_TOKEN>
```

接口返回 Logical Request 对应的 Session、Task、该 Task 的 Segments / Events / Judge Evaluations / Route Decisions，以及该请求的 Attempts / Payloads / Usage Report。响应带 `Cache-Control: no-store`。无 Token 返回 `401`，Token 不正确返回 `403`；New API 的可信身份签名不能替代管理员 Token。

ACU 不发布宿主机端口，因此应从受控运维容器或 Docker 私网调用。示例只引用容器本地环境变量，不把 Token 放入命令历史：

```bash
docker compose --env-file .env exec -T acu-router node -e '
const id = process.argv[1];
const response = await fetch(`http://127.0.0.1:8403/internal/admin/traces/${id}`, {
  headers: { authorization: `Bearer ${process.env.ACU_ADMIN_TRACE_TOKEN}` },
});
if (!response.ok) process.exit(1);
process.stdout.write(await response.text());
' req_<logical_request_id>
```

返回体包含用户工作内容，必须按管理员敏感数据处理，不写入普通应用日志、Issue 或公开验收附件。

## 7. Usage Finalize 运维检查

```bash
docker compose --env-file .env exec postgres-acu \
  psql -U acu_alpha -d acu_alpha -c \
  "SELECT status,send_attempt_count,count(*) FROM acu_usage_reports GROUP BY 1,2 ORDER BY 1,2"
```

- 正常最终状态为 `acknowledged`。
- New API 暂时失败时为 `failed`，`next_send_at` 保留重试时间；客户端成功响应不会回滚。
- Worker 崩溃时 `sending` Claim 五分钟后可重新领取。
- New API 以 `report_idempotency_key` 和 `logical_request_id` 防止重复扣费；相同 key 但不同 Body 会拒绝。

## 8. 手工 Migration 与验证

```bash
docker compose --env-file .env run --rm acu-migrate
docker compose --env-file .env exec postgres-acu \
  psql -U acu_alpha -d acu_alpha -c \
  "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'acu_%' ORDER BY 1"
```

结果必须恰好是十张 P0 表，不得出现 vector、embedding 或 memory 表。

## 9. 更新与回滚

更新前记录两个 Commit SHA，并备份两个独立数据库卷。只允许快进或切换到已审核 Commit，不合并 main、不 force push。

代码回滚：

```bash
git -C ../.. switch productization/alpha-p0-implementation
git -C ../../../new-api switch acu/alpha-p0-integration
docker compose --env-file .env up -d --build
```

如果需要回滚到旧镜像，先将 Compose 的 build 结果按 Commit 打 Tag，再把服务 `image` 固定到该 Tag。数据库向下回滚会删除 Alpha 轨迹，只能在人工确认备份且明确丢弃测试数据后执行：

```bash
docker compose --env-file .env exec -T postgres-acu \
  psql -v ON_ERROR_STOP=1 -U acu_alpha -d acu_alpha \
  < ../../migrations/acu/0001_alpha_p0.down.sql
```

日常停止使用 `docker compose --env-file .env down`。不要使用 `down -v`，除非人工明确批准永久删除两个测试数据库和日志卷。

## 10. 故障边界

- Provider Key 缺失或 CloseAI 失败：ACU 服务会启动失败或请求产生可审计 Attempt；不得伪造成功。
- OpenRouter 403 TOS：保持 blocked，不规避政策。
- Finalize 失败：查 New API 内部接口鉴权、钱包余额、Token quota 和 Outbox `last_error`；不要手工重复扣费。
- `acu-auto` 无兼容 Profile：失败关闭，不退回未经审计的直连 Provider。
- Streaming 已向客户端输出后：不允许同响应拼接第二 Provider；需要新的客户端逻辑请求。

## 11. RC1 HTTPS、公网 Gate 与紧急停止补充

RC1 当前 **未通过公网 Gate**，不要仅因本机 Smoke 成功就开放端口。人工准备域名和证书后，反向代理只能指向 `127.0.0.1:${NEW_API_PORT}`，不得代理 ACU 或 PostgreSQL。Nginx 关键项示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:3200;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    client_max_body_size 128m;
}
```

域名、DNS、证书路径、公开 Base URL 和联系人均为人工输入，本手册不会猜测或自动修改。启用前须验证 HTTPS、SSE 首字节/取消、请求体上限、IP/用户限流、测试账户余额上限和回滚。

邀请用户按“独立用户 → 受限余额/兑换码 → 普通 Group → Codex/Claude 分离 Token”创建。默认 ACU 策略为 `all_routing_eligible`；用户可改为 `custom_allowlist` 或 `explicit_only`。不得把 Provider Key 给用户。

真实测试 Harness 必须显式设置 `ACU_LIVE_TEST_ENABLED=true`，配置单轮/累计 CNY 预算、并发 1、输出 Token 上限和仓库外 Budget State。Provider 余额不足、Budget Reservation 未结算或成本无法对账时停止，不得删除 State 文件绕过。

紧急停止顺序：先在 New API 禁用两个 ACU Channel 或撤销测试 Token，阻断新请求；再执行 `docker compose stop new-api acu-router`；保留数据库和日志取证。恢复前核对 Provider Dashboard、`acu_attempts`、`acu_usage_reports` 和 New API Finalize。不要使用 `down -v`。
