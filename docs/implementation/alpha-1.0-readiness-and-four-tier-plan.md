# ACU Router Alpha 1.0 就绪度与四档模型池计划

> 基线：ClawRouter `19d800c07bf96a485f5a0d1e79ecc60070693859`  
> 日期：2026-07-29  
> 性质：产品与工程决策文档；不替代真实 Provider Preflight 和真实用户验收。

## 1. 结论

P0 已经完成主要工程骨架和一次较完整的隔离全流程验证，但尚未完成可供邀请用户使用的最终 Release Candidate 验收。

上一轮已真实验证：

- 原生 Codex Responses 与 Claude Code Messages；
- Streaming、Tool Call / Tool Result、Thinking、Planning、Repair、Cancel、Resume；
- Session / Task / Segment / Trigger 状态；
- PostgreSQL 十表轨迹；
- New API 钱包准入、Usage Finalize、幂等扣费和日志展示；
- 160 项 ClawRouter 测试、New API Go/前端测试和隔离 Compose。

上一轮没有完成：

- Live Judge Provider 的真实成本和延迟验证；
- 每协议多个不同模型参与的真实价值路由；
- RC1 修改后的全流程回归、故障注入和稳定性运行；
- 至少 3 名真实邀请用户的样本验证。

因此，在邀请用户之前，服务器 AI 必须基于 RC1 最终 Commit 重新执行一次独立的 Release Candidate 全流程验收。P0 的 PASS 只能作为基线证据，不能直接替代 RC1 上线批准。

## 2. 当前整体计划与完成度

以下百分比是按“3 名邀请用户可开始真实使用的 Alpha 1.0”加权估计，不是成熟企业 SaaS 完成度。

| 工作流 | 状态 | 当前判断 |
|---|---|---:|
| 原生 Gateway、Provider Relay、Streaming、Tool 透明性 | 已完成 P0 验证 | 90% |
| Session / Task / Segment / Trigger / Planning 状态机 | 已完成 P0 验证 | 90% |
| PostgreSQL、Trace、Usage、New API 幂等扣费 | 已完成 P0 验证 | 95% |
| Judge 与现有价值路由公式 | 代码已完成，Live Judge 未验 | 70% |
| 真实四档模型池 | 当前单候选；候选研究已完成，Preflight 未完成 | 20% |
| RC1 全流程回归、故障注入、重启恢复、稳定性验证 | P0 做过，RC1 尚未重跑 | 50% |
| HTTPS、公网入口、邀请 Token、限流、余额和紧急停止 | Runbook 部分具备，仍需部署输入 | 40% |
| 3 名真实设计伙伴与真实价值证据 | 未开始 | 0% |

综合判断：

- 工程底座完成度约 85%—90%；
- 邀请制 Alpha 1.0 技术就绪度约 65%—70%；
- “多模型路由确实带来性价比价值”的产品证据完成度约 30%—40%。

RC1 若成功完成 Live Judge、真实四档候选池和多模型路由验证，技术就绪度可进入约 85%—90%。之后剩余工作的核心不是继续重写架构，而是 RC 验收、公网入口配置和真实用户样本。

## 3. 四档模型池研究结论

使用 `scripts/analyze-acu-four-tier-pool.py` 对当前 Catalog 和 `acu-routing-model-v0.1` 进行离线重放。分析条件：

- 排除 `routingEligible=false`；
- 标准 Coding Agent 场景要求 `toolCallSupport=true`；
- 排除当前受 TOS 403 阻塞的 OpenRouter 上游；
- 使用当前曲线生成、风险调整成本、Pareto Frontier 和 Value Utility 公式；
- 质量偏好 80；
- 难度 0—100；
- 三组 Token 规模：2,000/500、20,000/2,000、100,000/5,000。

完整候选池在三组 Token 规模下，实际被公式选择的模型集合稳定收敛为以下四个：

| 档位 | 首选模型 | Catalog 价格（输入/输出，每百万 Token） | 作用 |
|---|---|---:|---|
| Economy | `qwen3.6-plus` | 0.30 / 1.75 | 低难任务的最低综合成本主力 |
| Value | `kimi-k2.7-code` | 0.95 / 4.00 | Coding 中等难度的性价比主力 |
| Strong | `gemini-3.5-flash` | 1.50 / 9.00 | 中高难度的能力—成本过渡层 |
| Frontier | `claude-opus-4-8` | 5.00 / 25.00 | 高难任务和能力恢复上界 |

在当前公式下的典型难度分段不是硬编码，而是计算结果：

- 低难度约 0—22：`qwen3.6-plus`；
- 中等难度约 23—40/45：`kimi-k2.7-code`；
- 中高难度约 41/46—49：`gemini-3.5-flash`；
- 高难度约 50—100：`claude-opus-4-8`。

边界会随 Token 规模、Judge 结果、Entropy、质量偏好、协议过滤、上下文容量和健康状态动态变化。不得把这些区间写成生产硬阈值。

## 4. 为什么不是其他模型

- `qwen3.5-flash` 和 `deepseek-v4-flash` 更便宜，但在当前质量曲线与预期 Fallback 成本下，没有成为完整池的稳定 Value Utility 最优模型。
- `glm-5.1`、`kimi-k2.6`、`deepseek-v4-pro` 是合理备选，但在当前公式下主要位于有效前沿而不是最终选择集合。
- `gpt-5.5` 和 `claude-sonnet-5` 能力可用，但按当前价格—曲线组合被更有性价比的候选替代。
- GPT-5.6 Sol/Terra/Luna 在当前 Catalog 中 `toolCallSupport=false`，不能进入标准 Coding Agent Tool 请求候选池。
- OpenRouter 模型当前受合法账户 TOS 403 阻塞，不能作为本轮可上线候选。

这些结论是 Catalog 与当前公式重放结果，不是 Provider 兼容性结论。

## 5. Execution Profile 准入顺序

服务器 AI 应优先对四个首选模型分别执行 Responses 和 Messages 原生 Preflight。每个模型只有在以下项目全部成功后，才可加入对应协议的 `execution-profiles.json`：

- 精确原生 Path；
- Text Streaming；
- Tool Call；
- Tool Result；
- Thinking / Reasoning 行为明确；
- 上下文容量；
- Provider 返回的实际模型；
- Provider Usage；
- 价格可计算。

如果首选模型在某协议不通过，按以下备选顺序补位，但必须重新运行离线重放并确认四档覆盖：

1. `glm-5.1`；
2. `qwen3.6-plus` / `kimi-k2.6` 中尚未使用者；
3. `deepseek-v4-pro`；
4. `glm-5.2`；
5. `claude-sonnet-5` 或 `gpt-5.5` 作为协议可用的上界替代。

不得仅按模型名称认定协议兼容，也不得为了凑够四个修改曲线或伪造 Profile。

## 6. 用户前最终 Release Candidate 验收

RC1 完成后，服务器 AI 必须从固定 Commit 做一次干净部署，并完成：

1. Secret、配置、Migration、Compose 和健康检查；
2. ClawRouter 与 New API 全量测试和构建；
3. Live Judge 成功、缓存、去重、非法 JSON、超时和 Rules Fallback；
4. Responses 与 Messages 各自至少 4 个真实合法 modelId 候选；
5. 两个原生客户端的 Streaming、Tool、多 Step、Planning、Repair、Cancel、Resume；
6. 简单、中等、高难和 Planning 任务的多模型 Route 差异；
7. actual_model、Profile、Route、Usage、成本和 New API 扣费一致；
8. Provider 429/5xx/timeout、Judge 失败、数据库和服务重启恢复；
9. 幂等重放不重复扣费，显式模型 Judge=0且不替换；
10. 短时稳定性运行和错误率、P50/P95、Fallback 率报告。

工程测试流量可以用于稳定性验证，但不得被描述为 3 名真实用户或 100 个真实用户请求样本。

## 7. 剩余路线

整体路线只保留四个阶段：

1. **RC1 核心价值闭环**：Live Judge、四档候选池、真实多模型选择；
2. **Release Candidate 验收**：干净部署、全流程回归、故障注入和稳定性运行；
3. **邀请制接入准备**：HTTPS、域名证书、Token、余额、限流和紧急停止；
4. **真实设计伙伴验证**：3 名用户、真实任务轨迹、质量人工复核和成本价值报告。

不应在这四项完成前扩散到完整 SaaS 工作台、复杂策略编辑器、大规模公开注册、订阅计费或更多客户端协议。
