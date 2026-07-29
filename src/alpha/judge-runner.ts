import { AcuJudgeClient } from "../acu/judge.js";
import { normalizedEntropy } from "../acu/math.js";
import { rulesFallbackJudge } from "../acu/strategy.js";
import type { AcuRuntimeConfig } from "../acu/config.js";
import type { AcuJudgeResult, AcuVisibleMessage } from "../acu/types.js";
import type { RoutingDecision } from "../router/types.js";
import type { WebIntentDecision } from "./protocol/types.js";
import type { TriggerReason } from "./state-machine.js";
import { classifyWebIntentFallback, type WebIntentFallbackInput, withWebIntentSource } from "./web-intent.js";

export type AlphaJudgeRun = {
  judge: AcuJudgeResult;
  status: "live" | "cache_hit" | "recent_evaluation" | "rules_fallback" | "safe_profile_fallback";
  resultSource: "upstream_live" | "disk_cache" | "recent_evaluation" | "rules_strategy" | "safe_profile";
  model?: string;
  provider?: string;
  promptVersion: string;
  policyVersion: string;
  contextHash: string;
  contextTokenEstimate: number;
  contextTruncated: boolean;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  costUsd: string;
  entropy: number;
  errorCategory?: string;
  webIntentDecision: WebIntentDecision;
};

export type AlphaJudgeInput = {
  messages: AcuVisibleMessage[];
  tools: unknown[];
  trigger: TriggerReason;
  contextHash: string;
  recentEvaluation?: AlphaJudgeRun;
  webIntentFallbackInput: WebIntentFallbackInput;
};

export type AlphaJudgeRunner = {
  run(input: AlphaJudgeInput): Promise<AlphaJudgeRun>;
};

export type AcuJudgeRunnerOptions = {
  config: AcuRuntimeConfig;
  rulesDecision: RoutingDecision;
  policyVersion?: string;
  client?: AcuJudgeClient;
};

function canReuseRecent(trigger: TriggerReason): boolean {
  return !["new_task", "human_message"].includes(trigger);
}

export function createAcuJudgeRunner(options: AcuJudgeRunnerOptions): AlphaJudgeRunner {
  const client = options.client ?? new AcuJudgeClient(options.config);
  const policyVersion = options.policyVersion ?? "alpha-judge-policy-v1";
  return {
    async run(input) {
      try {
        const result = await client.judge(input.messages, input.tools);
        return {
          judge: result.result,
          status: result.status,
          resultSource: result.resultSource,
          model: options.config.judgeModel,
          provider: result.provider,
          promptVersion: options.config.promptVersion,
          policyVersion,
          contextHash: result.contextSha256,
          contextTokenEstimate: result.contextTokenEstimate,
          contextTruncated: result.contextTruncated,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          latencyMs: result.latencyMs,
          costUsd: result.cost.toFixed(10),
          entropy: normalizedEntropy(result.result),
          webIntentDecision: {
            intent: result.result.webIntent!,
            confidence: result.result.webIntentConfidence!,
            reason: result.result.webIntentReason!,
            evidence: result.result.webIntentEvidence!,
            source: "judge",
          },
        };
      } catch (error) {
        const fallback = withWebIntentSource(
          classifyWebIntentFallback(input.webIntentFallbackInput),
          "heuristic_fallback",
        );
        if (input.recentEvaluation && canReuseRecent(input.trigger)) {
          return {
            ...input.recentEvaluation,
            status: "recent_evaluation",
            resultSource: "recent_evaluation",
            costUsd: "0.0000000000",
            latencyMs: 0,
            errorCategory: error instanceof Error ? error.message.slice(0, 160) : "judge_error",
            webIntentDecision: fallback,
          };
        }
        const judge = rulesFallbackJudge(options.rulesDecision);
        return {
          judge,
          status: "rules_fallback",
          resultSource: "rules_strategy",
          model: options.config.judgeModel,
          provider: "rules_strategy",
          promptVersion: options.config.promptVersion,
          policyVersion,
          contextHash: input.contextHash,
          contextTokenEstimate: 0,
          contextTruncated: false,
          promptTokens: 0,
          completionTokens: 0,
          latencyMs: 0,
          costUsd: "0.0000000000",
          entropy: normalizedEntropy(judge),
          errorCategory: error instanceof Error ? error.message.slice(0, 160) : "judge_error",
          webIntentDecision: fallback,
        };
      }
    },
  };
}
