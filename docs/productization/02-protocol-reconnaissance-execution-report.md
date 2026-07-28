# ACU Router 原生协议侦察执行报告

> 执行日期：2026-07-28
> 分支：`productization/protocol-recon-v1`
> 第二阶段起点：`d4c06855e668dfd8673cff7711d68d624a83278b`
> 状态：第二阶段协议基线完成；未合并 main

## 1. 执行摘要

本轮先将既有分支非强制推送至 GitHub，随后安装官方 native Claude Code 2.1.220，部署仅绑定本机的独立 New API v1.0.0-rc.22，并以 Capture A/B 对真实 CloseAI OpenAI/Anthropic 链路和受控 Mock 错误链路完成实测。

新增 19 组脱敏 Fixture：Codex 覆盖 C01/C02/C03/C04/C05/C06/C08/C09/C11，Claude Code 覆盖 A01—A06、A08—A12。确认了两套客户端的 Session/历史重建、Tool 因果链、Planning 强弱信号、New API Responses/Messages 行为、Retry Ownership、Usage 来源和当前 ACU 协议缺口。

没有修改 `src/` 生产路由，没有实现完整 Responses/Messages Adapter，没有接触生产账户/数据，也没有绕过 OpenRouter TOS 限制。未跟踪的 `acu-router.log` 与 `acu_export/` 原样保留且未提交。

## 2. 当前环境

| 项目 | 实测值 |
|---|---|
| OS | Ubuntu 24.04.4 LTS；Linux 6.8.0-134-generic x86_64 |
| Node / npm | 22.23.1 / 10.9.8 |
| Codex | 0.145.0 |
| Claude Code | 2.1.220，native linux-x64，构建 Commit `4073f59596e2` |
| Claude 安装 | 官方 native installer；无 sudo、无 npm global package |
| Claude Doctor | native 2.1.220；bundled search OK；测试环境禁用 auto-update；未登录 claude.ai；安装方式元数据 “not set” 警告 |
| Claude 配置 | 仓库外专用 `/opt/acu-protocol-recon/claude-config`；认证仅用本地环境变量 |
| New API | 页面/OCI `v1.0.0-rc.22`；源码 `bc14c18f6024e79cba1c08d02cd007796e12d668` |
| New API 镜像 | `calciumion/new-api@sha256:d600f20c2781e1a173c2a02f8c33b0c4b1b4e8e5a8b107bafaf2442ae2c9386c` |
| New API 网络 | 仅 `127.0.0.1:3100:3000` |
| New API 数据/日志 | 独立 `/opt/acu-protocol-recon/new-api/data`、`.../logs`；SQLite，无 Redis |
| New API 部署时间 | 容器创建 2026-07-28T20:17:42.907659589Z，服务启动 2026-07-28T20:17:45Z |
| New API Retry/缓存 | 基线 Retry=0；仅对照临时设 1 后恢复 0；Memory Cache 关闭 |
| CloseAI OpenAI | `https://api.openai-proxy.org/v1`，测试凭证可用 |
| CloseAI Anthropic | `https://api.openai-proxy.org/anthropic`，测试凭证可用 |
| OpenRouter | 原合法凭证仍返回 403 TOS policy；未绕过 |

真实管理员密码、用户 Token、Provider Key 均在仓库外 mode 0600 环境文件中；表内只记录版本和存在性。

## 3. 完成的 Fixture

完整索引见 `02-native-protocol-observations.md` 第 38 节。新增 Fixture 数量：Codex 11 组、Claude Code 8 组。每组含 Manifest、Observation、完整脱敏 Capture；A/B 链路另含 `hop-diffs.json`，覆盖 Header、Body、Streaming、Error、Usage、Request ID、Model 与 Tool ID。

真实 Provider 成功链路：

- Codex→New API→CloseAI OpenAI：Text/Streaming、Shell Tool、多 Step。
- Claude Code→New API→CloseAI Anthropic：Text/Streaming、Tool Use/Result、多 Step。
- Codex→CloseAI：五类新人类输入、同/不同目录 Resume、自主复杂修复。
- Claude Code→CloseAI：五类新人类输入、同目录 Resume、Plan→Execution→Test failure→Repair、Thinking/Cache。

受控 Mock：429、500、503 Retry=0/1、SSE idle timeout、两套客户端 Cancel→Resume。所有 Manifest 均明确 `provider_kind=mock`，未宣称 Provider 支持。

## 4. 未完成或阻塞的 Fixture

- Claude→New API→当前 ACU `/v1/messages`：未执行；当前产品代码无入口，本轮禁止提前实现。
- ACU→Provider 的独立 Capture C 和完整独立 D：当前 ACU Responses 入口先 404，未到 Provider。
- OpenRouter 合法成功链路：403 TOS policy 阻塞；Alpha 前必须补齐。
- New API 模型映射/协议转换型渠道、未知字段 fuzz、真实非流式 Responses/Messages：未执行。
- Claude 普通模式自主 Planning 的稳定强信号、跨 project 强制 Resume、并发 Session 冲突：未确认。
- Provider 账单/物理 Actual Model、失败/取消是否计费：无运维日志权限。

## 5. 链路结果

| 链路 | 结果 |
|---|---|
| Codex→A→New API→B→CloseAI OpenAI | 成功；Responses 保持，Tool/Call ID 保持 |
| Codex→A→New API→B→当前 ACU | 失败；`/v1/responses` 404，Provider 未到达 |
| Claude→A→New API→B→CloseAI Anthropic | 成功；Messages 保持，Tool ID 保持，SSE 追加 `[DONE]` |
| Claude→A→CloseAI Anthropic | 成功；Plan/Tool/Resume/Thinking/Cache 均有真实样本 |
| 两套客户端→New API→Mock | 成功建立 Retry Ownership 对照 |
| Codex→OpenRouter | 仍为 403 TOS policy；blocked |

## 6. 核心实测结论

1. Codex 以同一 thread/session Header 组合和增长的完整 Responses `input` 维持连续性；没有 `previous_response_id`。按 Thread ID 可跨 cwd Resume。
2. Claude Code 以 `x-claude-code-session-id` 和增长的完整 Messages 历史维持连续性；New API 删除该 Header。同目录 Resume 成功，父目录本地查找失败且不发 HTTP。
3. Codex Tool Result 是 `function_call_output.call_id`；Claude Tool Result 是 `role=user` 中的 `tool_result.tool_use_id`。Claude 同一 user content 可同时含 Tool Result 与 Text。
4. Codex 实际 `update_plan` 是强信号，但自主复杂任务可能没有该信号。Claude Plan-only System/Tool-set 指纹与实际 `ExitPlanMode` 是强信号。
5. 当前 New API/渠道组合不把 Responses 转 Chat Completions，也不把 Messages 转 OpenAI；Body JSON 语义、Model、Tool ID 和 Thinking/Reasoning 样本保持。
6. New API 不满足“完整 HTTP/SSE 字节无损”：改写鉴权/Host等 Header；Claude 流追加 `data: [DONE]`。Codex 成功 SSE 样本字节/事件相同。
7. Retry=0 时 A/B 次数相等；Retry=1 时 New API 在客户端无感知下多发一次相同上游 Body、使用新 Provider Request ID。
8. Codex 500/503 可出现 CLI 五级 reconnect 背后的 30 个 HTTP Attempt；429+Retry-After:0 只有一次；Timeout 产生 6 次取消。Claude 503 Retry=0 产生 22 次高层调用。
9. Usage 应先保留 Provider 最终 Event；New API 使用记录只能作为带来源的网关解析/扣费值，尚未与 Provider 账单或 ACU Ledger 对账。
10. 当前 ACU 必须后续实现版本化 Responses 与 Messages ingress/passthrough Adapter、SSE/Error/Usage normalization 和 Attempt correlation；不能用 Chat Completions 成功替代。

## 7. 与此前假设冲突的结果

- New API 对当前原生渠道能保持两种请求 Body JSON 语义，但 Claude SSE 会追加 `[DONE]`，所以“无损”只能分层定义，不能笼统宣称。
- New API 删除 Claude Session Header；ACU 不能把该 Header 当作全链路主键。
- `role=user` 既可只含 Tool Result，也可同时含 Tool Result 与 Text；“有 user/text 就是新人类输入”已否定。
- Codex 自主复杂执行不保证调用 `update_plan`；缺少强信号时不得反推 Planning。
- Codex 500/503 的实际 HTTP Attempt 远多于 CLI 展示的 reconnect 级数；多层 Retry 预算风险高于首轮估计。
- Claude Resume 的本地会话发现受项目目录约束，而 Codex 显式 Thread Resume 可跨 cwd。

## 8. 修改过的工程文件

- Harness：`tools/protocol-capture/proxy.ts`、`mock-provider*.ts`、`fixture-cli.ts`、`redact.ts`、`manifest.ts`、`types.ts`、README。
- 隔离部署：`.env.protocol-recon.example`、`.gitignore`、`tools/protocol-capture/new-api/docker-run.example.sh`、部署文档。
- 测试与 Schema：`test/protocol-capture.test.ts`、Fixture README/Schema、新增 19 组 Fixture。
- 文档：`02-native-protocol-observations.md`、本报告。

未修改 `src/` 或完整产品状态机。`acu-router.log`、`acu_export/` 未审计、未暂存、未提交。

## 9. 复用的既有模块

前序审计确认可后续复用现有 HTTP/SSE 转发、Abort/Timeout、429/5xx/Overload 分类、Attempt Trace、Tool/Vision/Context 候选过滤、Judge 上下文、Usage 解析、Provider 调用和 Health 雏形。本轮 Harness 保持独立，未调用 Judge、Router、SessionStore、SQLite ACU Storage 或 Ledger。

## 10. 新增模块

- 受控 status/fail-count/delay/stream-idle Mock Provider。
- SSE Headers 立即 flush 与完成/取消竞态修正。
- SSE JSON 结构化确定性脱敏及 Claude Session Header 脱敏。
- 多上游 Attempt→客户端请求配对的 `hop-diffs.json`。
- 固定 Digest、loopback-only 的 New API 单容器部署模板。
- Manifest 的 chain/provider kind/through ACU/retry/capture completeness 元数据。

## 11. 测试命令和结果

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | 通过：17 files passed、1 skipped；106 tests passed、3 skipped |
| `npm run build` | 通过：ESM + DTS |
| `npm run protocol:scan` | 通过：0 findings |
| `npx eslint tools/protocol-capture/` | 通过：0 errors |
| `npm run lint` | 基线失败：46 errors，全部在既有 `src/`；新增 Harness 0 errors |
| Capture/Fixture targeted | 通过：15/15（含 12 Harness + 3 Fixture suites） |

安全扫描覆盖常见 `sk-` Key、Bearer、x-api-key、Cookie、带凭证 Git URL、`.env` 和私钥格式。新增测试额外验证原始 SSE JSON 中敏感字段及 `x-claude-code-session-id`。

## 12. Commit SHA

| Commit | 内容 |
|---|---|
| `f197a144074ee51b4f5f49bec662590b622859f8` | 初始环境与 Runbook |
| `bdf5c6a86f6583624eba8f6d0d433c9bd52359d3` | 初始 Capture Harness |
| `7d927595be648dd1605cceafc699c0dbcb3b5e26` | Coding Sandbox |
| `0e90d26b0e4b1fc5bb2de6bfc3455795819c2047` | 首批 Codex Fixture |
| `d4c06855e668dfd8673cff7711d68d624a83278b` | 首阶段协议观察文档 |
| `781a494ff16fc799e42b1fea3f119490c3bb46c3` | 隔离 New API 部署、Harness/脱敏/差异增强 |
| `6b86605717ec45577d4addd099fe85d2447c317b` | Claude Code 脱敏 Fixture |
| `74c0a1d42c7420ef505b0ecab5b8a8e56ce32977` | New API Responses、Codex Session/Retry/Cancel Fixture |

最终文档 Commit 无法在自己的内容中记录自己的 SHA；完整 SHA 在人工验收回复与 `git log` 中给出。

## 13. 未解决问题

- ACU 原生 Responses/Messages Adapter、完整 C/D、可信 New API 内部身份和成本回写未实现/未实测。
- OpenRouter 合法成功链路缺失。
- New API 请求记录没有独立物理 Actual Model 或本组 upstream_request_id。
- Provider 失败/取消计费、账单、缓存价格与 Usage 对账缺失。
- Claude 自主 Planning、跨项目 Resume 与并发；两客户端新版本回归尚待执行。

## 14. 需要人工提供的最小环境

1. 通过 OpenRouter 政策检查的合法隔离测试账户和允许 Responses 的模型。
2. 当前 ACU 可部署原生 Adapter 后的隔离实例及 Capture C/内部日志访问权。
3. CloseAI/OpenRouter Provider Request/Generation/账单日志的只读测试访问权，用于 Actual Model 与计费对账。
4. New API 内部回写接口设计/测试权限；不需要也不应提供生产 Token。

## 15. 对 04—10 文档的影响建议

- 04：采用版本化 Session 候选、历史前缀和 Tool 因果链；结构化区分新人类输入；Cancel/Resume 与 Retry 进入 Attempt/Step 状态。
- 05：Judge 接收 evidence strength；Tool Result、自动 Text 和新人类 Text 分开。
- 06：建立跨 Client/New API/ACU/SDK 的总 Attempt Budget，默认禁用 ACU 隐式 Retry。
- 07：Responses、Messages、Chat Completions 为三个独立 Adapter；保留原协议优先。
- 08：记录逐事件 SSE、A/B/C/D ID map、Body HMAC、Tool ID、Cancel、Retry owner、actual-model evidence。
- 09：Provider Usage 原值与派生值分栏，每个 Provider Attempt 独立计费状态，取消不默认零成本。
- 10：定义签名内部身份、ACU actual model/channel/usage/cost 回写、幂等与页面展示；不要依赖被 New API 删除的 Claude Header。
