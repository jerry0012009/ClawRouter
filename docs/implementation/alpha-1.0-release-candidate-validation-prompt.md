# ACU Router Alpha 1.0 Release Candidate 独立验收提示词

以下提示词应在当前 Alpha RC1 任务完成、两个最终 Commit 已知后执行。先替换两个 Commit 占位符。

---

Goal：基于 Alpha RC1 的最终结果，执行一次独立的 Alpha 1.0 Release Candidate 审计、全流程回归和上线前验证。不要默认相信 RC1 报告，必须从代码、配置、数据库、运行日志、Provider Usage 和原生客户端行为重新取证。只修复真实 Stop-Ship 或验收阻塞，不重写 Gateway、状态机、PostgreSQL、New API 集成或 `acu-routing-model-v0.1`。

固定输入：

ClawRouter RC1 Commit：`<CLAWROUTER_RC1_COMMIT>`  
New API RC1 Commit：`<NEWAPI_RC1_COMMIT>`

从以上 Commit 分别创建：

ClawRouter：`productization/alpha-1.0-rc-validation`  
New API：`acu/alpha-1.0-rc-validation`

不得修改 main，不得 force push，不得合并 main。

## 一、先做独立差异审计

1. 对比 P0 基线和 RC1 最终 Commit，列出所有代码、配置、Migration、Profile、测试和文档变化。
2. 核对 RC1 报告中的每个关键数字是否能够由数据库 SQL、日志或测试输出重建。
3. 不得把自动化 Fixture、Mock Provider、Rules fallback、工程脚本用户描述为真实 Provider、真实 Judge 或真实邀请用户。
4. 检查是否出现第二套 Judge 配置、第二套难度公式、第二套路由公式、重复计费入口或绕过 ACU 的执行路径。
5. 发现 Stop-Ship 时先记录证据，再做最小修复，并增加回归测试。

## 二、干净部署与静态验收

从固定 Commit 做全新构建，不复用旧容器镜像和旧 build artifact；保留数据库备份，不执行 `down -v`。

完成并保存输出：

- ClawRouter typecheck、test、build、修改文件 lint、生产依赖 audit；
- New API Go tests、ACU 专项测试、前端 typecheck/build；
- Secret scanner、protocol scanner、staged diff scanner；
- `docker compose config --quiet`；
- Migration 幂等执行；
- 四服务健康检查；
- ACU 与 PostgreSQL 无宿主机 published port；
- New API 仅绑定预期地址；
- `.env` 和真实 Secret 未进入 Git、日志或报告。

历史基线问题可以保留，但不得新增错误或安全告警。

## 三、四档模型池独立复核

先运行当前 Catalog 离线分析脚本，或按同一公式重放全部 routing-eligible、支持 Tool、价格可计算且非 blocked 上游的模型。

当前优先四档候选为：

1. Economy：`qwen3.6-plus`；
2. Value：`kimi-k2.7-code`；
3. Strong：`gemini-3.5-flash`；
4. Frontier：`claude-opus-4-8`。

这只是 Catalog 优先顺序，不是协议兼容结论。

对 Responses 和 Messages 分别执行合法原生 Preflight。每个 Execution Profile 必须逐项验证：

- 精确原生 Path；
- Text Streaming；
- Tool Call；
- Tool Result；
- Thinking / Reasoning 行为；
- 上下文容量；
- Provider 返回的 actual model；
- Provider Usage；
- 输入、输出、缓存、推理 Token 价格可计算。

标准 Tool Coding 请求在协议和策略过滤后，每种协议目标为至少 4 个不同 `modelId`。同一模型的多个 Provider/Profile 只能算一个模型候选。

首选四档中某模型不支持某协议时，按真实 Preflight 和当前公式从以下备选中补位：

- `glm-5.1`；
- `kimi-k2.6`；
- `deepseek-v4-pro`；
- `glm-5.2`；
- `claude-sonnet-5`；
- `gpt-5.5`。

补位后必须重新重放完整候选池，确认最终四个模型分别贡献可解释的成本—质量位置。不得只因名称、供应商或兼容标签加入 Profile；不得修改曲线、价格、Difficulty 或质量偏好来制造四档分布。

如果某协议少于 4 个真实合法 modelId：

- 不得凑数；
- 继续完成其他验收；
- 明确列出失败模型、失败阶段、Provider 返回和替代建议；
- 报告不得称为“四模型智能路由”。

## 四、Live Judge 复核

复用现有 `readAcuRuntimeConfig`、`AcuJudgeClient`、缓存和回退链，不新建第二套实现。

独立验证：

- 至少 20 次 `upstream_live` Judge 成功；
- new_task、human_message、plan_started、plan_finished、repeated_failure、safety_refresh 均有覆盖；
- cache_hit、recent_evaluation、rules_fallback 分别有证据；
- 同一 Trigger 重放不产生第二次 Judge 费用；
- 非法 JSON、超时、401/403/429/5xx 均不阻断 Agent；
- 非法 JSON 可以使用受控测试入口或 Fixture，不得冒充真实 Provider 自发返回；
- Judge model、Provider、latency、usage、cost、Difficulty、Entropy、context truncation、fallback reason 完整记录。

输出 Judge P50/P95、平均成本、Live 成功率、Cache 率、Recent Evaluation 率和 Rules Fallback 率。

## 五、原生客户端全流程回归

必须使用当前固定版本或报告中明确的新版本原生 Codex 与 Claude Code，分别覆盖：

- 基础 Streaming；
- Tool Call / Tool Result；
- 多 Step；
- Planning → PlanFinished → Execution；
- Repair；
- Cancel；
- Resume；
- 显式模型；
- `acu-auto`。

任务矩阵至少包括简单、中等、高难和 Planning。验证：

- 每种协议合法候选数符合实际报告；
- 每种协议至少实际选择两个不同模型；
- 两种协议合计至少实际选择三个不同模型；
- 简单和高难任务的候选估值或 Route 结果出现可解释差异；
- PlanFinished 重新 Judge、重新生成候选并重新选择 Profile；
- repeated_failure 只能保持或升级；
- 88 不是硬阈值；
- 显式模型 Judge=0、不替换、不计算 ACU 节省率；
- actual_model、Execution Profile、Route Decision、Provider Usage、成本和 New API 日志完全一致。

不得要求所有模型平均分流，也不得为了产生多模型分布而改变输入标签或配置。

## 六、故障注入与恢复

在隔离环境验证：

- Judge timeout、非法 JSON、认证失败、429、5xx；
- Provider timeout、429、503、连接中断；
- 首次可见 SSE 后禁止静默拼接其他模型结果；
- Attempt 总数上限；
- ACU 重启；
- New API 重启；
- PostgreSQL 短暂不可用与恢复；
- Usage Finalize 网络重试；
- 同一 idempotency key 重放不二扣；
- 同 key 不同 Body 被拒绝；
- 余额不足、Token 禁用和限流阻断正确；
- 紧急停止方式有效。

不得使用真实生产数据。

## 七、短时稳定性运行

在隔离工程用户下执行足以覆盖两种协议、四类任务和多模型选择的稳定性流量。可以使用工程任务和自动化 Harness，但必须标注为 engineering soak，不得计入 3 名真实用户或真实用户 100 请求门槛。

报告：

- 总请求数、成功、取消、失败；
- Responses / Messages 分布；
- 各模型选择次数；
- 候选池大小、硬过滤后数量、Pareto Frontier 数量；
- Judge P50/P95；
- Provider P50/P95；
- Judge 与模型调用成本；
- Rules Fallback 率；
- Provider Failure 率；
- Usage Report acknowledged 率；
- 账本与 Provider Usage 对账差异。

## 八、公网邀请准备检查

不自动修改 DNS、证书或生产反向代理。

检查 Runbook 是否包含并可执行：

- HTTPS 反向代理推荐配置；
- 域名和证书人工输入；
- 邀请用户创建；
- 用户 Token 创建；
- 余额、兑换码和限流建议；
- 日志和 Trace 查询；
- 数据备份；
- 紧急停止；
- 回滚到 RC1 固定 Commit。

将需要创始人或运维人工填写的内容集中列为 `Manual Inputs`，不得猜测。

## 九、最终报告与 Stop-Ship 判定

生成：

`docs/implementation/alpha-1.0-release-candidate-validation-report.md`

报告必须包括：

- 固定 Commit、镜像 ID 和环境；
- P0/RC1/RC Validation 差异；
- 全部测试结果；
- Live Judge 证据；
- Responses 与 Messages 实际候选模型；
- 原生能力矩阵；
- Route、Difficulty、Judge、成本和 Fallback 统计；
- 故障注入与恢复；
- 稳定性运行；
- Manual Inputs；
- 未完成项；
- Stop-Ship 清单；
- 是否“技术上具备邀请 3 名用户的条件”。

只有以下条件全部满足时，才能给出“技术上具备邀请条件”：

- 无已知数据泄露、重复扣费、身份伪造或协议破坏；
- Live Judge 可用且失败不阻断；
- 每种协议真实候选数量按实际准确报告；
- 原生客户端核心流程通过；
- Route、actual_model、Usage 和成本一致；
- 重启、回滚和紧急停止可执行；
- 公网所需 Manual Inputs 已明确。

“技术上具备邀请条件”不等于已完成 3 名真实用户验证。

不得将工程测试用户、脚本流量或 P0 的 94 个单候选请求描述为真实多模型节省证据。不得合并 main。

测试通过后分别普通 push，并报告两个最终 Commit。
