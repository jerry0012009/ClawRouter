# Phase 2A: Twin tier capability model and ACU routing demo

本目录记录 ACU 产品 Demo 的可复现数据连接。它不运行 RouteLLM、P2L、LLM Judge 批量实验、动态 SWE-bench 或任何具体模型逐题任务。

## 结果摘要

- TwinRouterBench 输入：Phase 1D 冻结 Parquet，SHA-256 `287ae2e5087bbd731c1513a81a94ccf936ad356c25ca3a78f652dcb91129b6e4`。
- 发布标签：970 条；low 689（71.03%）、mid 62（6.39%）、mid-high 49（5.05%）、high 170（17.53%）。
- 固定 Judge：`deepseek-v4-flash`、`https://api.deepseek.com`、non-thinking、prompt `acu-tier-requirement-v1`、6000 输入 token 上限、300 输出 token 上限、8 秒超时。
- 固定 few-shot：每档 2 条，共 8 条。选择只使用当时 router-visible 上下文；清单保存源哈希；prompt 不含 benchmark 名称、标签字段名、未来消息或模型品牌。
- 能力目录：13 个证据条目，其中 12 个与仓库真实模型 ID 对应且可路由。MiniMax M3 因没有仓库可调用文本 ID，只作证据展示。
- 曲线：每个模型 101 点，所有曲线随难度单调下降，概率合法且和为 1。

## 数据与版本

模型锚点来自此前正式审计的官方 OpenHands Index：

- dataset：`OpenHands/openhands-index`
- tag：`v2026.06.30-3015ac6`
- resolved revision：`94ac78ad8ec547875a0a4ec56e15a644aa5653f6`
- results repository commit：`3015ac612e7196f428e6e8a3948965d32d9a3331`
- benchmark：SWE-bench aggregate resolved rate，500 instances / model

模型价格、上下文长度、tool/vision 能力与 availability 来自生成时的 `src/models.ts`，其 SHA-256 写入运行时目录 provenance。没有联网刷新价格。

## 方法

档位中心集中配置为 low 0.15、mid 0.40、mid-high 0.65、high 0.88。对于能力参数 `a`：

```text
sufficient(model,tier) = 0.03 + 0.96 × sigmoid((a - tierDifficulty[tier]) / 0.12)
```

通过一维二分法求解 `a`，使 Twin 发布标签自然分布加权后的充分率尽量等于公开能力锚点。拟合误差均接近浮点精度零。连续图形使用三个有序 Logistic 阈值生成四档概率；真实请求则直接使用 Judge 的完整四档概率，不从展示难度反推。

成本引擎用保守质量下界筛选达到用户目标的模型，再选择含 Judge、首次调用、Fallback 与切换成本的预计总成本最低者；无人达标时选择 estimated quality 最高者。

## Judge 与隐私

Prompt 见 [judge_prompt_v1.md](judge_prompt_v1.md)，样本来源与哈希见 [twin_few_shot_manifest.json](twin_few_shot_manifest.json)。Judge 不回答原任务、不推荐模型、不输出代码；JSON 解析器校验概率、置信度、signals 数量和 explanation 长度。缓存键由 prompt 版本、模型和完整上下文 SHA-256 组成，缓存文件不保存请求原文或密钥。

当前环境没有官方 DeepSeek Judge key，因此 `representative_decisions.csv` 的概率是清楚标注的 deterministic interface fixtures，不是线上模型结果。测试用本地 mock 验证请求确实是 non-thinking、JSON-only、最多 300 tokens，并覆盖缓存复用和无效响应回退。

## 文件

- `tier_distribution.json`：Twin 四档数量、权重和来源哈希。
- `model_catalog_evidence.csv`：锚点、直接/相对证据、来源和置信度。
- `model_tier_sufficiency.csv`：求解参数、拟合误差和四档充分率。
- `fitted_model_curves.csv`：13 × 101 个连续曲线点。
- `representative_decisions.csv`：四个确定性接口场景的计算链条。
- `screenshots/acu-demo.png`：本地 UI 截图；若 Judge 未配置，页面明确显示 Rules fallback。
- `public/acu-curves/*.png`：由冻结曲线 CSV 生成的代表模型、性价比模型和厂商分面图集。

## 复现与验证

```bash
research/quality-curves/twinrouterbench/phase1d-foundation/.cache/venv/bin/python \
  scripts/build-acu-model-catalog.py
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
```

生成器不修改 Phase 1D 或 OpenHands 研究目录。估算边界与证据限制详见 [assumptions.md](assumptions.md)。
