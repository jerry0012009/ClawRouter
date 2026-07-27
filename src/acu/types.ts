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
  modelId: string;
  displayName: string;
  provider: string;
  estimatedQuality: number;
  conservativeQuality: number;
  qualityLower: number;
  qualityUpper: number;
  estimatedCallCost: number;
  expectedFallbackCost: number;
  expectedTotalCost: number;
  predictedScore: number;
  conservativeScore: number;
  riskAdjustedCost: number;
  riskAdjustedScore: number;
  qualityUtility: number;
  costUtility: number;
  valueUtility: number;
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
