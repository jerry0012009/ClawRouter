# Phase 2A assumptions

1. `target_tier` 表示完成下一次响应所需的最低充分能力档位，而非某个具体模型的逐题结果。
2. 主分布使用 TwinRouterBench Phase 1D 的全部 970 条 published labels：689 / 62 / 49 / 170。强弱标签差异保留在源审计中；本阶段不重新验证 970 条标签。
3. 模型能力锚点使用已经冻结并审计的 OpenHands Index SWE-bench 聚合 resolved 比例。它受 Agent harness、SDK、提示词和执行环境影响。
4. OpenHands 分数与 Twin 档位分布之间不是严格可交换统计量。通过加权均值求解能力参数只是一个可解释的产品 Demo 连接。
5. 所有模型共享 `temperature=0.12`、`floor=0.03`、`ceiling=0.99`，不按模型手调曲率。档位难度中心为 0.15、0.40、0.65、0.88。
6. 直接存在于审计表的模型证据置信度为 medium，区间半宽 0.08；同系列相对锚定为 low，区间半宽 0.14。没有把这些区间解释为频率学置信区间。
7. 价格与可用性来自本仓库 `src/models.ts` 的构建时快照，不保证代表任何外部供应商的实时价格。
8. Judge 的 token 成本使用接口返回 usage；无 usage 时使用本地保守 token 估算。期望 Fallback 成本使用 `(1-conservativeQuality) × (fallbackCallCost+switchCost)`。
9. `estimatedQuality`、区间与曲线统一称为公开 Benchmark 受约束估算，不称为实测成功率。
10. 当前运行环境未配置官方 DeepSeek API key；交付通过本地受控 HTTP mock 验证协议、缓存、成本和失败回退，没有伪造线上 Judge 结果。

