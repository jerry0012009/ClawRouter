export const ACU_PROMPT_VERSION = "acu-tier-requirement-v4";
export const ACU_DIFFICULTY_METHOD_VERSION = "acu-difficulty-index-v1" as const;
export const ACU_ROUTING_MODEL_VERSION = "acu-routing-model-v0.5";
export const ACU_DEFAULT_JUDGE_MODEL = "gpt-5.6-luna";
export const ACU_DEFAULT_JUDGE_BASE_URL = "https://lucen.cc/v1";
export const ACU_DEFAULT_JUDGE_MODE = "non-thinking" as const;
export const ACU_DEFAULT_JUDGE_FIRST_BYTE_TIMEOUT_MS = 0;
export const ACU_DEFAULT_JUDGE_TOTAL_TIMEOUT_MS = 270_000;
export const ACU_DEFAULT_JUDGE_MAX_PROFILE_ATTEMPTS = 5;
export const ACU_DEFAULT_MAX_CONTEXT_TOKENS = 1_000_000;
export const ACU_DEFAULT_BACKUP_MAX_CONTEXT_TOKENS = 1_000_000;
export const ACU_DEFAULT_MAX_OUTPUT_TOKENS = 300;
export const ACU_DEFAULT_QUALITY_TARGET = 0.8;
export const ACU_DEFAULT_SWITCH_COST_USD = 0.0002;
export const ACU_DEFAULT_JUDGE_ENTROPY_PENALTY = 3;
export const ACU_DEFAULT_DATABASE_PATH = "/var/lib/clawrouter-dev/acu-routing.db";

export const ACU_TIER_DIFFICULTY = {
  low: 0.15,
  mid: 0.4,
  midHigh: 0.65,
  high: 0.88,
} as const;

export const ACU_SHARED_TEMPERATURE = 0.12;
export const ACU_COMMON_FLOOR = 0.03;
export const ACU_COMMON_CEILING = 0.99;

export const ACU_CURVE_THRESHOLDS = {
  aboveLow: 0.275,
  aboveMid: 0.525,
  aboveMidHigh: 0.765,
} as const;

export const ACU_CURVE_TEMPERATURE = 0.08;

export const ACU_DEMO_DISCLAIMER =
  "预计模型得分基于任务能力需求、公开Benchmark及受约束能力模型，用于展示模型与当前任务的相对匹配程度，不代表逐请求实测成功率。";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function booleanValue(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === "true";
}

export type AcuRuntimeConfig = {
  enabled: boolean;
  judgeModel: string;
  judgeBaseUrl: string;
  judgeMode: "non-thinking";
  promptVersion: string;
  firstByteTimeoutMs: number;
  timeoutMs: number;
  maxContextTokens: number;
  maxOutputTokens: number;
  apiKey?: string;
  judgeProvider: string;
  judgeProtocol: "responses" | "chat_completions";
  backupJudgeModel?: string;
  backupJudgeBaseUrl?: string;
  backupApiKey?: string;
  backupJudgeProvider?: string;
  backupMaxContextTokens: number;
  syncBackupEnabled: boolean;
  sameModelFailoverEnabled: boolean;
  maxProfileAttempts: number;
  primaryProfileId?: string;
  cachePath?: string;
  allowMock: boolean;
  shadowMode: boolean;
  allowForceRefresh: boolean;
  databasePath: string;
  judgeEntropyPenalty: number;
};

export function readAcuRuntimeConfig(overrides: Partial<AcuRuntimeConfig> = {}): AcuRuntimeConfig {
  const enabled = booleanValue(process.env.ACU_DEMO_ROUTER_ENABLED);
  const config: AcuRuntimeConfig = {
    enabled,
    judgeModel: process.env.ACU_JUDGE_MODEL?.trim() || ACU_DEFAULT_JUDGE_MODEL,
    judgeBaseUrl: process.env.ACU_JUDGE_BASE_URL?.trim() || ACU_DEFAULT_JUDGE_BASE_URL,
    judgeMode: ACU_DEFAULT_JUDGE_MODE,
    promptVersion: process.env.ACU_JUDGE_PROMPT_VERSION?.trim() || ACU_PROMPT_VERSION,
    firstByteTimeoutMs: nonNegativeInteger(
      process.env.ACU_JUDGE_FIRST_BYTE_TIMEOUT_MS,
      ACU_DEFAULT_JUDGE_FIRST_BYTE_TIMEOUT_MS,
    ),
    timeoutMs: nonNegativeInteger(
      process.env.ACU_JUDGE_TOTAL_TIMEOUT_MS,
      ACU_DEFAULT_JUDGE_TOTAL_TIMEOUT_MS,
    ),
    maxContextTokens: positiveInteger(
      process.env.ACU_JUDGE_MAX_CONTEXT_TOKENS,
      ACU_DEFAULT_MAX_CONTEXT_TOKENS,
    ),
    maxOutputTokens: ACU_DEFAULT_MAX_OUTPUT_TOKENS,
    apiKey: process.env.ACU_JUDGE_API_KEY?.trim(),
    judgeProvider: process.env.ACU_JUDGE_PROVIDER?.trim() || "lucen",
    judgeProtocol: "chat_completions",
    backupJudgeModel: process.env.ACU_JUDGE_BACKUP_MODEL?.trim() || undefined,
    backupJudgeBaseUrl: process.env.ACU_JUDGE_BACKUP_BASE_URL?.trim() || undefined,
    backupApiKey: process.env.ACU_JUDGE_BACKUP_API_KEY?.trim() || undefined,
    backupJudgeProvider: process.env.ACU_JUDGE_BACKUP_PROVIDER?.trim() || undefined,
    backupMaxContextTokens: positiveInteger(
      process.env.ACU_JUDGE_BACKUP_MAX_CONTEXT_TOKENS,
      ACU_DEFAULT_BACKUP_MAX_CONTEXT_TOKENS,
    ),
    syncBackupEnabled: booleanValue(process.env.ACU_JUDGE_SYNC_BACKUP_ENABLED, false),
    sameModelFailoverEnabled: booleanValue(process.env.ACU_JUDGE_SAME_MODEL_FAILOVER_ENABLED, true),
    maxProfileAttempts: Math.max(1, Math.min(5, positiveInteger(process.env.ACU_JUDGE_MAX_PROFILE_ATTEMPTS, ACU_DEFAULT_JUDGE_MAX_PROFILE_ATTEMPTS))),
    primaryProfileId: process.env.ACU_JUDGE_PRIMARY_PROFILE_ID?.trim() || undefined,
    cachePath: process.env.ACU_JUDGE_CACHE_PATH?.trim(),
    allowMock: booleanValue(process.env.ACU_ALLOW_MOCK),
    shadowMode: booleanValue(process.env.ACU_SHADOW_MODE, true),
    allowForceRefresh: booleanValue(process.env.ACU_ALLOW_FORCE_JUDGE_REFRESH, false),
    databasePath: process.env.ACU_DATABASE_PATH?.trim() || ACU_DEFAULT_DATABASE_PATH,
    judgeEntropyPenalty: Number.isFinite(Number(process.env.ACU_JUDGE_ENTROPY_PENALTY))
      ? Math.max(0, Number(process.env.ACU_JUDGE_ENTROPY_PENALTY))
      : ACU_DEFAULT_JUDGE_ENTROPY_PENALTY,
    ...overrides,
  };
  if (booleanValue(process.env.ACU_JUDGE_ROLLBACK_TO_BACKUP)
    && config.backupJudgeModel && config.backupJudgeBaseUrl && config.backupApiKey) {
    return {
      ...config,
      judgeModel: config.backupJudgeModel,
      judgeBaseUrl: config.backupJudgeBaseUrl,
      apiKey: config.backupApiKey,
      judgeProvider: config.backupJudgeProvider ?? "openai_compatible",
      maxContextTokens: config.backupMaxContextTokens,
      backupJudgeModel: undefined,
      backupJudgeBaseUrl: undefined,
      backupApiKey: undefined,
      backupJudgeProvider: undefined,
    };
  }
  return config;
}
