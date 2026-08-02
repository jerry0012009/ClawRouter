import { AcuJudgeAttemptError, AcuJudgeClient, AcuJudgeClientCancelledError, AcuJudgeContextLengthError, estimateVisibleTokens, judgeNominalCostUsd, type JudgeRequestResult, type RawNativeJudgeContext } from "../acu/judge.js";
import { normalizedEntropy } from "../acu/math.js";
import { rulesFallbackJudge } from "../acu/strategy.js";
import type { AcuRuntimeConfig } from "../acu/config.js";
import type { AcuJudgeResult, AcuVisibleMessage } from "../acu/types.js";
import type { RoutingDecision } from "../router/types.js";
import type { WebIntentDecision } from "./protocol/types.js";
import type { TriggerReason } from "./state-machine.js";
import { classifyWebIntentFallback, type WebIntentFallbackInput, withWebIntentSource } from "./web-intent.js";
import { getEligibleLunaJudgeProfiles } from "./judge-profile-selector.js";
import type { AlphaExecutionProfile } from "./routing.js";
import { cashCnyPerNominalUsd } from "./provider-economics.js";
import type { AttemptOutcome } from "./channel-health.js";
import type { RuntimeHealthOutcomeResult } from "./runtime-health-outcome.js";

const MIMO_JUDGE_BLENDED_COST_FACTOR = 0.5;
const MIMO_JUDGE_COST_SOURCE = "midpoint_openrouter_payg_and_mimo99_plan_v1";
const MIN_FAILOVER_ATTEMPT_WINDOW_MS = 8_000;

export function judgeProfileAttemptDeadline(input: {
  now: number;
  globalDeadlineAt?: number;
  profilesRemaining: number;
}): number | undefined {
  if (input.globalDeadlineAt === undefined) return undefined;
  const remainingMs = Math.max(0, input.globalDeadlineAt - input.now);
  const reserveMs = input.profilesRemaining > 0 && remainingMs >= MIN_FAILOVER_ATTEMPT_WINDOW_MS * 2
    ? MIN_FAILOVER_ATTEMPT_WINDOW_MS : 0;
  return input.globalDeadlineAt - reserveMs;
}

export type AlphaJudgeRun = {
  judge: AcuJudgeResult;
  status: "live" | "backup_live" | "cache_hit" | "recent_evaluation" | "rules_fallback" | "safe_profile_fallback";
  resultSource: "upstream_live" | "disk_cache" | "recent_evaluation" | "rules_strategy" | "safe_profile";
  model?: string;
  provider?: string;
  promptVersion: string;
  policyVersion: string;
  contextHash: string;
  contextTokenEstimate: number;
  contextTruncated: boolean;
  rawRequestBytes: number;
  rawRequestTokenEstimate: number;
  judgeContextLimit: number;
  judgeContextSource: "raw_native_request_v1" | "visible_context_legacy";
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  costUsd: string;
  costCny: string;
  officialPaygEquivalentCostCny: string;
  costCurrency: "CNY";
  costStatus: "estimated_blended" | "verified" | "not_applicable" | "mixed";
  costSource: string;
  attempts: AlphaJudgeAttempt[];
  entropy: number;
  errorCategory?: string;
  terminalError?: {
    type: "judge_context_length_exceeded";
    message: string;
    requiredTokensEstimate: number;
    primaryContextTokens: number;
  };
  webIntentDecision: WebIntentDecision;
  preferredProfileId?: string;
  selectedProfileId?: string;
  profileAttemptCount: number;
  sameModelFailoverUsed: boolean;
  sameModelFailoverChain: string[];
};

export type AlphaJudgeAttempt = {
  attemptIndex: number;
  role: "primary" | "same_model_failover" | "backup";
  status: "success" | "error";
  provider: string;
  model: string;
  endpointHost: string;
  upstreamRequestId: string | null;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  latencyMs: number;
  nominalCostUsd: string;
  officialPaygEquivalentCostCny: string;
  effectiveCostCny: string;
  currency: "CNY";
  costStatus: "estimated_blended" | "verified" | "unavailable";
  costSource: string;
  usageStatus: "reported" | "usage_missing";
  errorCategory?: string;
  httpStatus?: number;
  backupEligible?: boolean;
  backupReason?: string;
  responseHeaders?: Record<string, string>;
  rawResponseBody?: string;
  parserExceptionType?: string;
  parserExceptionMessage?: string;
  contextSha256?: string;
  contextTokenEstimate?: number;
  rawRequestBytes?: number;
  rawRequestTokenEstimate?: number;
  judgeContextLimit?: number;
  executionProfileId?: string;
  channel?: string;
  failureLayer?: "transport_failure" | "provider_protocol_failure" | "judge_semantic_parse_failure";
  responseContentType?: string;
  providerEnvelopeValid?: boolean;
  assistantTextExtracted?: boolean;
  healthOutcomeApplied?: boolean;
  healthOutcomeScope?: "none" | "channel" | "profile";
};

export type AlphaJudgeInput = {
  messages: AcuVisibleMessage[];
  tools: unknown[];
  trigger: TriggerReason;
  contextHash: string;
  recentEvaluation?: AlphaJudgeRun;
  webIntentFallbackInput: WebIntentFallbackInput;
  rawNative: RawNativeJudgeContext;
  signal?: AbortSignal;
};

export type AlphaJudgeRunner = {
  run(input: AlphaJudgeInput): Promise<AlphaJudgeRun>;
};

export type AcuJudgeRunnerOptions = {
  config: AcuRuntimeConfig;
  rulesDecision: RoutingDecision;
  policyVersion?: string;
  client?: AcuJudgeClient;
  backupClient?: AcuJudgeClient;
  backupCashCnyPerNominalUsd?: number;
  profiles?: AlphaExecutionProfile[];
  loadProfiles?: () => Promise<AlphaExecutionProfile[]>;
  profileClients?: Map<string, AcuJudgeClient>;
  recordHealthOutcome?: (
    profile: AlphaExecutionProfile,
    outcome: AttemptOutcome,
  ) => Promise<RuntimeHealthOutcomeResult>;
};

function canReuseRecent(trigger: TriggerReason): boolean {
  return !["new_task", "human_message"].includes(trigger);
}

export function createAcuJudgeRunner(options: AcuJudgeRunnerOptions): AlphaJudgeRunner {
  const client = options.client ?? new AcuJudgeClient(options.config);
  const backupConfig = options.config.backupJudgeModel
    && options.config.backupJudgeBaseUrl
    && options.config.backupApiKey
    ? {
        ...options.config,
        judgeModel: options.config.backupJudgeModel,
        judgeBaseUrl: options.config.backupJudgeBaseUrl,
        apiKey: options.config.backupApiKey,
        judgeProvider: options.config.backupJudgeProvider ?? "openai_compatible",
        cachePath: options.config.cachePath?.replace(/\.json$/, "-backup.json"),
      }
    : undefined;
  const backupClient = options.backupClient ?? (backupConfig ? new AcuJudgeClient(backupConfig) : undefined);
  const policyVersion = options.policyVersion ?? "alpha-judge-policy-v1";
  const profileClients = options.profileClients ?? new Map<string, AcuJudgeClient>();

  const attemptCost = (input: {
    attemptIndex: number;
    role: "primary" | "same_model_failover" | "backup";
    provider: string;
    model: string;
    endpointHost: string;
    upstreamRequestId: string | null;
    promptTokens: number;
    cachedPromptTokens: number;
    completionTokens: number;
    latencyMs: number;
    usageStatus: "reported" | "usage_missing";
    status: "success" | "error";
    errorCategory?: string;
    httpStatus?: number;
    nominalCostUsd?: number;
    executionProfileId?: string;
    channel?: string;
  }): AlphaJudgeAttempt => {
    const nominalCostUsd = input.nominalCostUsd ?? judgeNominalCostUsd(
      input.model, input.promptTokens, input.cachedPromptTokens, input.completionTokens,
    );
    const isMimo = input.model === "mimo-v2.5-pro";
    const cached = Math.max(0, Math.min(input.promptTokens, input.cachedPromptTokens));
    const officialPaygEquivalentCostCny = isMimo
      ? (((input.promptTokens - cached) * 3) + (cached * 0.025) + (input.completionTokens * 6)) / 1_000_000
      : 0;
    const profile = input.executionProfileId
      ? options.profiles?.find((candidate) => candidate.executionProfileId === input.executionProfileId)
      : undefined;
    const cashRate = profile?.economics ? cashCnyPerNominalUsd(profile.economics) : options.backupCashCnyPerNominalUsd;
    const effectiveCostCny = isMimo
      ? officialPaygEquivalentCostCny * MIMO_JUDGE_BLENDED_COST_FACTOR
      : nominalCostUsd * (cashRate ?? 0);
    const usageKnown = input.usageStatus === "reported";
    return {
      ...input,
      nominalCostUsd: nominalCostUsd.toFixed(10),
      officialPaygEquivalentCostCny: officialPaygEquivalentCostCny.toFixed(10),
      effectiveCostCny: effectiveCostCny.toFixed(10),
      currency: "CNY",
      costStatus: !usageKnown ? "unavailable" : isMimo ? "estimated_blended" : cashRate ? "verified" : "unavailable",
      costSource: !usageKnown ? "provider_cost_unknown" : isMimo ? MIMO_JUDGE_COST_SOURCE : cashRate
        ? `${profile?.provider ?? "judge"}_profile_cash_conversion` : "provider_cost_unknown",
    };
  };

  const successfulAttempt = (
    result: JudgeRequestResult,
    attemptIndex: number,
    role: "primary" | "same_model_failover" | "backup",
    profile?: AlphaExecutionProfile,
  ): AlphaJudgeAttempt => attemptCost({
    attemptIndex, role, status: "success", provider: result.provider, model: result.model,
    endpointHost: result.endpointHost, upstreamRequestId: result.upstreamRequestId,
    promptTokens: result.status === "cache_hit" ? 0 : result.promptTokens,
    cachedPromptTokens: result.status === "cache_hit" ? 0 : result.cachedPromptTokens,
    completionTokens: result.status === "cache_hit" ? 0 : result.completionTokens,
    latencyMs: result.latencyMs, usageStatus: result.status === "cache_hit" ? "usage_missing" : result.usageStatus,
    nominalCostUsd: result.cost,
    ...(profile ? { executionProfileId: profile.executionProfileId, channel: profile.channel } : {}),
  });

  const failedAttempt = (error: AcuJudgeAttemptError, attemptIndex: number, role: "primary" | "same_model_failover" | "backup", profile?: AlphaExecutionProfile) => attemptCost({
    attemptIndex, role, status: "error", ...error.attempt,
    ...(profile ? { executionProfileId: profile.executionProfileId, channel: profile.channel } : {}),
  });

  const recordHealth = async (
    attempt: AlphaJudgeAttempt,
    profile: AlphaExecutionProfile | undefined,
    outcome: AttemptOutcome,
  ): Promise<void> => {
    if (!profile || !options.recordHealthOutcome) return;
    if (attempt.failureLayer === "judge_semantic_parse_failure") {
      attempt.healthOutcomeApplied = false;
      attempt.healthOutcomeScope = "none";
      return;
    }
    const result = await options.recordHealthOutcome(profile, outcome);
    attempt.healthOutcomeApplied = true;
    attempt.healthOutcomeScope = result.scope;
  };

  const aggregateCostStatus = (attempts: AlphaJudgeAttempt[]): AlphaJudgeRun["costStatus"] => {
    const statuses = new Set(attempts
      .filter((attempt) => attempt.costStatus !== "unavailable")
      .map((attempt) => attempt.costStatus));
    return statuses.size === 0 ? "not_applicable" : statuses.size === 1
      ? [...statuses][0] as "estimated_blended" | "verified"
      : "mixed";
  };

  const completeRun = (result: JudgeRequestResult, attempts: AlphaJudgeAttempt[], status: "live" | "backup_live" | "cache_hit"): AlphaJudgeRun => {
    const nominalCostUsd = attempts.reduce((sum, attempt) => sum + Number(attempt.nominalCostUsd), 0);
    const costCny = attempts.reduce((sum, attempt) => sum + Number(attempt.effectiveCostCny), 0);
    const officialPaygEquivalentCostCny = attempts
      .reduce((sum, attempt) => sum + Number(attempt.officialPaygEquivalentCostCny), 0);
    return {
      judge: result.result,
      status,
      resultSource: result.resultSource,
      model: result.model,
      provider: result.provider,
      promptVersion: options.config.promptVersion,
      policyVersion,
      contextHash: result.contextSha256,
      contextTokenEstimate: result.contextTokenEstimate,
      contextTruncated: result.contextTruncated,
      rawRequestBytes: result.rawRequestBytes,
      rawRequestTokenEstimate: result.rawRequestTokenEstimate,
      judgeContextLimit: result.judgeContextLimit,
      judgeContextSource: result.judgeContextSource,
      promptTokens: attempts.reduce((sum, attempt) => sum + attempt.promptTokens, 0),
      completionTokens: attempts.reduce((sum, attempt) => sum + attempt.completionTokens, 0),
      latencyMs: attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0),
      costUsd: nominalCostUsd.toFixed(10),
      costCny: costCny.toFixed(10),
      officialPaygEquivalentCostCny: officialPaygEquivalentCostCny.toFixed(10),
      costCurrency: "CNY",
      costStatus: aggregateCostStatus(attempts),
      costSource: [...new Set(attempts.map((attempt) => attempt.costSource))].join("+"),
      attempts,
      preferredProfileId: options.config.primaryProfileId,
      selectedProfileId: [...attempts].reverse().find((attempt) => attempt.status === "success")?.executionProfileId,
      profileAttemptCount: attempts.length,
      sameModelFailoverUsed: attempts.some((attempt) => attempt.role === "same_model_failover"),
      sameModelFailoverChain: attempts.flatMap((attempt) => attempt.executionProfileId ? [attempt.executionProfileId] : []),
      entropy: normalizedEntropy(result.result),
      webIntentDecision: {
        intent: result.result.webIntent!, confidence: result.result.webIntentConfidence!,
        reason: result.result.webIntentReason!, evidence: result.result.webIntentEvidence!, source: "judge",
      },
    };
  };
  return {
    async run(input) {
      const attempts: AlphaJudgeAttempt[] = [];
      const deadlineAt = options.config.timeoutMs > 0 ? Date.now() + options.config.timeoutMs : undefined;
      try {
        const availableProfiles = options.loadProfiles ? await options.loadProfiles() : options.profiles;
        const profiles = availableProfiles?.length
          ? getEligibleLunaJudgeProfiles({ profiles: availableProfiles, requiredContextTokens: estimateVisibleTokens(input.rawNative.rawRequest), preferredProfileId: options.config.primaryProfileId, maxProfiles: options.config.sameModelFailoverEnabled ? options.config.maxProfileAttempts : 1 })
          : [];
        const candidates: Array<{ profile?: AlphaExecutionProfile; client: AcuJudgeClient }> = profiles.length
          ? profiles.map((profile) => ({ profile, client: profileClients.get(profile.executionProfileId)! })).filter((candidate) => candidate.client)
          : [{ profile: undefined, client }];
        let lastError: unknown;
        for (let index = 0; index < candidates.length; index += 1) {
          if (deadlineAt && Date.now() >= deadlineAt) break;
          const candidate = candidates[index];
          const candidateClient = candidate.profile ? profileClients.get(candidate.profile.executionProfileId) : candidate.client;
          if (!candidateClient) continue;
          try {
            const attemptDeadlineAt = judgeProfileAttemptDeadline({
              now: Date.now(),
              globalDeadlineAt: deadlineAt,
              profilesRemaining: candidates.length - index - 1,
            });
            const result = await candidateClient.judge(input.messages, [], false, input.rawNative, input.signal, attemptDeadlineAt);
            if (result.status === "live") {
              const attempt = successfulAttempt(result, index + 1, index === 0 ? "primary" : "same_model_failover", candidate.profile);
              await recordHealth(attempt, candidate.profile, {
                success: true,
                httpStatus: 200,
                usageTrusted: result.usageStatus === "reported",
                actualModelVerified: result.model === candidate.profile?.modelId,
                totalLatencyMs: result.latencyMs,
              });
              attempts.push(attempt);
            }
            return completeRun(result, attempts, result.status);
          } catch (error) {
            lastError = error;
            if (error instanceof AcuJudgeClientCancelledError) throw error;
            if (error instanceof AcuJudgeContextLengthError) continue;
            if (error instanceof AcuJudgeAttemptError) {
              const attempt = failedAttempt(error, index + 1, index === 0 ? "primary" : "same_model_failover", candidate.profile);
              await recordHealth(attempt, candidate.profile, {
                success: false,
                httpStatus: error.attempt.httpStatus,
                errorCode: error.attempt.failureLayer === "provider_protocol_failure"
                  ? "protocol_incompatible" : error.attempt.errorCategory,
                errorMessage: error.message,
                totalLatencyMs: error.attempt.latencyMs,
              });
              attempts.push(attempt);
            }
          }
        }
        throw lastError ?? new Error("No eligible Luna Judge Profile");
      } catch (error) {
        if (error instanceof AcuJudgeClientCancelledError) throw error;
        if (error instanceof AcuJudgeContextLengthError) throw error;
        if (error instanceof AcuJudgeAttemptError && attempts.length === 0) attempts.push(failedAttempt(error, 1, "primary"));
        const primaryContextError = error instanceof AcuJudgeAttemptError
          && error.attempt.errorCategory === "context_length_exceeded";
        if (error instanceof AcuJudgeAttemptError && error.attempt.backupEligible
          && options.config.syncBackupEnabled && backupClient) {
          try {
            const backup = await backupClient.judge(input.messages, [], false, input.rawNative, input.signal);
            if (backup.status === "live") attempts.push(successfulAttempt(backup, 2, "backup"));
            return completeRun(backup, attempts, backup.status === "cache_hit" ? "cache_hit" : "backup_live");
          } catch (backupError) {
            if (backupError instanceof AcuJudgeAttemptError) attempts.push(failedAttempt(backupError, 2, "backup"));
            if (backupError instanceof AcuJudgeAttemptError
              && backupError.attempt.errorCategory === "context_length_exceeded") {
              return terminalContextFailure(backupError.attempt.model, attempts, input);
            }
          }
        }
        if (primaryContextError) return terminalContextFailure(error.attempt.model, attempts, input);
        const fallback = withWebIntentSource(
          classifyWebIntentFallback(input.webIntentFallbackInput),
          "heuristic_fallback",
        );
        if (input.recentEvaluation && canReuseRecent(input.trigger)) {
          return {
            ...input.recentEvaluation,
            status: "recent_evaluation",
            resultSource: "recent_evaluation",
            costUsd: attempts.reduce((sum, attempt) => sum + Number(attempt.nominalCostUsd), 0).toFixed(10),
            costCny: attempts.reduce((sum, attempt) => sum + Number(attempt.effectiveCostCny), 0).toFixed(10),
            officialPaygEquivalentCostCny: attempts.reduce((sum, attempt) => sum + Number(attempt.officialPaygEquivalentCostCny), 0).toFixed(10),
            costCurrency: "CNY",
            costStatus: aggregateCostStatus(attempts),
            costSource: [...new Set(attempts.map((attempt) => attempt.costSource))].join("+") || "not_applicable",
            attempts,
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
          rawRequestBytes: Buffer.byteLength(input.rawNative.rawRequest, "utf8"),
          rawRequestTokenEstimate: 0,
          judgeContextLimit: 0,
          judgeContextSource: "raw_native_request_v1",
          promptTokens: 0,
          completionTokens: 0,
          latencyMs: 0,
          costUsd: attempts.reduce((sum, attempt) => sum + Number(attempt.nominalCostUsd), 0).toFixed(10),
          costCny: attempts.reduce((sum, attempt) => sum + Number(attempt.effectiveCostCny), 0).toFixed(10),
          officialPaygEquivalentCostCny: attempts.reduce((sum, attempt) => sum + Number(attempt.officialPaygEquivalentCostCny), 0).toFixed(10),
          costCurrency: "CNY",
          costStatus: aggregateCostStatus(attempts),
          costSource: [...new Set(attempts.map((attempt) => attempt.costSource))].join("+") || "not_applicable",
          attempts,
          preferredProfileId: options.config.primaryProfileId,
          profileAttemptCount: attempts.length,
          sameModelFailoverUsed: attempts.some((attempt) => attempt.role === "same_model_failover"),
          sameModelFailoverChain: attempts.flatMap((attempt) => attempt.executionProfileId ? [attempt.executionProfileId] : []),
          entropy: normalizedEntropy(judge),
          errorCategory: error instanceof Error ? error.message.slice(0, 160) : "judge_error",
          webIntentDecision: fallback,
        };
      }
    },
  };

  function terminalContextFailure(
    model: string,
    attempts: AlphaJudgeAttempt[],
    input: AlphaJudgeInput,
  ): AlphaJudgeRun {
    const judge = rulesFallbackJudge(options.rulesDecision);
    const failed = attempts.at(-1);
    const rawRequestBytes = failed?.rawRequestBytes ?? Buffer.byteLength(input.rawNative.rawRequest, "utf8");
    const rawRequestTokenEstimate = failed?.rawRequestTokenEstimate ?? Math.ceil(rawRequestBytes / 4);
    return {
      judge,
      status: "rules_fallback",
      resultSource: "rules_strategy",
      model,
      provider: attemptsProvider(attempts),
      promptVersion: options.config.promptVersion,
      policyVersion,
      contextHash: failed?.contextSha256 ?? input.contextHash,
      contextTokenEstimate: failed?.contextTokenEstimate ?? rawRequestTokenEstimate,
      contextTruncated: false,
      rawRequestBytes,
      rawRequestTokenEstimate,
      judgeContextLimit: failed?.judgeContextLimit ?? (model === options.config.judgeModel
        ? options.config.maxContextTokens : options.config.backupMaxContextTokens),
      judgeContextSource: "raw_native_request_v1",
      promptTokens: attempts.reduce((sum, attempt) => sum + attempt.promptTokens, 0),
      completionTokens: attempts.reduce((sum, attempt) => sum + attempt.completionTokens, 0),
      latencyMs: attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0),
      costUsd: attempts.reduce((sum, attempt) => sum + Number(attempt.nominalCostUsd), 0).toFixed(10),
      costCny: attempts.reduce((sum, attempt) => sum + Number(attempt.effectiveCostCny), 0).toFixed(10),
      officialPaygEquivalentCostCny: attempts.reduce((sum, attempt) => sum + Number(attempt.officialPaygEquivalentCostCny), 0).toFixed(10),
      costCurrency: "CNY",
      costStatus: aggregateCostStatus(attempts),
      costSource: [...new Set(attempts.map((attempt) => attempt.costSource))].join("+") || "not_applicable",
      attempts,
      preferredProfileId: options.config.primaryProfileId,
      profileAttemptCount: attempts.length,
      sameModelFailoverUsed: attempts.some((attempt) => attempt.role === "same_model_failover"),
      sameModelFailoverChain: attempts.flatMap((attempt) => attempt.executionProfileId ? [attempt.executionProfileId] : []),
      entropy: normalizedEntropy(judge),
      errorCategory: "context_length_exceeded",
      terminalError: {
        type: "judge_context_length_exceeded",
        message: "The Judge provider rejected the complete native request as exceeding its context window.",
        requiredTokensEstimate: rawRequestTokenEstimate,
        primaryContextTokens: options.config.maxContextTokens,
      },
      webIntentDecision: withWebIntentSource({
        intent: "likely", confidence: 0, reason: "Judge context admission failed upstream.", evidence: [],
      }, "heuristic_fallback"),
    };
  }
}

function attemptsProvider(attempts: AlphaJudgeAttempt[]): string {
  return attempts.at(-1)?.provider ?? "judge_provider";
}
