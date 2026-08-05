export const ACU_TIERS = ["low", "mid", "mid_high", "high"] as const;

export type AcuTier = (typeof ACU_TIERS)[number];

export type AcuTierProbabilities = {
  pLow: number;
  pMid: number;
  pMidHigh: number;
  pHigh: number;
  confidence: number;
};

export type AcuDifficultyFactors = {
  reasoningDepth: number;
  taskScope: number;
  constraintDensity: number;
  toolDependency: number;
  verificationBurden: number;
  contextBurden: number;
};

export type AcuJudgeResult = AcuTierProbabilities & {
  difficultyScoreRaw: number;
  factors: AcuDifficultyFactors;
  factorComposite: number;
  difficultyIndex: number;
  difficultyMethodVersion: "acu-difficulty-index-v1";
  /** Compatibility alias; always identical to difficultyIndex for v3 results. */
  difficultyScore: number;
  signals: string[];
  explanation: string;
  explanationNormalized?: boolean;
  originalExplanationLength?: number;
  originalExplanationType?: "string" | "array" | "object" | "null" | "missing";
  webIntent?: "required" | "likely" | "not_required";
  webIntentConfidence?: number;
  webIntentReason?: string;
  webIntentEvidence?: string[];
};

export type AcuJudgeStatus = "live" | "cache_hit" | "rules_fallback" | "live_error";
export type AcuJudgeResultSource = "upstream_live" | "disk_cache" | "rules_strategy";

export type AcuBenchmarkEvidence = {
  benchmarkName: string;
  normalizedScore: number;
  scoreScale: string;
  sampleSize: number;
  sourceModelName: string;
  evaluationMode: string;
  sourceUrl: string;
  resultsUrl: string;
  sourceVersion: string;
  benchmarkDate: string;
  directForModel: boolean;
  configuredRelativeDelta: number;
};

export type AcuModelCatalogEntry = {
  modelId: string;
  displayName: string;
  provider: string;
  upstream: string;
  availability: string;
  routingEligible: boolean;
  defaultDisplay: boolean;
  abilityAnchor: number;
  solvedAbilityParameter: number;
  fittingError: number;
  sufficientLow: number;
  sufficientMid: number;
  sufficientMidHigh: number;
  sufficientHigh: number;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  cachedInputPricePerMillion: number | null;
  cacheWritePricePerMillion: number | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  toolCallSupport: boolean;
  visionSupport: boolean;
  benchmarkEvidence: AcuBenchmarkEvidence[];
  evidenceConfidence: "low" | "medium" | "high";
  uncertaintyWidth: number;
  curveMethod: string;
  curveProfile: "frontier_resilient" | "balanced_frontier" | "efficient_fast" | "coding_specialist";
  curveTemperature: number;
  curveFloor: number;
  curveCeiling: number;
  tierAdjustments: { low: number; mid: number; midHigh: number; high: number };
  profileEvidence: string[];
  profileConfidence: "low" | "medium" | "high";
  sourceNames: string[];
  sourceRetrievedAt: string;
  notes: string;
};

export type AcuModelEstimate = {
  candidateId: string;
  modelId: string;
  executionPresetId?: string;
  reasoningEffort?: import("../alpha/reasoning-capability.js").CanonicalReasoningEffort;
  expectedOutputTokenMultiplier?: number;
  displayName: string;
  provider: string;
  estimatedQuality: number;
  conservativeQuality: number;
  qualityLower: number;
  qualityUpper: number;
  estimatedCallCost: number;
  expectedFallbackCost: number;
  selectionCost: number;
  judgeOverheadCost: number;
  expectedEndToEndCost: number;
  /** Backward-compatible alias for expectedEndToEndCost. */
  expectedTotalCost: number;
  predictedScore: number;
  conservativeScore: number;
  riskAdjustedCost: number;
  riskAdjustedScore: number;
  qualityUtility: number;
  costUtility: number;
  valueUtility: number;
  baseValueUtility?: number;
  candidatePreferenceScore?: number;
  candidatePreferenceMultiplier?: number;
  adjustedValueUtility?: number;
  rawQualityUtility?: number;
  rawCostUtility?: number;
  qualitySatisfactionUtility?: number;
  qualitySatisfactionVersion?: string;
  normalizedQualityUtility?: number;
  normalizedCostUtility?: number;
  qualityContribution?: number;
  costContribution?: number;
  normalizationQualityRange?: number;
  normalizationCostRange?: number;
  normalizationQualityDenominator?: number;
  normalizationCostDenominator?: number;
  normalizationVersion?: string;
  qualityWeight?: number;
  costWeight?: number;
  rank?: number;
  selected?: boolean;
  formulaVersion?: string;
  scoreGapVsBest: number;
  costSavingsVsBest: number;
  paretoEfficient: boolean;
  selectionReason: string;
  savingsVsFlagship: number;
  savingsPercentVsFlagship: number;
  meetsQualityTarget: boolean;
};

export type AcuRecommendation = {
  recommended: AcuModelEstimate;
  valueAlternative: AcuModelEstimate | null;
  flagshipAlternative: AcuModelEstimate;
  fallbackModel: AcuModelEstimate;
  estimates: AcuModelEstimate[];
  reason: string;
};

export type AcuVisibleMessage = {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  [key: string]: unknown;
};

export type AcuEvaluateInput = {
  messages: AcuVisibleMessage[];
  tools?: unknown[];
  qualityTarget?: number;
  expectedOutputTokens?: number;
  eligibleModelIds?: string[];
  requireToolCallSupport?: boolean;
  requireVisionSupport?: boolean;
  forceJudgeRefresh?: boolean;
  requestId?: string;
  requestedModel?: string;
  sessionHash?: string;
};

export type AcuEvaluation = {
  estimateLabel: "public-benchmark constrained estimate";
  promptVersion: string;
  judgeModel: string;
  /** The reasoning preset used by the live Judge request. */
  judgeReasoningEffort?: "default" | "low" | "medium" | "high" | "max";
  judgeMode: "non-thinking";
  judge: AcuJudgeResult;
  judgeStatus: AcuJudgeStatus;
  judgeResultSource: AcuJudgeResultSource;
  judgeProvider: string;
  judgeEndpointHost: string;
  upstreamRequestId: string | null;
  cacheKeySha256: string;
  cacheCreatedAt: string;
  usageStatus: "reported" | "usage_missing" | "not_applicable";
  judgeErrorCategory?: string;
  judgeLatencyMs: number;
  judgeCost: number;
  judgePromptTokens: number;
  judgeCompletionTokens: number;
  contextSha256: string;
  contextTokenEstimate: number;
  contextTruncated: boolean;
  difficultyScoreRaw: number;
  difficultyFactors: AcuDifficultyFactors;
  factorComposite: number;
  difficultyIndex: number;
  difficultyMethodVersion: "acu-difficulty-index-v1";
  difficultyScore: number;
  judgeEntropy: number;
  routingModelVersion: string;
  shadowMode: boolean;
  actualModel?: string;
  recommendationApplied?: boolean;
  requestId: string;
  qualityTarget: number;
  recommendation: AcuRecommendation;
  disclaimer: string;
};

export type AcuCurvePoint = {
  difficultyScore: number;
  pLow: number;
  pMid: number;
  pMidHigh: number;
  pHigh: number;
  estimatedQuality: number;
  qualityLower: number;
  qualityUpper: number;
};
