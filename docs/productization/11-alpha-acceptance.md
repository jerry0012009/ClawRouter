# ACU Router 五日 Alpha 验收方案

> 状态：产品设计初稿，待创始人审阅  
> 版本：v0.1  
> 日期：2026-07-29  
> 依赖：`00-product-scope.md`、`02-native-protocol-observations.md`、`03-system-architecture.md`、`04a-alpha-state-machine-implementation-profile.md`、`05-judge-and-trigger-policy.md`、`06-planning-detection.md`、`07-failure-taxonomy-and-blockage-rules.md`、`08-routing-and-upstream-recovery-policy.md`、`09-postgresql-data-model.md`、`10-new-api-integration.md`

## 1. 验收目标

五日 Alpha 不证明 ACU 已成为通用 Agent Router，也不证明已经达到商业规模。

本阶段只证明以下最小闭环：

```text
原生 Codex / Claude Code
→ New API 鉴权与余额准入
→ 独立 ACU Router
→ Judge / 连续价值公式 / Route 锁定
→ Provider 原生 Streaming 与 Tool
→ PostgreSQL 完整轨迹
→ New API 幂等最终扣费
```

## 2. 正式支持范围

P0 正式验收客户端：

- Codex `/v1/responses`；
- Claude Code `/v1/messages`。

P0 正式模式：

- 显式模型；
- `acu-auto`。

非阻断项：

- `acu-high`；
- OpenClaw；
- Hermes；
- 其他 OpenAI-compatible Agent；
- 多 Agent / Subagent 专用状态。

这些可以实验性透传，但不得宣称完成 ACU 任务级自动路由兼容。

## 3. 环境基线

验收环境至少包含：

```text
new-api
acu-router
postgres-newapi
postgres-acu
CloseAI 测试 Channel
```

要求：

- New API 对 ACU Channel `Retry = 0`；
- ACU 最大 Provider Attempt = 2；
- ACU 与 PostgreSQL 不对公网；
- 使用测试用户、测试 Token 和测试余额；
- 不使用生产数据；
- Provider 和内部 Secret 不进入 Git 或日志正文。

OpenRouter 当前受合法账户政策 403 阻塞。五日工程验收允许其继续标记 `blocked`，但在扩大外部 Alpha 前必须至少完成一条合法成功链路，或由团队书面决定暂时只提供 CloseAI 上游。

## 4. Gate A：原生协议

必须全部通过：

1. Codex 通过 New API Base URL 完成 `/v1/responses` 文本 Streaming；
2. Codex 完成 Shell / Function Tool Call 与 Result；
3. Claude Code 通过 New API Base URL 完成 `/v1/messages` Streaming；
4. Claude Code 完成 `tool_use` / `tool_result`；
5. Claude Thinking / Signature 不被 ACU 改写；
6. Tool ID 在 Client → New API → ACU → Provider → Client 全链路保持因果一致；
7. ACU 不向原生响应正文注入说明文字；
8. Streaming 已输出后不静默拼接其他 Provider 或模型结果；
9. Client Cancel 后 Attempt 状态和已输出前缀可审计。

任一原生客户端无法完成多 Step Tool 任务，Gate A 失败。

## 5. Gate B：模式与 Judge

### 显式模型

必须证明：

- Judge 调用数为 0；
- ACU 不替换模型；
- P0 不自动跨 Channel Failover；
- Usage、Attempt、Payload 和成本仍完整记录。

### `acu-auto`

必须证明六类 Trigger：

1. 新 Task；
2. 高置信度 HumanMessage，包括“继续”；
3. PlanStarted；
4. PlanFinished；
5. 相同核心执行失败第二次出现且无进展；
6. 连续 16 个 accepted Model Response 的 safety refresh。

必须证明以下事件不 Judge：

- 普通 ToolCall / ToolResult；
- 普通 Agent 自动继续；
- Retry；
- Provider 429 / 5xx / Timeout；
- 第一次 ExecutionFailure；
- PlanUpdated。

同一 Trigger 因历史重发或 Client / New API Retry 被重复送达时，只产生一个逻辑 Evaluation。

## 6. Gate C：Planning

Codex：

```text
实际 update_plan
→ PlanStarted
→ Planning Judge
→ temporary_phase_override = 88
```

```text
Plan 必要项完成
+ 首次实际 Edit / Write / Patch / Test / Build
+ 无 Plan 重建
→ PlanFinished
→ Execution Judge
```

Claude Code：

```text
版本化 Plan-only 指纹
→ PlanStarted
```

```text
实际 ExitPlanMode
→ PlanFinished
```

必须证明：

- 88 是连续价值公式偏好锚点，不是候选硬阈值；
- PlanUpdated 不重复 Judge；
- PlanFinished 撤销 88 并根据完成后的 Plan 重新 Judge；
- 历史重发不重复产生 Planning Event。

## 7. Gate D：路由公式

使用固定 Fixture 对比 `src/acu/decision.ts`，数据库重放结果必须一致。

至少验证：

1. 硬兼容候选被排除；
2. 质量目标不作为正常 P0 硬过滤线；
3. 所有候选预测分低于 88 时仍能选择 Profile；
4. 所有候选预测分高于 88 时成本效用仍参与选择；
5. Pareto Frontier 计算一致；
6. `riskAdjustedScore` 一致；
7. `qualityUtility`、`costUtility`、`valueUtility` 一致；
8. 最终选择为 `argmax(valueUtility)`；
9. `meetsQualityTarget` 只用于解释和分析；
10. Route Decision 保存 Formula、Curve、Price 和 Policy Version。

不要求五日内证明质量曲线已经达到真实单请求概率校准。

## 8. Gate E：Failure 与恢复

必须验证：

- 第一次执行失败只记录 Evidence；
- 相同核心 Failure Signature 第二次出现且无进展时重新 Judge；
- 重复失败 Route 只允许保持或升级；
- Provider Error 不改变 Difficulty；
- 协议、权限、依赖和环境错误不计入能力失败；
- New API 不透明 Retry；
- 每个逻辑执行请求最多两个 Provider Attempt；
- 优先尝试同模型等价备用 Channel；
- 无安全恢复候选时返回明确错误。

## 9. Gate F：PostgreSQL 与恢复

必须验证：

1. Alpha 新流量只写 PostgreSQL；
2. Session 不因固定时间失效；
3. 同一 Task 同时最多一个 active Segment；
4. Logical Request 与 Provider Attempt 分离；
5. Retry 只增加 Attempt；
6. 完整请求、响应和 SSE 仅存 PostgreSQL；
7. 不存在 pgvector、Embedding 或 Memory 表；
8. 数据库崩溃重启后可恢复 Session、Segment、Route、Logical Request 和 Attempt；
9. 不同用户相同 Prompt 不发生跨用户 Session 合并；
10. 管理员可以从 Logical Request 追溯完整链路。

## 10. Gate G：New API 与扣费

必须验证：

- 未授权请求不会到达 ACU；
- 客户端伪造内部 Header 不会获得其他用户身份；
- ACU 获得稳定 New API User、Token 和 Log ID；
- ACU Channel 静态最终扣费关闭或归零；
- 一个 Logical Request 只生成一个 Usage Report；
- Usage Report 重试不会重复扣费；
- Judge 和 Provider 成本按实际 1.0 倍汇总；
- Provider 未收费的失败 Attempt 不计费；
- New API 前台显示实际模型、Channel、Token 和最终成本；
- Finalize 暂时失败时，成功响应不回滚，待结算记录不丢失。

## 11. Gate H：安全

必须验证：

- Git、Fixture、PostgreSQL Trace 中不存在真实 API Key；
- Authorization、Cookie 和 Provider Secret 在持久化前删除；
- ACU 和 PostgreSQL 不对公网；
- 所有普通数据查询带 New API 用户范围；
- 管理员完整轨迹接口需要独立管理员身份；
- 请求体、响应体和 Tool 内容不会写入普通应用日志；
- Secret 扫描为 0 Finding。

## 12. 最小真实流量样本

五日工程验收完成后，邀请制 Alpha 至少采集：

```text
≥ 100 个真实 API 调用
≥ 20 个多 Step Coding Task
≥ 3 名真实用户
```

建议覆盖：

- Codex 和 Claude Code；
- 显式模型和 `acu-auto`；
- 文本、Tool、Planning、Test Failure、Repair、Cancel；
- 长于 16 个 accepted Model Response 的任务；
- 至少一次 Judge Fallback；
- 至少一次 Provider Recovery。

## 13. 本阶段不作为上线阻断的商业指标

以下指标必须记录，但不作为五日工程 Gate：

- 平均成本下降 30%；
- 质量差距不超过 3—5 个百分点；
- 错误降级率低于 5%；
- 1000 Task / 300 Label；
- 第二上游成功链路；
- 用户续费或正式付费。

这些是后续设计伙伴和商业验证指标，不能通过五日代码测试伪造。

## 14. Stop-Ship 条件

出现以下任一情况，不得交付首批用户：

1. 显式模型仍调用 Judge 或被自动换模型；
2. Tool ID、Thinking 或 Streaming 被破坏；
3. 同一 Trigger 重复 Judge 或重复收费；
4. Provider Retry 无界放大；
5. Route 使用“低于 88 即淘汰”的错误逻辑；
6. 跨用户 Session 或 Trace 泄漏；
7. 成功请求没有可恢复的 Usage Report；
8. 原始 Secret 被持久化；
9. ACU 绕过 New API 账户准入；
10. New API 与 ACU 形成代理循环或双重扣费。

## 15. 验收输出物

验收结束必须交付：

- 代码 Commit / PR；
- Migration 与回滚说明；
- Docker Compose；
- 环境变量模板；
- 自动化测试报告；
- 原生 Codex / Claude Code 脱敏 Fixture；
- Formula Replay 报告；
- PostgreSQL 数据完整性报告；
- New API 扣费幂等报告；
- Secret 扫描报告；
- 已知问题清单；
- P1 排期建议。

## 16. 最终通过标准

五日 Alpha 通过需同时满足：

```text
Gate A—H 全部通过
+ Stop-Ship = 0
+ 真实流量样本达到最低量
+ 所有未完成项明确标记 P1 / Blocked
```

30% 成本下降不是本次工程验收条件，但系统必须已经能够准确记录未来验证该指标所需的 Task、Evaluation、Route、Attempt、Usage、成本和 Outcome 数据。