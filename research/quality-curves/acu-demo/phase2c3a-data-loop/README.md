# Phase 2C / 3A：真实 Judge、统一坐标与数据闭环

本阶段冻结 Phase 2B 的 `acu-routing-model-v0.1` 曲线、Curve Profile 和公开 Benchmark 能力锚点，只修正请求真实性、评分坐标、页面集成与结果数据闭环。

## 真实性链路

- Prompt 升级为 `acu-tier-requirement-v2`；v2 使用独立缓存文件与 schema，旧 v1 文件保留审计但不会命中。
- Judge 直接返回 0—100 连续 `difficulty_score` 和四档软概率。
- 完整未截断上下文的 SHA-256 用于缓存键；Judge 输入再按 6000 近似 token 做确定性 head-tail 截断。
- 序列化覆盖 role、name、content、结构化 content、assistant tool calls、tool call id、function name/arguments、tool result、error/metadata 和 tools 定义；对象键稳定排序，图片只保留 `[IMAGE]`。
- `judgeStatus`、来源、Provider、Endpoint host、模型、请求 ID、usage、缓存时间和两个 Hash 均随响应返回。密钥和完整 Endpoint 凭据不进入输出。
- `ACU_ALLOW_MOCK` 默认 false；非 test 环境注入 provider 会启动失败。失败只能标记为 `rules_fallback` 并附带错误类别，不能伪装成实时结果。

## 统一分数

模型预计得分统一为冻结的 101 点曲线在 Judge 连续难度位置的线性插值。后端推荐分数、图上圆点、标签和曲线交点使用同一个数值。四档概率只用于归一化熵；熵与模型不确定性构成温和风险扣分，不再直接生成模型分数。

## 数据库与 Shadow

Dev 使用 `/var/lib/clawrouter-dev/acu-routing.db`，WAL 模式。数据库只保存 Hash、Judge/路由/成本/结果元数据和候选得分，不保存完整 Prompt、messages、tool result、身份信息或密钥。`ACU_SHADOW_MODE=true` 时原 RulesStrategy 模型正常执行，ACU 只记录建议；只有显式 `acu_execute_recommended=true` 才执行建议模型。

四张表及字段见 `sqlite_schema.sql`。真实 A/B/C/D 结果见 `authenticity_validation.json`；Shadow 与显式执行结果见 `shadow_validation.json`。这些验证输入均为新构造的短文本或脱敏工具状态，不是 Twin few-shot 原样案例。

最终 Dev 运行时 Mock 扫描见 `runtime_mock_audit.json`，统计接口的脱敏快照见 `data_summary_example.json`，整合页面截图见 `integrated_dev_page.png`。

P0 主页面接线修复后的四个公网案例、质量偏好切换、Network URL 和 SQLite 增量见 `p0_e2e_validation.json`；最终主页面截图见 `p0_integrated_dev_page.png`。Dev 使用 `ACU_SHADOW_MODE=false`，生产配置未修改。

## 数据质量边界

`routing_requests` 的粒度是一行一次评估/路由请求；`model_candidate_scores` 是请求×候选模型；反馈和自动弱标签各自保留来源，不能混作同置信度标签。`GET /acu/api/data-summary` 在少于 20 个请求时固定返回“小样本仅用于产品验证”提示。当前真实样本仍不足以重新拟合曲线。

## 运行验证

```bash
PROXY_API_KEY=... node research/quality-curves/acu-demo/phase2c3a-data-loop/scripts/run-authenticity-check.mjs
```

脚本不打印或保存密钥，也不保存完整请求正文，只输出脱敏的 Hash、状态、usage、连续难度和推荐摘要。

验收时 `typecheck`、构建、73 个非外部测试与 `git diff --check` 通过。全仓 `npm run lint` 在冻结基线和本提交均报告同样的 46 个历史错误；本阶段新增 `src/acu/*.ts` 单独执行 ESLint 为 0 错误，因此没有扩大既有 lint 债务。
