# 连续价值路由 V2

V2 不再把用户偏好解释为硬门槛，也不使用“最高分几分以内”的窗口。

## 1. Pareto 过滤

如果另一个模型的 predicted score 不低且 risk-adjusted cost 不高，并且至少一项严格更优，则候选被严格支配。只对有效前沿计算价值效用。

## 2. 风险调整得分

```text
preference = clamp((preferenceScore - 60) / 35, 0, 1)
riskWeight = 0.20 + 0.25 * preference
riskAdjustedScore = predictedScore
                  - riskWeight * (predictedScore - conservativeScore)
```

用户偏好越高，模型曲线不确定性对选择的惩罚越大。

## 3. 质量与成本效用

```text
qualityWeight  = 0.58 + 0.24 * preference
qualityExponent = 0.80 + 1.20 * preference
qualityUtility = (riskAdjustedScore / preferenceScore) ^ qualityExponent

costUtility = 1 - log(cost / minFrontierCost)
                  / log(maxFrontierCost / minFrontierCost)

valueUtility = qualityUtility
             * (qualityWeight + (1 - qualityWeight) * costUtility)
```

对数成本效用使从 US$0.05 降到 US$0.01 的比例收益得到体现，而不会被绝对差额淹没。乘法组合保证“几乎没有任务匹配能力”不能仅凭低价获胜。所有参数随用户偏好连续变化，不存在推荐跳变的人为分差边界。

## 4. 解释字段

每个候选返回 `riskAdjustedScore`、`qualityUtility`、`costUtility`、`valueUtility`、`paretoEfficient`、`scoreGapVsBest` 和 `costSavingsVsBest`。前端主文案只解释连续效用选择，Fallback 细节仍保留在技术折叠区。
