export const ACU_PROMPT_VERSION = "acu-tier-requirement-v1";
export const ACU_DEFAULT_JUDGE_MODEL = "deepseek-v4-flash";
export const ACU_DEFAULT_JUDGE_BASE_URL = "https://api.deepseek.com";
export const ACU_DEFAULT_JUDGE_MODE = "non-thinking" as const;
export const ACU_DEFAULT_JUDGE_TIMEOUT_MS = 8_000;
export const ACU_DEFAULT_MAX_CONTEXT_TOKENS = 6_000;
export const ACU_DEFAULT_MAX_OUTPUT_TOKENS = 300;
export const ACU_DEFAULT_QUALITY_TARGET = 0.9;
export const ACU_DEFAULT_SWITCH_COST_USD = 0.0002;

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
  "请求难度基于TwinRouterBench最低充分档位体系；模型曲线由公开Benchmark能力锚点和受约束能力模型生成，用于产品演示，不代表具体模型对当前请求的逐题实测成功率。";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type AcuRuntimeConfig = {
  enabled: boolean;
  judgeModel: string;
  judgeBaseUrl: string;
  judgeMode: "non-thinking";
  promptVersion: string;
  timeoutMs: number;
  maxContextTokens: number;
  maxOutputTokens: number;
  apiKey?: string;
  cachePath?: string;
};

export function readAcuRuntimeConfig(overrides: Partial<AcuRuntimeConfig> = {}): AcuRuntimeConfig {
  const enabled = process.env.ACU_DEMO_ROUTER_ENABLED?.trim().toLowerCase() === "true";
  return {
    enabled,
    judgeModel: process.env.ACU_JUDGE_MODEL?.trim() || ACU_DEFAULT_JUDGE_MODEL,
    judgeBaseUrl: process.env.ACU_JUDGE_BASE_URL?.trim() || ACU_DEFAULT_JUDGE_BASE_URL,
    judgeMode: ACU_DEFAULT_JUDGE_MODE,
    promptVersion: process.env.ACU_JUDGE_PROMPT_VERSION?.trim() || ACU_PROMPT_VERSION,
    timeoutMs: positiveInteger(process.env.ACU_JUDGE_TIMEOUT_MS, ACU_DEFAULT_JUDGE_TIMEOUT_MS),
    maxContextTokens: positiveInteger(
      process.env.ACU_JUDGE_MAX_CONTEXT_TOKENS,
      ACU_DEFAULT_MAX_CONTEXT_TOKENS,
    ),
    maxOutputTokens: ACU_DEFAULT_MAX_OUTPUT_TOKENS,
    apiKey: process.env.ACU_JUDGE_API_KEY?.trim() || process.env.DEEPSEEK_API_KEY?.trim(),
    cachePath: process.env.ACU_JUDGE_CACHE_PATH?.trim(),
    ...overrides,
  };
}
