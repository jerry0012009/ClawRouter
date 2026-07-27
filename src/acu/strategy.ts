import { createHash } from "node:crypto";
import { ACU_DEMO_DISCLAIMER, type AcuRuntimeConfig } from "./config.js";
import { difficultyScore, normalizeProbabilities } from "./math.js";
import { recommendModel } from "./decision.js";
import {
  AcuJudgeClient,
  estimateVisibleTokens,
  serializeVisibleContext,
  truncateVisibleContext,
} from "./judge.js";
import type { AcuEvaluateInput, AcuEvaluation, AcuJudgeResult } from "./types.js";
import type { RoutingDecision, Tier } from "../router/types.js";

function acuTierForRuleTier(tier: Tier): "low" | "mid" | "mid_high" | "high" {
  return ({ SIMPLE: "low", MEDIUM: "mid", COMPLEX: "mid_high", REASONING: "high" } as const)[tier];
}

export function rulesFallbackJudge(decision: RoutingDecision): AcuJudgeResult {
  const selected = acuTierForRuleTier(decision.tier);
  const confidence = Math.max(0.55, Math.min(0.97, decision.confidence));
  const remainder = (1 - confidence) / 3;
  const probabilities = normalizeProbabilities({
    pLow: selected === "low" ? confidence : remainder,
    pMid: selected === "mid" ? confidence : remainder,
    pMidHigh: selected === "mid_high" ? confidence : remainder,
    pHigh: selected === "high" ? confidence : remainder,
    confidence: decision.confidence,
  });
  return {
    ...probabilities,
    signals: ["rules_strategy_fallback", decision.tier.toLowerCase()],
    explanation: "Difficulty Judge不可用，已使用现有RulesStrategy安全回退。",
  };
}

export class AcuDemoStrategy {
  readonly name = "acu-demo";

  constructor(
    private readonly config: AcuRuntimeConfig,
    private readonly judgeClient = new AcuJudgeClient(config),
  ) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  async evaluate(
    input: AcuEvaluateInput,
    rulesDecision: RoutingDecision,
  ): Promise<AcuEvaluation> {
    const visible = serializeVisibleContext(input.messages, input.tools);
    const fallbackContext = truncateVisibleContext(visible, this.config.maxContextTokens);
    let judge: AcuJudgeResult;
    let judgeStatus: AcuEvaluation["judgeStatus"];
    let judgeLatencyMs = 0;
    let judgeCost = 0;
    let judgePromptTokens = 0;
    let judgeCompletionTokens = 0;
    let contextSha256 = createHash("sha256").update(visible).digest("hex");
    let contextTokenEstimate = estimateVisibleTokens(fallbackContext.text);
    let contextTruncated = fallbackContext.truncated;
    try {
      if (!this.config.enabled) throw new Error("ACU Demo Router feature flag is disabled");
      const response = await this.judgeClient.judge(input.messages, input.tools);
      judge = response.result;
      judgeStatus = response.status;
      judgeLatencyMs = response.latencyMs;
      judgeCost = response.cost;
      judgePromptTokens = response.promptTokens;
      judgeCompletionTokens = response.completionTokens;
      contextSha256 = response.contextSha256;
      contextTokenEstimate = response.contextTokenEstimate;
      contextTruncated = response.contextTruncated;
    } catch {
      judge = rulesFallbackJudge(rulesDecision);
      judgeStatus = "rules_fallback";
    }
    const recommendation = recommendModel({
      probabilities: judge,
      inputTokens: contextTokenEstimate,
      expectedOutputTokens: input.expectedOutputTokens ?? 800,
      judgeCost,
      qualityTarget: input.qualityTarget,
      eligibleModelIds: input.eligibleModelIds,
      requireToolCallSupport: input.requireToolCallSupport,
      requireVisionSupport: input.requireVisionSupport,
    });
    return {
      estimateLabel: "public-benchmark constrained estimate",
      promptVersion: this.config.promptVersion,
      judgeModel: this.config.judgeModel,
      judgeMode: "non-thinking",
      judge,
      judgeStatus,
      judgeLatencyMs,
      judgeCost,
      judgePromptTokens,
      judgeCompletionTokens,
      contextSha256,
      contextTokenEstimate,
      contextTruncated,
      difficultyScore: difficultyScore(judge),
      qualityTarget: input.qualityTarget ?? 0.8,
      recommendation,
      disclaimer: ACU_DEMO_DISCLAIMER,
    };
  }
}
