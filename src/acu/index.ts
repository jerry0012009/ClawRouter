export { AcuDemoStrategy, rulesFallbackJudge } from "./strategy.js";
export { AcuJudgeClient, buildJudgeSystemPrompt, computeDifficultyIndex, hasSevereTierConflict, parseJudgeResult, serializeVisibleContext, estimateVisibleTokens } from "./judge.js";
export { getAcuCatalog, getAcuModel, buildModelCurve, interpolateModelCurve, publicCatalogPayload } from "./catalog.js";
export {
  ACU_COST_LOG_SCALE,
  VALUE_UTILITY_NEAR_TIE_RATIO,
  recommendModel,
  estimateCallCost,
  isParetoEfficient,
  selectValueRoute,
} from "./decision.js";
export {
  applyLogitShift,
  difficultyScore,
  normalizedEntropy,
  estimatedQuality,
  normalizeProbabilities,
  normalizeBenefitUtilities,
  solveAbilityParameter,
  tierSufficiency,
  continuousTierProbabilities,
} from "./math.js";
export { readAcuRuntimeConfig } from "./config.js";
export { AcuRoutingStore, openAcuRoutingStore, hashSession } from "./storage.js";
export { executionProfileFor } from "./execution-profile.js";
export type { ExecutionProfile, ThinkingMode } from "./execution-profile.js";
export type { RoutingRecordMetadata, FeedbackInput, OutcomeInput, ExecutionProfileHealth } from "./storage.js";
export type { AcuRuntimeConfig } from "./config.js";
export type * from "./types.js";
