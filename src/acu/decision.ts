import { ACU_DEFAULT_QUALITY_TARGET, ACU_DEFAULT_SWITCH_COST_USD } from "./config.js";
import { getAcuCatalog, getRoutingEligibleModels } from "./catalog.js";
import { clamp, estimatedQuality, normalizeProbabilities } from "./math.js";
import type {
  AcuModelCatalogEntry,
  AcuModelEstimate,
  AcuRecommendation,
  AcuTierProbabilities,
} from "./types.js";

export type AcuDecisionInput = {
  probabilities: AcuTierProbabilities;
  inputTokens: number;
  expectedOutputTokens: number;
  judgeCost: number;
  qualityTarget?: number;
  eligibleModelIds?: string[];
  requireToolCallSupport?: boolean;
  requireVisionSupport?: boolean;
  switchCost?: number;
};

export function estimateCallCost(
  model: Pick<AcuModelCatalogEntry, "inputPricePerMillion" | "outputPricePerMillion">,
  inputTokens: number,
  outputTokens: number,
): number {
  if (model.inputPricePerMillion === null || model.outputPricePerMillion === null) {
    return Number.POSITIVE_INFINITY;
  }
  return (
    Math.max(0, inputTokens) * model.inputPricePerMillion
    + Math.max(0, outputTokens) * model.outputPricePerMillion
  ) / 1_000_000;
}

function estimateOne(
  model: AcuModelCatalogEntry,
  probabilities: AcuTierProbabilities,
  inputTokens: number,
  outputTokens: number,
  judgeCost: number,
  fallbackCallCost: number,
  qualityTarget: number,
  switchCost: number,
): AcuModelEstimate {
  const quality = estimatedQuality(probabilities, model);
  const lower = clamp(quality - model.uncertaintyWidth);
  const upper = clamp(quality + model.uncertaintyWidth);
  const callCost = estimateCallCost(model, inputTokens, outputTokens);
  const expectedFallbackCost = (1 - lower) * (fallbackCallCost + switchCost);
  const total = judgeCost + callCost + expectedFallbackCost;
  return {
    modelId: model.modelId,
    displayName: model.displayName,
    provider: model.provider,
    estimatedQuality: quality,
    conservativeQuality: lower,
    qualityLower: lower,
    qualityUpper: upper,
    estimatedCallCost: callCost,
    expectedFallbackCost,
    expectedTotalCost: total,
    savingsVsFlagship: 0,
    savingsPercentVsFlagship: 0,
    meetsQualityTarget: lower >= qualityTarget,
  };
}

export function recommendModel(input: AcuDecisionInput): AcuRecommendation {
  const probabilities = normalizeProbabilities(input.probabilities);
  const qualityTarget = clamp(input.qualityTarget ?? ACU_DEFAULT_QUALITY_TARGET);
  const inputTokens = Math.max(1, Math.round(input.inputTokens));
  const outputTokens = Math.max(1, Math.round(input.expectedOutputTokens));
  const switchCost = Math.max(0, input.switchCost ?? ACU_DEFAULT_SWITCH_COST_USD);
  let models = getRoutingEligibleModels(input.eligibleModelIds);
  if (input.requireToolCallSupport) models = models.filter((model) => model.toolCallSupport);
  if (input.requireVisionSupport) models = models.filter((model) => model.visionSupport);
  if (models.length === 0) throw new Error("No ACU catalog model is eligible for this request");

  const flagship = models.reduce((best, model) => (
    model.abilityAnchor > best.abilityAnchor ? model : best
  ));
  const fallback = flagship;
  const fallbackCallCost = estimateCallCost(fallback, inputTokens, outputTokens);
  const estimates = models.map((model) => estimateOne(
    model,
    probabilities,
    inputTokens,
    outputTokens,
    Math.max(0, input.judgeCost),
    fallbackCallCost,
    qualityTarget,
    switchCost,
  ));
  const flagshipEstimate = estimates.find((estimate) => estimate.modelId === flagship.modelId);
  if (!flagshipEstimate) throw new Error("ACU flagship model estimate is missing");
  for (const estimate of estimates) {
    estimate.savingsVsFlagship = flagshipEstimate.expectedTotalCost - estimate.expectedTotalCost;
    estimate.savingsPercentVsFlagship = flagshipEstimate.expectedTotalCost > 0
      ? estimate.savingsVsFlagship / flagshipEstimate.expectedTotalCost
      : 0;
  }
  const qualified = estimates.filter((estimate) => estimate.meetsQualityTarget);
  const recommended = qualified.length > 0
    ? qualified.reduce((best, estimate) => (
      estimate.expectedTotalCost < best.expectedTotalCost ? estimate : best
    ))
    : estimates.reduce((best, estimate) => (
      estimate.estimatedQuality > best.estimatedQuality ? estimate : best
    ));
  const valuePool = estimates.filter((estimate) => estimate.modelId !== recommended.modelId);
  const valueAlternative = valuePool.length > 0
    ? valuePool.reduce((best, estimate) => (
      estimate.expectedTotalCost < best.expectedTotalCost ? estimate : best
    ))
    : null;
  const flagshipAlternative = flagshipEstimate;
  return {
    recommended,
    valueAlternative,
    flagshipAlternative,
    fallbackModel: flagshipAlternative,
    estimates: estimates.sort((left, right) => left.expectedTotalCost - right.expectedTotalCost),
    reason: qualified.length > 0
      ? `保守估算达到 ${(qualityTarget * 100).toFixed(0)}% 目标的候选中，预计总成本最低。`
      : `没有候选的保守估算达到 ${(qualityTarget * 100).toFixed(0)}% 目标，选择估算达标率最高者。`,
  };
}

export function judgeModelPrice(): AcuModelCatalogEntry {
  const modelId = getAcuCatalog().config.judge.model;
  const model = getAcuCatalog().models.find((entry) => entry.modelId === modelId);
  if (!model) throw new Error(`Judge model ${modelId} is absent from the ACU catalog`);
  return model;
}
