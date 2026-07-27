# Phase 2B：差异化曲线与价值路由

本目录是 Phase 2A 产品 Demo 的非实验性升级。没有重跑 RouteLLM、P2L、TwinRouterBench、OpenHands 或任何动态任务；构建器只读取冻结的 Phase 2A 表、仓库模型注册和明确记录的公开证据。

## 产品模型

TwinRouterBench 继续只提供 689/62/49/170 的 low/mid/mid-high/high 发布标签分布。模型的 ability anchor 继承 Phase 2A 已审计 OpenHands 锚点；新版本模型使用显式的系列相对映射，证据等级为 low。Profile 只确定曲线形状：

- `frontier_resilient`：高难度下降更慢。
- `balanced_frontier`：中高难度均衡。
- `efficient_fast`：低难度接近更强型号，中高难度下降更快。
- `coding_specialist`：对编码、工具和仓库任务的 mid/mid-high 区域作正向修正，不自动提高通用 high。

应用 Profile 后重新一维求解 ability parameter，使 Twin 自然分布下的加权平均与原 ability anchor 一致。单档修正不超过 0.08，temperature/floor/ceiling 严格限制在任务规定区间；最终四档值经单调投影。因此曲线接近或交叉来自预先记录的形状假设，而非改写总体锚点。

## 价值路由

默认偏好为 80 分。算法先删除得分更低且预计综合成本更高的严格被支配模型。对前沿候选，使用连续价值效用：`riskAdjustedScore = predictedScore - riskWeight × uncertaintyGap`；`qualityUtility = (riskAdjustedScore / preferenceScore) ^ exponent`；成本效用使用前沿内对数相对成本；`valueUtility = qualityUtility × (qualityWeight + costWeight × costUtility)`。乘法结构防止极低成本补偿近乎为零的匹配质量。偏好从 60 调到 95 时，质量权重从 0.58 平滑增加到 0.82，不确定性惩罚从 0.20 增加到 0.45，质量幂指数从 0.8 增加到 2.0。无固定分差、无硬过线。

Fallback 安全能力仍保留在后端风险成本中，前端只在“技术详情”折叠区展示。

## 文件

- `curve_profile_evidence.csv`：公开原始来源与能力维度；不将异质 Benchmark 伪装成同一口径。
- `curve_profile_parameters.csv`：Profile 前后 ability parameter、档位值、修正与拟合误差。
- `model_tier_sufficiency_v2.csv`：最终四档充分率。
- `fitted_model_curves_v2.csv`：18 个目录模型、每个 101 个难度点。
- `gpt56_preflight.json`：当前上游的最小可用性预检。
- `judge_endpoint_preflight.json`：CloseAI/OpenRouter 的 DeepSeek V4 Flash 严格 JSON 预检与 dev 端点选择；不包含密钥或端点密文。
- `current_state_audit.md`：Phase 2A 起始状态。
- `twin_preset_smoke_results.csv`：8 个 Twin 预置案例的真实 DeepSeek V4 Flash 产品烟雾结果，包含四档概率、延迟、API usage token、Judge 估算成本和推荐。这些案例同时是固定 few-shot 示例，因此只验证产品链路，不能当作泛化精度证据。
- `frontend_phase2b.png`：已部署 dev 页面在真实 Judge 缓存命中状态的全页截图。
- `value_routing_spec.md`：无硬门槛、无固定分差的连续质量—成本效用公式。
- `figures/`：拳头模型、价值前沿和全目录厂商分面图。

## 重建

```bash
research/quality-curves/.cache/venv/bin/python \
  scripts/build-acu-phase2b-catalog.py
```

脚本不读取密钥，不访问网络，不运行任何模型。它不修改 Phase 2A 研究目录。

## 边界

`estimatedScore` 是公开 Benchmark 锚点与受约束能力模型产生的相对任务匹配分，不是模型对当前请求的实测成功率。GPT-5.6、GLM 5.2 和 Kimi K2.7 Code 没有固定 OpenHands 版本中的直接逐模型锚点，其位置是低置信系列相对估算，不确定性区间更宽。GPT-5.6 路由价格使用官方列表价；当前代理未返回计费元数据，实际代理账单仍待核对。
