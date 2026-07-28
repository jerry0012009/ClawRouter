# ACU Router 原生协议侦察执行报告

> 执行日期：2026-07-28
> 分支：`productization/protocol-recon-v1`
> 基线：`origin/main@bf5e4421635c35343c1ce20a1d33f191f30392b0`
> 结论状态：部分完成；等待人工补齐 Claude Code、New API 和完整四段链路环境

## 1. 执行摘要

本轮建立了独立透明 Capture Harness、确定性脱敏与 Secret 扫描、Fixture Schema、可丢弃 Coding Sandbox，并用原生 Codex 0.145.0 执行了文本、Streaming、Shell Tool、多 Step 和显式 Planning 场景。仓库提交 6 组脱敏 Codex Fixture。

本轮没有可用 Claude Code 客户端，也没有发现 New API 的版本、测试用户、Key、余额或渠道配置权限。因此没有 Claude Code Fixture，没有 New API → ACU 或 ACU → Provider 的完整链路 Fixture。CloseAI 的成功结论只来自原生 Codex 经 Capture A 的直连；OpenRouter 的 403 失败同样是有效实测，但不构成兼容支持。

没有修改 `src/` 下的生产 Proxy、Router、Session、Judge、Storage 或 Ledger，也没有推翻 00—04 已确认的产品边界。

## 2. 当前环境

| 项目 | 值或状态 |
|---|---|
| 操作系统 | Ubuntu 24.04.4 LTS；Linux 6.8.0-134-generic x86_64 |
| Node.js | 22.23.1 |
| npm / pnpm | 10.9.8 / 10.34.0 |
| ClawRouter 基线 Commit | `bf5e4421635c35343c1ce20a1d33f191f30392b0` |
| Codex | `codex-cli 0.145.0` |
| Claude Code | 未安装，命令不存在 |
| New API | 未发现运行版本、镜像 Tag 或 Commit |
| New API 测试账户 | 用户、Key、余额均不可确认 |
| New API 渠道 Base URL | 修改权限不可确认 |
| 当前 ACU | 本地 8402/8403 可访问并可读日志；运行中 `dist` 的加载 Commit 不可确认 |
| OpenRouter | 凭证存在；模型目录可访问；测试请求被 403 TOS policy 拒绝 |
| CloseAI OpenAI 协议 | 凭证存在；`/v1` 直连成功 |
| CloseAI Anthropic 协议 | 用户给定 Base URL `/anthropic`；未执行 |
| 网络与端口 | 外部 HTTPS 可访问；80/443 由 nginx 占用；8402/8403 为现有 ACU；可使用本地临时高位端口 |

所有凭证只记录存在性，不记录或提交实际值。原始 Capture 在仓库外，提交内容已脱敏。

## 3. 已完成的 Fixture

| Fixture ID | 覆盖场景 | 结果 | Capture 状态 |
|---|---|---|---|
| `codex-0.145.0-C01-mock-001` | C01；Harness 与原生客户端最小连通 | 8 个 SSE 事件，成功 | `partial` |
| `codex-0.145.0-C01-closeai-001` | C01、C02 | CloseAI `gpt-5.6-terra` 文本 Streaming 成功 | `partial` |
| `codex-0.145.0-C01-openrouter-001` | C01 Provider 失败路径 | 6 次 POST 均为 403 | `failed` |
| `codex-0.145.0-C03-C04-closeai-001` | C03、C04 | Shell Tool 与两 Step 成功 | `partial` |
| `codex-0.145.0-C06-closeai-001` | C06 的显式 Plan 子场景 | Plan → Execution → Test failure → Plan update/Repair → Pass | `partial` |
| `codex-0.145.0-C01-acu-current-001` | 当前 ACU Responses ingress 失败路径 | `/v1/responses` 6 次 404，Provider 未到达 | `failed` |

`partial` 的原因是只具备 Capture A，未覆盖 New API、ACU 和 Provider 四段观察点；它不表示推测性补全。

## 4. 未完成的 Fixture 与场景

- Codex C05 五类真实用户输入：继续、新约束、明显换任务、重做、不满意。
- Codex C06：无明确 Plan 指令时自主 Planning、修改代码后失败导致的 Replanning。已完成的 Fixture 只证明显式 Planning。
- Codex C08 Resume/Continue、C09 受控 429/5xx/Timeout、C11 原生客户端取消。Harness 单元测试不能替代原生客户端 Fixture。
- Claude Code A01—A12 全部未执行。
- 原生客户端 → New API → ACU、ACU → OpenRouter、ACU → CloseAI 的完整链路均未执行。
- CloseAI Anthropic `/anthropic/v1/messages` 未执行。

## 5. 链路执行结果

| 链路 | 结果 | 可得结论 |
|---|---|---|
| Codex → Capture A → controlled Mock | 成功 | 只证明 Harness/客户端基本 Responses SSE 连通 |
| Codex → Capture A → CloseAI `/v1` | 成功 | `gpt-5.6-terra` 文本；`gpt-5.5` Tool、多 Step、显式 Planning |
| Codex → Capture A → OpenRouter `/api/v1` | 失败 | 六次 403 TOS policy；不能标记 Provider 支持 |
| Codex → Capture A → 当前 ACU | 失败 | `/v1/responses` 六次 404；Provider 未到达 |
| Codex/Claude → New API → ACU → Provider | 阻塞 | 无 New API 测试环境，不能判断字段改写或回写 |
| Claude Code → 任一链路 | 阻塞 | 客户端未安装 |

## 6. 核心实测结论

1. Codex 0.145.0 模型调用为 `POST /v1/responses` 且 `stream=true`，并先探测 `GET /v1/models?client_version=0.145.0`。
2. Tool arguments 通过多个 `response.function_call_arguments.delta` 到达；本地 Tool Result 在下一请求以匹配 Call ID 的 `function_call_output` 返回。
3. 两 Step 样本没有 `previous_response_id`，客户端重发并扩展 Responses Item 历史。
4. 实际 `update_plan` Function Call 是 Planning 强信号；仅声明该 Tool 不是 Planning 发生事实。
5. `session-id`、`thread-id` 和 `x-client-request-id` 在本轮同一运行的多 Step 中保持稳定，但尚未验证 Resume/并发/New API 透传。
6. Codex 对 403 和 404 均进行五次 reconnect，加首次请求共六次 POST；同一 `x-client-request-id` 复用但 Body Hash 变化。
7. CloseAI 成功流的 `response.completed.response.usage` 含 cached input 和 reasoning output 明细；Actual Model 仅能确认“响应声明匹配请求”，没有独立 Provider 日志佐证物理后端。

## 7. 与此前假设冲突或需要收紧的结果

- 当前 ClawRouter 主链路只接受 `/chat/completions`，原生 Codex 的 `/v1/responses` 实测为 404；“OpenAI-compatible”不能自动等价为原生 Codex 兼容。
- 多 Step 没有观察到 `previous_response_id`；状态机不能只靠该字段，必须支持完整/增长的 Item 历史与 Tool Call 因果链。
- `x-client-request-id` 在重试中复用，不能充当 Provider Attempt 唯一键或成本幂等键。
- 模型元数据会影响请求工具和 instructions 形态；Tool Schema 的出现不能单独判断 Task Phase。
- `/models` 返回格式与 Codex 预期不完全一致时，模型调用仍可能继续；模型探测失败不能自动创建业务 Step。

## 8. 修改过的代码与工程文件

- 环境与安全：`.env.protocol-recon.example`、`.gitignore`。
- Capture Harness：`tools/protocol-capture/`。
- 测试：`test/protocol-capture.test.ts`、`test/protocol-fixtures.test.ts`。
- Sandbox：`test/protocol-sandbox/`。
- Fixture：`test/protocol-fixtures/`。
- 工程脚本：`package.json`。
- 文档：`docs/productization/protocol-recon-runbook.md`、`02-native-protocol-observations.md`、本报告。

未修改任何 `src/` 生产路由逻辑。

## 9. 复用与审计的现有模块

本轮审计了 `src/proxy.ts`、`src/session.ts`、`src/router/`、`src/models.ts`、`src/acu/` 和 `src/ledger.ts`。现有透明 Streaming、Abort/Timeout、429/5xx/Overload 分类、Attempt Trace、Tool/Vision/Context 候选过滤、Judge 上下文、Usage 解析和 Provider 调用结构可作为后续适配基础。

Harness 保持独立，不调用 Judge、不执行路由、不注入文案，也不导入当前 SessionStore、SQLite 或 JSONL Ledger。第一条 User Message Hash、30 分钟 Session Timeout、固定 Baseline Model、SQLite/JSONL 均未被本轮提升为产品规则。

## 10. 新增模块

- 多实例透明 HTTP/SSE Capture Proxy 与逐事件记录器。
- 确定性 Header/Body 脱敏、同 Fixture 稳定占位符和不可逆 HMAC 摘要。
- Fixture 生成器、Manifest 校验器、Header/Body Diff。
- Fixture Secret 扫描 CLI。
- 受控 Responses Mock Provider。
- 10 类场景的可重置 Coding Sandbox。

## 11. 测试命令和结果

本报告最终校验使用以下命令：

| 命令 | 结果 |
|---|---|
| `npm install` | 通过；依赖无变更。npm audit 报告现有依赖树 7 项漏洞：2 moderate、4 high、1 critical |
| `npm run typecheck` | 通过；生产代码与 Capture Harness 均通过 TypeScript 检查 |
| `npm run lint` | 失败；46 个错误全部位于既有 `src/`，新增 Harness 没有 lint 错误 |
| `npm test` | 通过；17 个 Test File 通过、1 个跳过；104 个 Test 通过、3 个跳过 |
| `npm run build` | 通过；ESM 与 DTS 构建成功 |
| `npm run protocol:scan` | 通过；Fixture Secret 扫描无发现 |
| `npx eslint tools/protocol-capture/` | 通过；0 错误 |

新增 Capture/Fixture 测试共 13 项并全部通过，覆盖请求转发、非流式字节透传、SSE 逐事件透传、取消、Tool Calling 内容不变、Header/Body 脱敏、稳定占位符、HMAC、Secret 扫描、Manifest 校验和 Header/Body Diff。

`npm run lint` 的 46 个错误均指向本轮未修改的 `src/cli.ts`、`src/index.ts`、`src/models.ts`、`src/proxy.ts` 和 `src/response-store.ts`；主要是未使用导入/赋值和 `require()` 规则。没有删除或放宽测试规则。`npm install` 的 audit 告警未自动修复，因为 `npm audit fix --force` 可能引入超出协议侦察范围的破坏性依赖升级。

## 12. Commit SHA

| Commit | 说明 |
|---|---|
| `f197a144074ee51b4f5f49bec662590b622859f8` | `chore: add protocol reconnaissance environment and runbook` |
| `bdf5c6a86f6583624eba8f6d0d433c9bd52359d3` | `feat: add transparent protocol capture harness` |
| `7d927595be648dd1605cceafc699c0dbcb3b5e26` | `test: add disposable coding protocol sandbox` |
| `0e90d26b0e4b1fc5bb2de6bfc3455795819c2047` | `test: add sanitized codex protocol fixtures` |

承载本报告和最终 02 文档的 Commit 无法在自身内容中预写自己的 SHA；其完整 SHA 由 `git rev-parse HEAD` 和人工验收回复给出。

## 13. 未解决问题

- New API 对 Path、Header、Body、Model、Tool ID、Reasoning/Thinking、SSE、Usage、Error 的实际改写未知。
- New API、ACU、Provider SDK 和原生客户端各自的 Retry Ownership 未形成完整矩阵。
- OpenRouter 当前凭证/账户被 TOS policy 拒绝，尚无成功链路。
- 当前 ACU 不接受原生 Codex Responses ingress；运行中 `dist` 对应源码 Commit 不可确认。
- Claude Messages、Tool Use、Thinking、Prompt Cache、Plan Permission、Resume 和取消行为全部未知。
- Session Header 在 Resume、并发运行及经 New API 后的稳定性和可信性未知。
- Provider Usage 与 New API 余额扣减、ACU Ledger/成本回写尚未对账。

## 14. 需要人工提供的最小环境

1. 安装并固定版本的原生 Claude Code，以及仅用于隔离测试的 Auth。
2. 可识别版本的 New API 测试部署、一次性测试用户/API Key/余额和渠道 Base URL 修改权限。
3. 在 New API 与 ACU 前后插入 Capture B/C 的权限，以及 ACU/Provider Request ID 和成本日志访问权。
4. 可通过账户政策检查并允许 Responses 的 OpenRouter 测试凭证/模型。
5. 如需 Anthropic 链路：CloseAI Base URL `https://api.openai-proxy.org/anthropic` 对应的隔离 Key；目标 Messages Path 应由原生 Claude Code 实际产生，不手工伪造。

## 15. 对后续产品化文档的影响建议

- 04 状态机：加入版本门控的 Codex Header 候选、完整 Item 历史和 Call ID 因果链；禁止以 `x-client-request-id` 作为 Attempt/计费幂等键；实际 `update_plan` 才触发强 Planning 信号。
- 05 Judge：区分真实新增用户 Message 与 `function_call_output`、Plan Tool Result；保留新外部输入重新 Judge 的既定规则。
- 06 Routing：把客户端 Retry 纳入总 Attempt Budget，避免与 New API/ACU/SDK Retry 相乘。
- 07 Provider Adapter：将 Responses、Chat Completions、Messages 分开做版本化 Adapter；不能用一种协议成功外推其他协议。
- 08 Trace：逐 SSE 事件保存原始边界、到达时间、Usage、Error、Cancel 和各层 Request ID。
- 09 Cost Ledger：优先使用可信 Provider 最终 Usage 并与账单对账；对失败重试保存独立 Attempt，避免重复计费。
- 10 New API 集成：验证 Header 白名单、模型/协议改写、余额扣减、实际模型/渠道/Usage/成本回写与错误包装。

这些建议不提前实现 05—10 的正式产品模块；必须等缺失 Fixture 和人工验收后再进入设计修订。
