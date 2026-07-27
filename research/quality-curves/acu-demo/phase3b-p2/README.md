# Phase 3B P2 — 投资人演示页面收口

本阶段只调整质量上界定义、投资人页面信息架构、曲线交互、反馈入口和展示术语。未修改 Judge 难度算法、模型基础能力锚点、Curve Profile、Validator、健康算法或 ACU 价值函数。

## 实现结果

- 新增一次性 `/acu/api/plan`：一次任务评估同时确定 ACU 推荐、当前任务质量上界和可展示备选；规划不写路由数据库，随后 `acu_plan_id` 由真实 Router 请求消费，避免重复 Judge 调用。
- 质量上界只在本次兼容、可调用、健康且有曲线的模型中选择预计得分最高者；显示分数相同时依次比较保守分、健康、P50 延迟、证据可信度，成本不参与选择。
- 主页面删除固定 Claude baseline、内部数据闭环统计、公开 trace/ledger/catalog 和重复反馈；保留一个 SQLite 反馈入口。
- 曲线支持精选/全部备选、局部自动缩放、全局视图、滚轮/按钮缩放、拖拽/触摸平移、双击恢复、Hover 高亮、列表定位及最多三个普通模型锁定。
- 全部模式只展示本次兼容、可调用、未冷却且具有曲线和统一预计成本口径的模型。分数和预计综合成本使用同字号、同字重双列展示。
- 按最新产品要求恢复主页面 04 `Routing Trace` 与 05 `Cost & Quality Ledger`；它们读取本次真实 Trace、实际成本与质量上界成本。
- 精选模式稳定补足6个模型，右侧默认按预计得分降序；质量上界与实际/推荐模型使用不同颜色和边框。
- 投资人主页面不显示“样本不足”或证据等级。没有真实滚动P50时使用 Curve Profile 对应的展示延迟先验；一旦有真实运行数据即由健康层P50覆盖。

## Judge v3 连续难度指数补丁

- Prompt：`acu-tier-requirement-v3`
- 方法：`acu-difficulty-index-v1`
- Judge 输出原始总分、六个0—10因子和四档概率；后端按固定权重确定性计算 `factorComposite` 与 `difficultyIndex`。
- `difficultyIndex` 统一用于路由、曲线插值、当前交点、标签和自动缩放；raw只进入技术详情与审计字段。
- v2缓存原样保留，v3使用独立缓存文件。旧数据库记录的新字段保持NULL，不将旧分数冒充v3指数。

12条真实输入结果见 [difficulty_v3_acceptance.json](difficulty_v3_acceptance.json)：12/12 live，12个指数均不同，11个为非整数，只有1个为5的倍数；公式复算差异为0。首条输入重复评估命中缓存，raw、六因子、四档概率和最终指数完全一致。

## 实际成本反转审计

请求 `700bc893-db16-4258-8bbb-04e94167c361` 中，事前统一600输出token预算下，Claude Opus 4.8预计调用成本为US$0.015885，低于GPT-5.6 Sol的US$0.018885，因此结合0.7分的预计差距后由价值函数选择Opus。实际执行时，Opus产生287个completion tokens，模型成本US$0.008270，再加Judge US$0.000384，总计US$0.008654；质量上界Sol的实际回答约135个输出token，成本US$0.00515。实际成本增加来自两次生成长度不同及ACU侧Judge成本，而不是价格表倒置。后续应以按模型/任务类型校准的输出长度先验降低这种事前—事后偏差，本阶段未改价值函数。

## 公网验收（2026-07-27）

| 案例 | 难度 | 任务评估 | 质量上界 | ACU 推荐 / 实际 | 实际成本对比 |
|---|---:|---|---|---|---|
| avg([]) 代码修复 | 25.0 | cache_hit | GPT-5.6 Luna，95.3分 | Qwen 3.6 Plus，82.7分 / Qwen | US$0.00183 → US$0.00053 |
| Low JSON 抽取 | 15.0 | live | GPT-5.6 Luna，98.3分 | Qwen 3.6 Plus，89.0分 / Qwen | US$0.00067 → US$0.00051 |
| High 复杂推理 | 88.5 | live | GPT-5.6 Sol，44.9分 | Claude Opus 4.8，43.7分 / Opus | US$0.03680 → US$0.03155 |

完整脱敏结果见 [acceptance_results.json](acceptance_results.json)。每例网络序列均为一次 catalog 读取、一次 plan 和两次真实模型调用（质量上界与 ACU）；规划结果由 Router 复用。avg 案例的展示交互额外 API 请求为 0。

交互专项记录见 [acceptance_interaction_avg-code-fix.json](acceptance_interaction_avg-code-fix.json)：滚轮缩放、拖拽平移和双击恢复分别改变显示域，且没有产生任何额外 API 请求。

SQLite 反馈验证：请求 `a197ed8e-e594-41f6-9632-7c86deda6b2e` 的 `user_feedback` 由 0 增至 1，保存 `accepted=1`、`required_upgrade=0`、`final_model=qwen3.6-plus`。

## 截图

- [精选模型](screenshots/avg-featured.png)
- [全部备选与当前任务局部放大](screenshots/avg-all-local.png)
- [全部备选全局视图](screenshots/avg-all-global.png)
- [移动端](screenshots/avg-mobile.png)

## 运行验收脚本

脚本只从环境变量读取 Basic Auth 密码，不保存凭据：

```bash
PROXY_API_KEY=... node scripts/run_public_acceptance.mjs
```

固定地址为 `https://eu.jerrypsy.top/acu-router-dev/`，可用 `ACU_ACCEPTANCE_URL` 覆盖。
