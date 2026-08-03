import { ACU_DEFAULT_QUALITY_TARGET, ACU_DEFAULT_SWITCH_COST_USD } from "./config.js";
import { getAcuCatalog, getRoutingEligibleModels, interpolateModelCurve } from "./catalog.js";
import { applyLogitShift, clamp, normalizeProbabilities, normalizedEntropy } from "./math.js";
import { enabledExecutionPresets, type AcuExecutionPreset } from "./execution-presets.js";
import type {
  AcuModelCatalogEntry,
  AcuModelEstimate,
  AcuRecommendation,
  AcuTierProbabilities,
} from "./types.js";

export type AcuDecisionInput = {
  probabilities: AcuTierProbabilities;
  difficultyScore: number;
  inputTokens: number;
  expectedOutputTokens: number;
  judgeCost: number;
  qualityTarget?: number;
  eligibleModelIds?: string[];
  requireToolCallSupport?: boolean;
  requireVisionSupport?: boolean;
  switchCost?: number;
  judgeEntropyPenalty?: number;
  costSensitivity?: number;
  fallbackRiskScale?: number;
  /** Per-model effective prices used by v0.3. Units may be USD or CNY, but
   * every override and judge/switch cost in one decision must use one unit. */
  effectivePrices?: Record<string, {
    inputPricePerMillion: number;
    outputPricePerMillion: number;
  }>;
  includeExecutionPresets?: boolean;
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
  difficultyScore: number,
  entropyPenalty: number,
  inputTokens: number,
  outputTokens: number,
  judgeCost: number,
  fallbackCallCost: number,
  qualityTarget: number,
  switchCost: number,
  fallbackRiskScale: number,
  effectivePrice?: { inputPricePerMillion: number; outputPricePerMillion: number },
  preset?: AcuExecutionPreset,
): AcuModelEstimate {
  const curvePoint = interpolateModelCurve(model, difficultyScore);
  const quality = preset
    ? applyLogitShift(curvePoint.estimatedQuality, preset.qualityLogitShift)
    : curvePoint.estimatedQuality;
  const lower = clamp(quality - model.uncertaintyWidth - entropyPenalty / 100);
  const upper = clamp(quality + model.uncertaintyWidth);
  const expectedOutputTokens = Math.round(outputTokens * (preset?.expectedOutputTokenMultiplier ?? 1));
  const callCost = estimateCallCost(effectivePrice ?? model, inputTokens, expectedOutputTokens);
  const expectedFallbackCost = fallbackRiskScale * (1 - lower) * (fallbackCallCost + switchCost);
  const selectionCost = callCost + expectedFallbackCost;
  const expectedEndToEndCost = judgeCost + selectionCost;
  return {
    candidateId: preset?.candidateId ?? model.modelId,
    modelId: model.modelId,
    executionPresetId: preset?.presetId,
    reasoningEffort: preset?.canonicalReasoningEffort,
    expectedOutputTokenMultiplier: preset?.expectedOutputTokenMultiplier,
    displayName: preset?.displayName ?? model.displayName,
    provider: model.provider,
    estimatedQuality: quality,
    conservativeQuality: lower,
    qualityLower: lower,
    qualityUpper: upper,
    estimatedCallCost: callCost,
    expectedFallbackCost,
    selectionCost,
    judgeOverheadCost: judgeCost,
    expectedEndToEndCost,
    expectedTotalCost: expectedEndToEndCost,
    predictedScore: quality * 100,
    conservativeScore: lower * 100,
    riskAdjustedCost: selectionCost,
    riskAdjustedScore: quality * 100,
    qualityUtility: 0,
    costUtility: 0,
    valueUtility: 0,
    scoreGapVsBest: 0,
    costSavingsVsBest: 0,
    paretoEfficient: false,
    selectionReason: "",
    savingsVsFlagship: 0,
    savingsPercentVsFlagship: 0,
    meetsQualityTarget: quality >= qualityTarget,
  };
}

type ValueCandidate = Pick<
  AcuModelEstimate,
  "modelId" | "displayName" | "predictedScore" | "riskAdjustedCost"
> & { candidateId?: string; conservativeScore?: number };

function candidateIdentity(candidate: ValueCandidate): string {
  return candidate.candidateId ?? candidate.modelId;
}

export function isParetoEfficient(candidate: ValueCandidate, candidates: ValueCandidate[]): boolean {
  return !candidates.some((other) => candidateIdentity(other) !== candidateIdentity(candidate)
    && other.predictedScore >= candidate.predictedScore
    && other.riskAdjustedCost <= candidate.riskAdjustedCost
    && (other.predictedScore > candidate.predictedScore
      || other.riskAdjustedCost < candidate.riskAdjustedCost));
}

export function selectValueRoute<T extends ValueCandidate>(
  candidates: T[],
  targetScore: number,
  costSensitivity = 1,
): {
  selected: T;
  bestScore: T;
  reason: string;
  utilities: Map<string, { riskAdjustedScore: number; qualityUtility: number; costUtility: number; valueUtility: number }>;
} {
  if (candidates.length === 0) throw new Error("Value routing requires at least one candidate");
  const bestScore = candidates.reduce((best, item) => (
    item.predictedScore > best.predictedScore ? item : best
  ));
  const frontier = candidates.filter((candidate) => isParetoEfficient(candidate, candidates));
  const preference = clamp((targetScore - 60) / 35);
  const qualityWeight = 0.58 + 0.24 * preference;
  const costWeight = clamp((1 - qualityWeight) * Math.max(0, costSensitivity), 0, 0.9);
  const riskWeight = 0.20 + 0.25 * preference;
  const qualityExponent = 0.8 + 1.2 * preference;
  const finiteCosts = frontier.map((candidate) => Math.max(1e-9, candidate.riskAdjustedCost));
  const minCost = Math.min(...finiteCosts);
  const maxCost = Math.max(...finiteCosts);
  const logRange = Math.log(maxCost / minCost);
  const utilities = new Map<string, {
    riskAdjustedScore: number;
    qualityUtility: number;
    costUtility: number;
    valueUtility: number;
  }>();
  for (const candidate of frontier) {
    const conservative = candidate.conservativeScore ?? candidate.predictedScore;
    const riskAdjustedScore = candidate.predictedScore
      - riskWeight * Math.max(0, candidate.predictedScore - conservative);
    const qualityUtility = Math.pow(Math.max(0, riskAdjustedScore) / Math.max(1, targetScore), qualityExponent);
    const costUtility = logRange <= 1e-12
      ? 1
      : 1 - Math.log(Math.max(1e-9, candidate.riskAdjustedCost) / minCost) / logRange;
    const valueUtility = qualityUtility * ((1 - costWeight) + costWeight * costUtility);
    utilities.set(candidateIdentity(candidate), { riskAdjustedScore, qualityUtility, costUtility, valueUtility });
  }
  const selected = frontier.reduce((best, item) => (
    utilities.get(candidateIdentity(item))!.valueUtility > utilities.get(candidateIdentity(best))!.valueUtility ? item : best
  ));
  const saving = bestScore.riskAdjustedCost > 0
    ? (1 - selected.riskAdjustedCost / bestScore.riskAdjustedCost) * 100
    : 0;
  return {
    selected,
    bestScore,
    utilities,
    reason: candidateIdentity(selected) === candidateIdentity(bestScore)
      ? `综合风险调整得分、您的质量偏好与对数成本效用后，${selected.displayName}的质量效用优势足以抵消成本。`
      : `综合风险调整得分、您的质量偏好与对数成本效用后，${selected.displayName}价值效用最高；相对最高得分模型预计综合成本${saving >= 0 ? "降低" : "增加"}${Math.abs(saving).toFixed(0)}%。`,
  };
}

export function recommendModel(input: AcuDecisionInput): AcuRecommendation {
  const probabilities = normalizeProbabilities(input.probabilities);
  const entropy = normalizedEntropy(probabilities);
  const entropyPenalty = entropy * Math.max(0, input.judgeEntropyPenalty ?? 0);
  const difficulty = Math.max(0, Math.min(100, input.difficultyScore));
  const qualityTarget = clamp(input.qualityTarget ?? ACU_DEFAULT_QUALITY_TARGET);
  const inputTokens = Math.max(1, Math.round(input.inputTokens));
  const outputTokens = Math.max(1, Math.round(input.expectedOutputTokens));
  const switchCost = Math.max(0, input.switchCost ?? ACU_DEFAULT_SWITCH_COST_USD);
  const costSensitivity = Math.max(0, input.costSensitivity ?? 1);
  const fallbackRiskScale = Math.max(0, input.fallbackRiskScale ?? 1);
  let models = getRoutingEligibleModels(input.eligibleModelIds);
  if (input.eligibleModelIds === undefined) {
    if (input.requireToolCallSupport) models = models.filter((model) => model.toolCallSupport);
    if (input.requireVisionSupport) models = models.filter((model) => model.visionSupport);
  }
  if (models.length === 0) throw new Error("No ACU catalog model is eligible for this request");

  const flagship = models.reduce((best, model) => (
    model.abilityAnchor > best.abilityAnchor ? model : best
  ));
  const fallback = flagship;
  const fallbackCallCost = estimateCallCost(input.effectivePrices?.[fallback.modelId] ?? fallback, inputTokens, outputTokens);
  const baseEstimates = models.map((model) => estimateOne(
    model,
    difficulty,
    entropyPenalty,
    inputTokens,
    outputTokens,
    Math.max(0, input.judgeCost),
    fallbackCallCost,
    qualityTarget,
    switchCost,
    fallbackRiskScale,
    input.effectivePrices?.[model.modelId],
  ));
  const presetEstimates = input.includeExecutionPresets === false ? [] : enabledExecutionPresets().flatMap((preset) => {
    const model = models.find((candidate) => candidate.modelId === preset.modelId);
    return model ? [estimateOne(
      model, difficulty, entropyPenalty, inputTokens, outputTokens, Math.max(0, input.judgeCost),
      fallbackCallCost, qualityTarget, switchCost, fallbackRiskScale, input.effectivePrices?.[model.modelId], preset,
    )] : [];
  });
  const estimates = [...baseEstimates, ...presetEstimates];
  const flagshipEstimate = baseEstimates.find((estimate) => estimate.modelId === flagship.modelId);
  if (!flagshipEstimate) throw new Error("ACU flagship model estimate is missing");
  for (const estimate of estimates) {
    estimate.savingsVsFlagship = flagshipEstimate.selectionCost - estimate.selectionCost;
    estimate.savingsPercentVsFlagship = flagshipEstimate.selectionCost > 0
      ? estimate.savingsVsFlagship / flagshipEstimate.selectionCost
      : 0;
  }
  const route = selectValueRoute(estimates, qualityTarget * 100, costSensitivity);
  const recommended = route.selected;
  for (const estimate of estimates) {
    const utility = route.utilities.get(estimate.candidateId);
    estimate.paretoEfficient = isParetoEfficient(estimate, estimates);
    estimate.riskAdjustedScore = utility?.riskAdjustedScore ?? estimate.conservativeScore;
    estimate.qualityUtility = utility?.qualityUtility ?? 0;
    estimate.costUtility = utility?.costUtility ?? 0;
    estimate.valueUtility = utility?.valueUtility ?? 0;
    estimate.scoreGapVsBest = route.bestScore.predictedScore - estimate.predictedScore;
    estimate.costSavingsVsBest = route.bestScore.riskAdjustedCost - estimate.riskAdjustedCost;
    estimate.selectionReason = estimate.candidateId === recommended.candidateId
      ? route.reason
      : estimate.paretoEfficient ? "位于当前成本—得分有效前沿。" : "存在得分更高且预计综合成本更低的候选。";
  }
  const valuePool = estimates.filter((estimate) => estimate.candidateId !== recommended.candidateId && estimate.paretoEfficient);
  const valueAlternative = valuePool.length > 0
    ? valuePool.reduce((best, estimate) => (
      estimate.riskAdjustedCost < best.riskAdjustedCost ? estimate : best
    ))
    : null;
  const flagshipAlternative = flagshipEstimate;
  return {
    recommended,
    valueAlternative,
    flagshipAlternative,
    fallbackModel: flagshipAlternative,
    estimates: estimates.sort((left, right) => left.riskAdjustedCost - right.riskAdjustedCost),
    reason: route.reason,
  };
}

export function judgeModelPrice(): AcuModelCatalogEntry {
  const modelId = getAcuCatalog().config.judge.model;
  const model = getAcuCatalog().models.find((entry) => entry.modelId === modelId);
  if (!model) throw new Error(`Judge model ${modelId} is absent from the ACU catalog`);
  return model;
}
