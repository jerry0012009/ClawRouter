/**
 * Model Definitions — Dual Upstream (2026-07-02 updated)
 *
 * "proxy": api.openai-proxy.org (OpenAI, Anthropic, Google, DeepSeek, Kimi, Qwen, GLM)
 * "openrouter": openrouter.ai (DeepSeek, Meta, Qwen, Grok, free models)
 */

import type { ModelDefinitionConfig, ModelProviderConfig } from "./types.js";

export type UpstreamProvider = "proxy" | "openrouter";

export type ExtendedModelDefinition = ModelDefinitionConfig & {
  upstream: UpstreamProvider;
  useMaxCompletionTokens?: boolean;
};

export const BLOCKRUN_MODELS: ExtendedModelDefinition[] = [
  // ═══════════════════════════════════════════
  //  api.openai-proxy.org
  // ═══════════════════════════════════════════

  // ── OpenAI (GPT-4 series, works with max_tokens) ──
  { id: "gpt-4o", name: "GPT-4o", upstream: "proxy", reasoning: false, input: ["text", "image"],
    cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 }, contextWindow: 128_000, maxTokens: 16_384 },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", upstream: "proxy", reasoning: false, input: ["text", "image"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 }, contextWindow: 128_000, maxTokens: 16_384 },
  { id: "gpt-4.1", name: "GPT-4.1", upstream: "proxy", reasoning: false, input: ["text", "image"],
    cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 }, contextWindow: 1_048_576, maxTokens: 32_768 },
  { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", upstream: "proxy", reasoning: false, input: ["text", "image"],
    cost: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 }, contextWindow: 1_048_576, maxTokens: 32_768 },
  { id: "gpt-4.1-nano", name: "GPT-4.1 Nano", upstream: "proxy", reasoning: false, input: ["text", "image"],
    cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 }, contextWindow: 1_048_576, maxTokens: 32_768 },
  { id: "gpt-4-turbo", name: "GPT-4 Turbo", upstream: "proxy", reasoning: false, input: ["text", "image"],
    cost: { input: 10, output: 30, cacheRead: 5, cacheWrite: 10 }, contextWindow: 128_000, maxTokens: 4_096 },

  // ── OpenAI (GPT-5 series, need max_completion_tokens) ──
  { id: "gpt-5.5", name: "GPT-5.5", upstream: "proxy", useMaxCompletionTokens: true, reasoning: true, input: ["text", "image"],
    cost: { input: 5, output: 30, cacheRead: 2.5, cacheWrite: 5 }, contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: "gpt-5.4-nano", name: "GPT-5.4 Nano", upstream: "proxy", useMaxCompletionTokens: true, reasoning: false, input: ["text", "image"],
    cost: { input: 0.2, output: 1.25, cacheRead: 0.1, cacheWrite: 0.2 }, contextWindow: 1_048_576, maxTokens: 32_768 },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", upstream: "proxy", useMaxCompletionTokens: true, reasoning: false, input: ["text", "image"],
    cost: { input: 0.75, output: 4.5, cacheRead: 0.375, cacheWrite: 0.75 }, contextWindow: 1_048_576, maxTokens: 32_768 },

  // ── OpenAI Reasoning (need max_completion_tokens) ──
  { id: "o3", name: "o3", upstream: "proxy", useMaxCompletionTokens: true, reasoning: true, input: ["text", "image"],
    cost: { input: 10, output: 40, cacheRead: 2.5, cacheWrite: 10 }, contextWindow: 200_000, maxTokens: 100_000 },
  { id: "o4-mini", name: "o4-mini", upstream: "proxy", useMaxCompletionTokens: true, reasoning: true, input: ["text", "image"],
    cost: { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 1.1 }, contextWindow: 200_000, maxTokens: 100_000 },

  // ── Anthropic Claude ──
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", upstream: "proxy", reasoning: false, input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, contextWindow: 200_000, maxTokens: 16_384 },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", upstream: "proxy", reasoning: false, input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, contextWindow: 200_000, maxTokens: 16_384 },
  { id: "claude-opus-4-20250514", name: "Claude Opus 4", upstream: "proxy", reasoning: true, input: ["text", "image"],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }, contextWindow: 200_000, maxTokens: 32_000 },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", upstream: "proxy", reasoning: true, input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, contextWindow: 200_000, maxTokens: 32_000 },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", upstream: "proxy", reasoning: true, input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, contextWindow: 200_000, maxTokens: 32_000 },
  { id: "claude-fable-5", name: "Claude Fable 5", upstream: "proxy", reasoning: true, input: ["text", "image"],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }, contextWindow: 200_000, maxTokens: 32_000 },

  // ── Google Gemini ──
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", upstream: "proxy", reasoning: true, input: ["text", "image"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0.15 }, contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", upstream: "proxy", reasoning: true, input: ["text", "image"],
    cost: { input: 1.25, output: 10, cacheRead: 0.3125, cacheWrite: 1.25 }, contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: "gemini-3-pro-image", name: "Gemini 3 Pro Image", upstream: "proxy", reasoning: false, input: ["text", "image"],
    cost: { input: 2, output: 12, cacheRead: 1, cacheWrite: 2 }, contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", upstream: "proxy", reasoning: false, input: ["text", "image"],
    cost: { input: 0.25, output: 1.5, cacheRead: 0.125, cacheWrite: 0.25 }, contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: "gemini-3.1-flash-lite-image", name: "Gemini 3.1 Flash Lite Image", upstream: "proxy", reasoning: false, input: ["text", "image"],
    cost: { input: 0.25, output: 1.5, cacheRead: 0.125, cacheWrite: 0.25 }, contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image", upstream: "proxy", reasoning: false, input: ["text", "image"],
    cost: { input: 0.5, output: 3, cacheRead: 0.25, cacheWrite: 0.5 }, contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", upstream: "proxy", reasoning: false, input: ["text", "image"],
    cost: { input: 1.5, output: 9, cacheRead: 0.75, cacheWrite: 1.5 }, contextWindow: 1_048_576, maxTokens: 65_536 },

  // ── DeepSeek (via proxy) ──
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", upstream: "proxy", reasoning: false, input: ["text"],
    cost: { input: 0.15, output: 0.3, cacheRead: 0.07, cacheWrite: 0.15 }, contextWindow: 163_840, maxTokens: 163_840 },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", upstream: "proxy", reasoning: true, input: ["text"],
    cost: { input: 1.8, output: 3.6, cacheRead: 0.9, cacheWrite: 1.8 }, contextWindow: 163_840, maxTokens: 163_840 },
  { id: "deepseek-v3.2", name: "DeepSeek V3.2", upstream: "proxy", reasoning: false, input: ["text"],
    cost: { input: 0.3, output: 0.45, cacheRead: 0.15, cacheWrite: 0.3 }, contextWindow: 163_840, maxTokens: 163_840 },

  // ── Moonshot Kimi ──
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", upstream: "proxy", reasoning: false, input: ["text"],
    cost: { input: 0.95, output: 4, cacheRead: 0.475, cacheWrite: 0.95 }, contextWindow: 256_000, maxTokens: 32_768 },
  { id: "kimi-k2.6", name: "Kimi K2.6", upstream: "proxy", reasoning: false, input: ["text"],
    cost: { input: 0.95, output: 4, cacheRead: 0.475, cacheWrite: 0.95 }, contextWindow: 256_000, maxTokens: 32_768 },
  { id: "kimi-k2.5", name: "Kimi K2.5", upstream: "proxy", reasoning: false, input: ["text"],
    cost: { input: 0.6, output: 3, cacheRead: 0.3, cacheWrite: 0.6 }, contextWindow: 256_000, maxTokens: 32_768 },

  // ── Qwen (via proxy) ──
  { id: "qwen3.7-max", name: "Qwen 3.7 Max", upstream: "proxy", reasoning: true, input: ["text"],
    cost: { input: 1.8, output: 5.4, cacheRead: 0.9, cacheWrite: 1.8 }, contextWindow: 131_072, maxTokens: 32_768 },
  { id: "qwen3.7-plus", name: "Qwen 3.7 Plus", upstream: "proxy", reasoning: false, input: ["text"],
    cost: { input: 0.3, output: 1.2, cacheRead: 0.15, cacheWrite: 0.3 }, contextWindow: 131_072, maxTokens: 32_768 },
  { id: "qwen3.6-flash", name: "Qwen 3.6 Flash", upstream: "proxy", reasoning: false, input: ["text"],
    cost: { input: 0.18, output: 1.1, cacheRead: 0.09, cacheWrite: 0.18 }, contextWindow: 131_072, maxTokens: 32_768 },
  { id: "qwen3.6-plus", name: "Qwen 3.6 Plus", upstream: "proxy", reasoning: false, input: ["text"],
    cost: { input: 0.3, output: 1.75, cacheRead: 0.15, cacheWrite: 0.3 }, contextWindow: 131_072, maxTokens: 32_768 },
  { id: "qwen3.5-flash", name: "Qwen 3.5 Flash", upstream: "proxy", reasoning: false, input: ["text"],
    cost: { input: 0.04, output: 0.3, cacheRead: 0.02, cacheWrite: 0.04 }, contextWindow: 131_072, maxTokens: 32_768 },
  { id: "qwen3.5-plus", name: "Qwen 3.5 Plus", upstream: "proxy", reasoning: false, input: ["text"],
    cost: { input: 0.12, output: 0.75, cacheRead: 0.06, cacheWrite: 0.12 }, contextWindow: 131_072, maxTokens: 32_768 },

  // ── GLM ──
  { id: "glm-5.2", name: "GLM 5.2", upstream: "proxy", reasoning: false, input: ["text"],
    cost: { input: 1.2, output: 4.2, cacheRead: 0.6, cacheWrite: 1.2 }, contextWindow: 128_000, maxTokens: 16_384 },
  { id: "glm-5.1", name: "GLM 5.1", upstream: "proxy", reasoning: false, input: ["text"],
    cost: { input: 0.9, output: 3.5, cacheRead: 0.45, cacheWrite: 0.9 }, contextWindow: 128_000, maxTokens: 16_384 },
  { id: "glm-5", name: "GLM 5", upstream: "proxy", reasoning: false, input: ["text"],
    cost: { input: 0.6, output: 2.7, cacheRead: 0.3, cacheWrite: 0.6 }, contextWindow: 128_000, maxTokens: 16_384 },

  // ═══════════════════════════════════════════
  //  OpenRouter
  // ═══════════════════════════════════════════

  // ── DeepSeek (via OpenRouter) ──
  { id: "deepseek/deepseek-chat-v3-0324", name: "DeepSeek V3 (OR)", upstream: "openrouter", reasoning: false, input: ["text"],
    cost: { input: 0.5, output: 1.54, cacheRead: 0.07, cacheWrite: 0.5 }, contextWindow: 163_840, maxTokens: 163_840 },
  { id: "deepseek/deepseek-r1", name: "DeepSeek R1 (OR)", upstream: "openrouter", reasoning: true, input: ["text"],
    cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 }, contextWindow: 163_840, maxTokens: 163_840 },

  // ── Meta ──
  { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", upstream: "openrouter", reasoning: false, input: ["text", "image"],
    cost: { input: 0.2, output: 0.6, cacheRead: 0.05, cacheWrite: 0.2 }, contextWindow: 1_048_576, maxTokens: 32_768 },
  { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", upstream: "openrouter", reasoning: false, input: ["text"],
    cost: { input: 0.1, output: 0.1, cacheRead: 0.025, cacheWrite: 0.1 }, contextWindow: 131_072, maxTokens: 16_384 },

  // ── Qwen (via OpenRouter) ──
  { id: "qwen/qwen3-235b-a22b", name: "Qwen3 235B (OR)", upstream: "openrouter", reasoning: true, input: ["text"],
    cost: { input: 0.2, output: 0.6, cacheRead: 0.1, cacheWrite: 0.2 }, contextWindow: 131_072, maxTokens: 32_768 },

  // ── xAI ──
  { id: "x-ai/grok-4.3", name: "Grok 4.3 (OR)", upstream: "openrouter", reasoning: false, input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 1.5, cacheWrite: 3 }, contextWindow: 131_072, maxTokens: 16_384 },

  // ── Free models (OpenRouter) ──
  { id: "openai/gpt-oss-20b:free", name: "GPT-OSS 20B (Free)", upstream: "openrouter", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 16_384 },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron Super 120B (Free)", upstream: "openrouter", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 16_384 },
  { id: "google/gemma-4-26b-a4b-it:free", name: "Gemma 4 26B (Free)", upstream: "openrouter", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 16_384 },
  { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B (Free)", upstream: "openrouter", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 16_384 },
  { id: "liquid/lfm-2.5-1.2b-thinking:free", name: "Liquid LFM Thinking (Free)", upstream: "openrouter", reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 16_384 },
];

export const OPENCLAW_MODELS = BLOCKRUN_MODELS;

export const MODEL_ALIASES: Record<string, string> = {
  // OpenAI
  gpt: "gpt-4o", gpt4: "gpt-4o", mini: "gpt-4o-mini",
  o1: "o3", o3: "o3", o4: "o4-mini", nano: "gpt-4.1-nano",
  "gpt-5": "gpt-5.5", "gpt-5.5": "gpt-5.5",
  // Anthropic
  claude: "claude-sonnet-4-20250514", sonnet: "claude-sonnet-4-20250514",
  "claude-sonnet": "claude-sonnet-4-20250514", "claude-opus": "claude-opus-4-8",
  opus: "claude-opus-4-8", fable: "claude-fable-5",
  // Google
  gemini: "gemini-2.5-flash", flash: "gemini-2.5-flash", pro: "gemini-2.5-pro",
  // DeepSeek
  deepseek: "deepseek-v4-flash", "deepseek-chat": "deepseek-v4-flash",
  "deepseek-pro": "deepseek-v4-pro", "deepseek-r1": "deepseek/deepseek-r1",
  // Kimi
  kimi: "kimi-k2.7-code", "kimi-k2": "kimi-k2.7-code",
  // Qwen
  qwen: "qwen3.7-plus", "qwen-max": "qwen3.7-max",
  // GLM
  glm: "glm-5.2",
  // Grok
  grok: "x-ai/grok-4.3",
  // Meta
  llama: "meta-llama/llama-4-maverick", maverick: "meta-llama/llama-4-maverick",
  // Free
  free: "nvidia/nemotron-3-super-120b-a12b:free",
  nemotron: "nvidia/nemotron-3-super-120b-a12b:free",
};

export function resolveModelAlias(model: string): string {
  const lower = model.toLowerCase().trim();
  return MODEL_ALIASES[lower] ?? lower;
}

export function getUpstream(modelId: string): UpstreamProvider {
  return BLOCKRUN_MODELS.find((m) => m.id === modelId)?.upstream ?? "proxy";
}

export function usesMaxCompletionTokens(modelId: string): boolean {
  return BLOCKRUN_MODELS.find((m) => m.id === modelId)?.useMaxCompletionTokens ?? false;
}

export function buildProviderModels(baseUrl: string): ModelProviderConfig {
  return { baseUrl, api: "openai-completions", models: BLOCKRUN_MODELS.map((m) => ({ ...m, headers: {} })) };
}

export function supportsToolCalling(modelId: string): boolean {
  return !new Set(["liquid/lfm-2.5-1.2b-thinking:free"]).has(modelId);
}
export function supportsVision(modelId: string): boolean {
  return BLOCKRUN_MODELS.find((m) => m.id === modelId)?.input.includes("image") ?? false;
}
export function isReasoningModel(modelId: string): boolean {
  return BLOCKRUN_MODELS.find((m) => m.id === modelId)?.reasoning ?? false;
}
export function getModelContextWindow(modelId: string): number | undefined {
  return BLOCKRUN_MODELS.find((m) => m.id === modelId)?.contextWindow;
}
export function isAgenticModel(modelId: string): boolean {
  return ["gpt-4o", "gpt-4.1", "claude-sonnet-4-20250514", "claude-sonnet-5", "deepseek-v4-pro", "meta-llama/llama-4-maverick"].includes(modelId);
}
export function getAgenticModels(): string[] {
  return BLOCKRUN_MODELS.filter((m) => isAgenticModel(m.id)).map((m) => m.id);
}
export function getActivePromoPrice(_modelId: string): number | undefined { return undefined; }
