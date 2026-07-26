# Phase 1A：LiveBench 公开 Benchmark 数据审计

## 技术结论

公开数据**可以**提供可连接的“题目—任务类型—模型逐题得分”，连接键为
`question_id`，但 2025-04-07 官方快照并不完整到足以直接生成最终质量曲线：

- 官方六个题目数据集共有 1,436 道当前题目、6 个大类、18 个 task。
- `livebench/model_judgment` 有 60,372 条原始 judgment、195 个模型、494 个
  judgment 题号，但只覆盖 coding、language、instruction_following 三个大类和
  7 个 task。
- 494 个 judgment 题号中，394 个能连接到官方题目正文，题号连接率为
  79.76%；对应 53,470 条原始 judgment，行连接率为 88.57%。可连接记录的
  `category` 和 `task` 与题目数据完全一致。
- 100 个无法连接的题号均来自历史 language 题（`typos` 50、
  `plot_unscrambling` 50）。脚本扫描了官方 language 数据仓库中 9 个较早的
  test 快照，仍未找到这些题目正文，因此没有补写 prompt。
- 数据足以开展第一批共同题集锚点实验，但还不能宣称覆盖完整 LiveBench，
  也不应直接把混合 task 的原始 score 当作统一概率。

## 官方数据来源与固定版本

只使用 LiveBench 官方/原始发布来源：

| 来源 | 用途 | 固定 commit | 发布时刻 |
|---|---|---|---|
| [LiveBench/LiveBench](https://github.com/LiveBench/LiveBench) | 评分实现与 score 语义 | `a41783c06f646697a96cc2ae2275a6b5c2646cb4` | 2025-04-07 19:34:58 UTC |
| [livebench/model_judgment](https://huggingface.co/datasets/livebench/model_judgment) | 逐模型逐题 judgment | `9704e5da7bfbefe75ac1482a13de827127295993` | 2025-04-07 20:34:22 UTC |
| [livebench/reasoning](https://huggingface.co/datasets/livebench/reasoning) | reasoning 题目 | `6fc6498a5dfba553f69f4413feabade1f1a2d384` | 2025-04-07 20:34:13 UTC |
| [livebench/math](https://huggingface.co/datasets/livebench/math) | math 题目 | `bb66571c8ccf32d3df9e6f48b920d3770ff4aacb` | 2025-04-07 20:34:11 UTC |
| [livebench/coding](https://huggingface.co/datasets/livebench/coding) | coding 题目 | `a958549fdd8aa57be0a3fafe7b205ffc160ed5f4` | 2025-04-07 20:34:05 UTC |
| [livebench/language](https://huggingface.co/datasets/livebench/language) | language 题目 | `3ada32a2e53d5e04e57fa503384cb85ce9116c40` | 2025-04-07 20:33:47 UTC |
| [livebench/data_analysis](https://huggingface.co/datasets/livebench/data_analysis) | data analysis 题目 | `31b9661ff678df9958e2f7fa228427f4c858c1a1` | 2025-04-07 20:34:15 UTC |
| [livebench/instruction_following](https://huggingface.co/datasets/livebench/instruction_following) | instruction following 题目 | `0868379c4b5cf62aeacaf8be4f08fced815c81bb` | 2025-04-07 20:34:07 UTC |

完整来源清单、Parquet schema、LFS SHA-256 和大小记录在
`outputs/audit_summary.json`。脚本固定 commit，不会静默切换到最新数据。

## 字段与处理粒度

judgment 原始粒度按 `(model, question_id, turn, tstamp)` 观察；下游覆盖统计的
目标粒度为 `(model, question_id, turn)`。字段映射如下：

| 目标字段 | 官方字段/处理 |
|---|---|
| `question_id` | 题目与 judgment 的直接连接键 |
| `prompt` | 题目 `turns[turn - 1]`；本快照所有 judgment 均为 turn 1 |
| `category` | 题目与 judgment 原字段，连接后做一致性检查 |
| `task` | 题目与 judgment 原字段，连接后做一致性检查 |
| `model` | judgment 的 `model` |
| `score` | judgment 的 `score`，不填补、不重算 |
| `turn` | judgment 的 `turn` |
| 数据来源 | 输出中保留数据集名称、commit 和 judgment 时间戳 |

同一 `(model, question_id, turn)` 有多条 judgment 时，审计首先保留并报告全部
原始记录；为了生成单一覆盖统计，再确定性地使用最大 `tstamp` 的记录。这个
选择不是对冲突 score 的确认，后续训练前仍需决定是接受最新记录还是排除冲突。

## 当前覆盖

| 大类 | 当前官方题目 | judgment 题目 | 原始 judgment | 模型 | score 范围 | 成功/失败建议 |
|---|---:|---:|---:|---:|---|---|
| coding | 128 | 128 | 21,541 | 183 | 0–1 | 原生二元 |
| data_analysis | 150 | 0 | 0 | 0 | — | 无法评估 |
| instruction_following | 400 | 76 | 7,652 | 163 | 0–1 | 仅 `score == 1` 可作完全成功 |
| language | 190 | 290 | 31,179 | 173 | 0–1 | 混合二元/部分得分；仅 `score == 1` 可作完全成功 |
| math | 368 | 0 | 0 | 0 | — | 无法评估 |
| reasoning | 200 | 0 | 0 | 0 | — | 无法评估 |

task 级的 18 行完整矩阵见 `outputs/task_coverage.csv`。其中 11 个当前 task 没有
公开 judgment；`plot_unscrambling` 和 `typos` 的 judgment 题目数分别比当前
官方题目多 50，正是无法恢复正文的 100 个历史题。

## Score 语义与 pass/fail

所有已发布 score 均在 `[0, 1]`，但定义不一致：

- `LCB_generation`、`coding_completion`、`typos` 是二元分数。
- `connections` 是正确四词组的比例。
- `plot_unscrambling` 是 `1 - 归一化句序编辑距离`。
- `paraphrase`、`story_generation` 是“全部约束是否通过”与“逐约束通过比例”的
  均值。

因此，跨 task 稳妥的二元定义只有 **`pass = (score == 1.0)`**，表示完全正确或
完全满足约束。它会丢弃部分得分，不能把 `score > 0` 等价解释为 pass。若后续
质量曲线需要连续质量信号，应保留原始 score 并按 task 校准，不能直接混合。

本快照 60,372 条 judgment 的 `turn` 全为 1。当前按 `turn == 1` 过滤不会损失
数据，但建议显式保留过滤条件，避免未来多轮数据改变统计粒度。

## 数据质量发现

- 官方当前题目中没有重复 `question_id`，也没有缺失 prompt。
- judgment 必需字段（`question_id`、`task`、`model`、`score`、`turn`、
  `tstamp`、`category`）均无缺失；没有完全相同的重复行。
- 有 984 组重复 `(model, question_id, turn)`，共多出 984 条记录；其中 64 组的
  score 冲突，其余重复组 score 相同但 `tstamp` 不同。
- 100 个 judgment 题号没有官方可得 prompt，影响 6,902 条原始 judgment。
- 去重后有 59,388 条 judgment；其中 52,486 条能连接 prompt。
- `model_judgment` 的大类覆盖明显少于同期官方题目数据：缺 reasoning、math、
  data_analysis 的逐题得分。

## 第一批锚点模型

脚本没有主观硬编码模型名单。它先筛选可连接题目覆盖达到最高值 99% 且至少
覆盖两个大类的模型，再在候选平均分范围内设置五个等距能力目标，并优先选择
与已选模型题目重叠更高者。当前结果为：

1. `command-r-08-2024` — 394 题，平均分 0.2575，完全成功率 0.1980
2. `gemini-1.5-flash-001` — 394 题，平均分 0.3631，完全成功率 0.2868
3. `claude-3-opus-20240229` — 394 题，平均分 0.4760，完全成功率 0.3731
4. `chatgpt-4o-latest-2025-03-27` — 394 题，平均分 0.5965，完全成功率 0.4924
5. `o1-preview-2024-09-12` — 393 题，平均分 0.7032，完全成功率 0.6285

五个模型共同覆盖 393 道可连接题，覆盖 3 个大类和 7 个 task，形成明显能力
梯度。详细方法和逐模型理由见 `outputs/recommended_anchor_models.md`。

## 运行方法

在本目录执行：

```bash
python3 -m venv .cache/venv
.cache/venv/bin/pip install -r requirements.txt
.cache/venv/bin/python scripts/audit_livebench.py
```

首次运行会把官方仓库、Parquet 投影和 Python 虚拟环境写入 `.cache/`。该目录已
在仓库根 `.gitignore` 中忽略；大型原始文件不会进入 Git。coding Parquet 的
完整 LFS 对象约 245 MB，脚本通过官方 Hugging Face URL 做列投影读取，只缓存
审计需要的 `question_id/category/task/turns`，避免下载私有测试字段。

已完成一次联网运行后，可验证缓存复现：

```bash
.cache/venv/bin/python scripts/audit_livebench.py --offline
```

常用参数：

- `--cache-dir PATH`：修改 gitignored 数据缓存位置。
- `--output-dir PATH`：修改审计输出位置。
- `--offline`：禁止网络，只使用已有仓库、Parquet 或投影缓存。
- `--skip-history`：跳过缺失题目的官方数据仓库历史扫描。

脚本遇到缺依赖、仓库/commit 不可用、必需字段缺失或 Parquet 读取失败时会输出
明确错误并以非零状态退出，不会生成伪造或部分补写的数据。

## 输出文件

- `outputs/model_coverage.csv`：195 个模型的题目/大类/task 覆盖、各大类题数、
  平均分、完全成功率和缺失标记。
- `outputs/task_coverage.csv`：18 个当前 task 的题目、judgment、模型、分数范围、
  prompt 连接与二元化适用性。
- `outputs/question_model_overlap.csv`：18,915 对不同模型的题目交集、可连接交集、
  并集和 Jaccard。
- `outputs/sample_joined_rows.csv`：100 条成功连接的逻辑记录。prompt 内含换行，
  因而文本行数会大于 101，但标准 CSV 解析后恰为 100 条。
- `outputs/audit_summary.json`：机器可读来源、版本、计数、质量检查、score 语义、
  锚点和 RouteLLM 前置问题。
- `outputs/recommended_anchor_models.md`：可读的锚点推荐与选择方法。

## RouteLLM 前必须解决的问题

1. 决定排除还是另行从官方来源取得 100 个缺 prompt 的历史题；不得用第三方
   文本或合成 prompt 替代。
2. 对 64 组重复且 score 冲突的 judgment 制定规则；在确认前，建议敏感性分析
   “最新记录”与“全部排除”两种方案。
3. 明确目标是完全成功二元标签还是 task 内连续部分得分；两者应分别验证。
4. 按 task/大类分层和加权，避免题目数与评分定义差异主导综合均值。
5. 如果路由范围需要完整 LiveBench，必须取得 reasoning、math、data_analysis 的
   官方逐题 judgment；当前公开快照不能支持这三个大类的模型质量曲线。
6. 冻结数据版本、模型名规范化、turn 过滤、重复处理和训练/验证题目切分，防止
   后续数据更新引入泄漏或不可复现结果。

本阶段没有调用模型重新答题、付费模型 API 或 RouteLLM，也没有修改生产路由、
proxy、前端或 TypeScript 业务代码。
