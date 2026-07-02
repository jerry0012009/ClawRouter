/**
 * Model Definitions — Dual Upstream
 *
 * Models are routed to one of two upstream providers:
 *   - "proxy": api.openai-proxy.org (OpenAI, Anthropic, Google)
 *   - "openrouter": openrouter.ai (DeepSeek, Llama, Qwen, free models)
 */

import type { ModelDefinitionConfig, ModelProviderConfig } from "./types.js";

export type UpstreamProvider = "proxy" | "openrouter";

export type ExtendedModelDefinition = ModelDefinitionConfig & {
  upstream: UpstreamProvider;
  /** Use max_completion_tokens instead of max_tokens (required for o-series) */
  useMaxCompletionTokens?: boolean;
};

export const BLOCKRUN_MODELS: ExtendedModelDefinition[] = [
  // ══════════════════════════════════════════════════
  //  api.openai-proxy.org models
  // ══════════════════════════════════════════════════

  // ── OpenAI ──
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
  { id: "o3", name: "o3", upstream: "proxy", reasoning: true, useMaxCompletionTokens: true, input: ["text", "image"],
    cost: { input: 10, output: 40, cacheRead: 2.5, cacheWrite: 10 }, contextWindow: 200_000, maxTokens: 100_000 },
  { id: "o4-mini", name: "o4-mini", upstream: "proxy", reasoning: true, useMaxCompletionTokens: true, input: ["text", "image"],
    cost: { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 1.1 }, contextWindow: 200_000, maxTokens: 100_000 },
  { id: "gpt-4-turbo", name: "GPT-4 Turbo", upstream: "proxy", reasoning: false, input: ["text", "image"],
    cost: { input: 10, output: 30, cacheRead: 5, cacheWrite: 10 }, contextWindow: 128_000, maxTokens: 4_096 },

  // ── Anthropic ──
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", upstream: "proxy", reasoning: false, input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, contextWindow: 200_000, maxTokens: 16_384 },
  { id: "claude-opus-4-20250514", name: "Claude Opus 4", upstream: "proxy", reasoning: true, input: ["text", "image"],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }, contextWindow: 200_000, maxTokens: 32_000 },

  // ── Google ──
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", upstream: "proxy", reasoning: true, input: ["text", "image"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0.15 }, contextWindow: 1_048_576, maxTokens: 65_536 },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", upstream: "proxy", reasoning: true, input: ["text", "image"],
    cost: { input: 1.25, output: 10, cacheRead: 0.3125, cacheWrite: 1.25 }, contextWindow: 1_048_576, maxTokens: 65_536 },

  // ══════════════════════════════════════════════════
  //  OpenRouter models
  // ══════════════════════════════════════════════════

  // ── DeepSeek ──
  { id: "deepseek/deepseek-chat-v3-0324", name: "DeepSeek V3", upstream: "openrouter", reasoning: false, input: ["text"],
    cost: { input: 0.5, output: 1.54, cacheRead: 0.07, cacheWrite: 0.5 }, contextWindow: 163_840, maxTokens: 163_840 },

  // ── Meta ──
  { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", upstream: "openrouter", reasoning: false, input: ["text", "image"],
    cost: { input: 0.2, output: 0.6, cacheRead: 0.05, cacheWrite: 0.2 }, contextWindow: 1_048_576, maxTokens: 32_768 },
  { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", upstream: "openrouter", reasoning: false, input: ["text"],
    cost: { input: 0.1, output: 0.1, cacheRead: 0.025, cacheWrite: 0.1 }, contextWindow: 131_072, maxTokens: 16_384 },

  // ── Qwen ──
  { id: "qwen/qwen-2.5-72b-instruct", name: "Qwen 2.5 72B", upstream: "openrouter", reasoning: false, input: ["text"],
    cost: { input: 0.25, output: 0.5, cacheRead: 0.0625, cacheWrite: 0.25 }, contextWindow: 131_072, maxTokens: 16_384 },

  // ── Free models (OpenRouter) ──
  { id: "openai/gpt-oss-20b:free", name: "GPT-OSS 20B (Free)", upstream: "openrouter", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 16_384 },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron Super 120B (Free)", upstream: "openrouter", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 16_384 },
  { id: "nvidia/nemotron-nano-9b-v2:free", name: "Nemotron Nano 9B (Free)", upstream: "openrouter", reasoning: false, input: ["text"],
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
  o1: "o3", o3: "o3", o4: "o4-mini",
  nano: "gpt-4.1-nano",
  // Anthropic
  claude: "claude-sonnet-4-20250514", sonnet: "claude-sonnet-4-20250514",
  opus: "claude-opus-4-20250514",
  // Google
  gemini: "gemini-2.5-flash", flash: "gemini-2.5-flash", pro: "gemini-2.5-pro",
  // DeepSeek
  deepseek: "deepseek/deepseek-chat-v3-0324", "deepseek-chat": "deepseek/deepseek-chat-v3-0324",
  // Meta
  llama: "meta-llama/llama-4-maverick", maverick: "meta-llama/llama-4-maverick",
  // Qwen
  qwen: "qwen/qwen-2.5-72b-instruct",
  // Free
  free: "nvidia/nemotron-3-super-120b-a12b:free", nemotron: "nvidia/nemotron-3-super-120b-a12b:free",
  gemma: "google/gemma-4-31b-it:free",
};

export function resolveModelAlias(model: string): string {
  const lower = model.toLowerCase().trim();
  return MODEL_ALIASES[lower] ?? lower;
}

/** Get the upstream provider for a model. */
export function getUpstream(modelId: string): UpstreamProvider {
  const model = BLOCKRUN_MODELS.find((m) => m.id === modelId);
  return model?.upstream ?? "proxy"; // default to proxy for unknown models
}

/** Check if model needs max_completion_tokens instead of max_tokens. */
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
  return ["gpt-4o", "gpt-4.1", "claude-sonnet-4-20250514", "deepseek/deepseek-chat-v3-0324", "meta-llama/llama-4-maverick"].includes(modelId);
}
export function getAgenticModels(): string[] {
  return BLOCKRUN_MODELS.filter((m) => isAgenticModel(m.id)).map((m) => m.id);
}
export function getActivePromoPrice(_modelId: string): number | undefined { return undefined; }
