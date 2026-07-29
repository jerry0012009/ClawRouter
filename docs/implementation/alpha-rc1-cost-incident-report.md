# ACU Router Alpha RC1 成本事故归因

> 取证窗口：2026-07-29 06:25:17.807521 UTC 起；环境为隔离 Alpha，不含生产用户或生产数据。
>
> 结论状态：**Stop-Ship，未发现双重 Retry，但取消请求的 Provider 计费无法闭环，且测试账户在矩阵中耗尽余额。**

## 1. 执行结论

- ACU 数据库中本窗口有 185 个 Logical Request 和 185 个 Provider Attempt；所有 Attempt 均为 `attempt_index=1`、`retry_owner=acu`、`attempt_kind=provider`。没有 ACU 第二 Attempt，也没有 ACU Fallback Attempt。
- New API 的 ACU Channel Failure Retry 固定为 0。本窗口未发现 New API Retry 与 ACU Retry 叠加证据。
- 70 次落库 Judge 全部为 `live/upstream_live`，总成本 USD 0.0638331；每个 Trigger 的持久化幂等键唯一。独立验证确认相同输入第二次为 `cache_hit` 且费用为 0。
- ACU Usage Report 已确认 178 条，Provider 成本 USD 0.5215872、Judge 成本 USD 0.05758605、最终扣费 USD 0.57917325。其余 7 条对应 6 个错误和 1 个待处理 Logical Request。
- 28 个取消 Attempt 带 Provider Usage，但 `provider_billed=NULL`、`actual_cost_usd=0`。这不能证明 Provider 未收费，是当前最严重的对账缺口。
- Messages 高难/Planning 阶段出现 CloseAI `insufficient_balance`，后续批量真实测试已停止。

## 2. 费用来源

| 来源 | 模式 | 已知费用（USD） | 说明 |
|---|---:|---:|---|
| ACU 数据库 Provider Attempt | `acu-auto` | 0.5210172 | 数据库总额扣除显式 GPT-5.5 的 0.00057；包含真实客户端矩阵和少量触发验证 |
| 显式 GPT-5.5 经 ACU | explicit | 0.0005700 | Judge=0，requested/selected/actual 均为 GPT-5.5 |
| 11 个原生 Provider Preflight | explicit direct | 1.0384837 | Responses 5 个、Messages 6 个；未进入 ACU/New API 账本 |
| 落库 Live Judge | judge | 0.0638331 | 70 次 `upstream_live` |
| 两次独立 Judge Smoke | judge direct | 0.00057915 | 真实上游调用；cache/recent/rules 验证费用为 0 |

因此可由现有证据重建的 Provider 最低费用为 **USD 1.62448315**。它不是 Provider Dashboard 的最终账单：取消请求是否收费尚未对账，且 Preflight 在引入 `test_run_id` 前执行，无法逐笔关联到 Provider Dashboard。

原生矩阵中可明确归因的已知模型成本为 USD 0.4870872：Responses Luna 0.1737539、Responses Sol 0.2289185、Messages Luna 0.0844148。Opus 的 5 次调用因余额不足失败，ACU 记 0；是否产生 Provider 侧最低费用仍需账单确认。

## 3. 模型逐项解释

- `gpt-5.6-luna`：两种协议的 Value 候选，也是简单/中等任务主要自动选择；大部分调用来自 `acu-auto` 原生矩阵。
- `gpt-5.6-sol`：Responses Recovery/高难候选；4 个高难任务中的高 Difficulty Segment 实际选择过该模型。
- `gpt-5.6-terra`：两种协议的 Strong 候选；完成 Preflight，也多次进入 Pareto Frontier，但本样本中 Value Utility 未成为最大值，因此未被实际选择。
- `gpt-5.5`：完成两种协议显式 Preflight，并保留 Frontier/Recovery Profile；自动样本中被 Pareto 支配，只有一条显式模型验证经过 ACU，费用 USD 0.00057。不存在“因为 5.6 不可用而大量自动调用 5.5”的证据；主要费用来自显式协议 Preflight。
- `claude-sonnet-5`：Messages 原生 Preflight 费用较高；另有早期真实 `acu-auto` 成功调用 USD 0.0234315。最终六候选矩阵中未被选择，原因是 Pareto/Value 支配。
- `claude-sonnet-4-6`：本 RC1 最终候选池未包含，也没有本窗口可归因的 ACU Attempt；若 Provider Dashboard 有费用，需要外部账单逐笔核对。
- `claude-opus-4-8`：Messages Frontier；Preflight 成功且有 signed thinking block。矩阵后期实际选中 5 次，但均因余额不足失败。

## 4. 七个必须回答的问题

1. `acu-auto` 与显式 Preflight：ACU 数据库内除一条 GPT-5.5 外均为 `acu-auto`；11 模型原生 Preflight 是直连 CloseAI 的显式调用，不在 ACU/New API 账本。
2. 双层 Retry：未发现。New API Retry=0；每个 Logical Request 恰好一个 ACU Attempt。
3. 重复 Judge：落库记录未发现同一 `judge_idempotency_key` 的第二笔费用；独立同输入验证第二次为 `cache_hit/cost=0`。
4. 并发 Agent：真实矩阵 Harness 配置并发为 1；没有启动并发原生 Agent。Preflight 也是串行。
5. 长历史/输出异常：Judge 输入共 405,544 Token/70 次，平均约 5,793，受 6,000 Token Judge 上限约束。原生客户端会重发历史；未观察到无上限输出，但 Messages 某些失败 Attempt 输入超过 20k，且 Context Preflight 有意使用 32k/65k 探针。
6. 三方一致性：150 个成功 Attempt 的 Provider Usage 可解析，成功 Attempt 的 `actual_cost_usd` 与 Usage Report Provider Cost 一致；New API 已确认的最终费用等于 Provider+Judge。取消 Attempt 不一致风险未解决。
7. GPT-5.5 原因：主要是显式原生 Preflight以证明其保留价值，而非自动路由大量选择。5.6 已通过 Tool/Thinking/Usage/Context 后进入候选池。

## 5. 已实施控制与 Stop-Ship 条件

- `tools/rc1-validation/live-test-budget.ts` 默认 `ACU_LIVE_TEST_ENABLED=false`，并在调用前检查单轮预算、累计预算、并发、输出上限和超阈值人工批准。
- Budget State 保存于仓库外；崩溃后 Reservation 保留，默认阻止继续调用。
- Provider Preflight 和原生客户端矩阵已接入预算闸门；默认并发为 1。
- 非法 JSON、429/5xx 和状态机错误应继续使用 Mock/Fixture。

解除 Stop-Ship 前必须：

1. 用 Provider Dashboard/账单 API 对账 28 个 cancelled Attempt；
2. 清理并解释 1 个 pending Logical Request；
3. 补充可稳定持久化的 `test_run_id` 与 purpose；
4. Provider 测试账户恢复受限余额后，仅执行预算批准的最小 Smoke；
5. 验证取消后 Provider 账单能写入 `failed_billed_cost_usd`。
