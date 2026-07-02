/**
 * OpenRouter Model Definitions
 *
 * Maps OpenRouter model catalog to OpenClaw-compatible ModelDefinitionConfig format.
 * Pricing is in USD per 1M tokens.
 *
 * @see https://openrouter.ai/models
 */

import type { ModelDefinitionConfig, ModelProviderConfig } from "./types.js";

/**
 * Model definitions for OpenRouter.
 * Kept to the most commonly used models — extend as needed.
 */
export const BLOCKRUN_MODELS: ModelDefinitionConfig[] = [
  // ── OpenAI ──
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: "openai/o3",
    name: "o3",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 10, output: 40, cacheRead: 2.5, cacheWrite: 10 },
    contextWindow: 200_000,
    maxTokens: 100_000,
  },
  {
    id: "openai/o4-mini",
    name: "o4-mini",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 1.1 },
    contextWindow: 200_000,
    maxTokens: 100_000,
  },
  {
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
    contextWindow: 1_048_576,
    maxTokens: 32_768,
  },
  {
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
    contextWindow: 1_048_576,
    maxTokens: 32_768,
  },
  {
    id: "openai/gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
    contextWindow: 1_048_576,
    maxTokens: 32_768,
  },

  // ── Anthropic ──
  {
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: "anthropic/claude-opus-4",
    name: "Claude Opus 4",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  },
  {
    id: "anthropic/claude-haiku-3.5",
    name: "Claude 3.5 Haiku",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  },

  // ── Google ──
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0.15 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 10, cacheRead: 0.3125, cacheWrite: 1.25 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "google/gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
    contextWindow: 1_048_576,
    maxTokens: 8_192,
  },

  // ── DeepSeek ──
  {
    id: "deepseek/deepseek-chat-v3-0324",
    name: "DeepSeek V3",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.5, output: 1.54, cacheRead: 0.07, cacheWrite: 0.5 },
    contextWindow: 163_840,
    maxTokens: 163_840,
  },
  {
    id: "deepseek/deepseek-r1",
    name: "DeepSeek R1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
    contextWindow: 163_840,
    maxTokens: 163_840,
  },

  // ── xAI ──
  {
    id: "x-ai/grok-3",
    name: "Grok 3",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.75, cacheWrite: 3 },
    contextWindow: 131_072,
    maxTokens: 16_384,
  },
  {
    id: "x-ai/grok-3-mini",
    name: "Grok 3 Mini",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.3, output: 0.5, cacheRead: 0.075, cacheWrite: 0.3 },
    contextWindow: 131_072,
    maxTokens: 16_384,
  },

  // ── Meta ──
  {
    id: "meta-llama/llama-4-maverick",
    name: "Llama 4 Maverick",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.2, output: 0.6, cacheRead: 0.05, cacheWrite: 0.2 },
    contextWindow: 1_048_576,
    maxTokens: 32_768,
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct",
    name: "Llama 3.3 70B",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.1, output: 0.1, cacheRead: 0.025, cacheWrite: 0.1 },
    contextWindow: 131_072,
    maxTokens: 16_384,
  },

  // ── Qwen ──
  {
    id: "qwen/qwen-2.5-72b-instruct",
    name: "Qwen 2.5 72B",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.25, output: 0.5, cacheRead: 0.0625, cacheWrite: 0.25 },
    contextWindow: 131_072,
    maxTokens: 16_384,
  },

  // ── Mistral ──
  {
    id: "mistralai/mistral-large-2411",
    name: "Mistral Large",
    reasoning: false,
    input: ["text"],
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 },
    contextWindow: 131_072,
    maxTokens: 16_384,
  },
];

/** Alias for backward compatibility */
export const OPENCLAW_MODELS = BLOCKRUN_MODELS;

/**
 * Model aliases for convenient shorthand access.
 */
export const MODEL_ALIASES: Record<string, string> = {
  // Claude
  claude: "anthropic/claude-sonnet-4",
  sonnet: "anthropic/claude-sonnet-4",
  opus: "anthropic/claude-opus-4",
  haiku: "anthropic/claude-haiku-3.5",

  // OpenAI
  gpt: "openai/gpt-4o",
  gpt4: "openai/gpt-4o",
  mini: "openai/gpt-4o-mini",
  o1: "openai/o3",
  o3: "openai/o3",
  o4: "openai/o4-mini",

  // DeepSeek
  deepseek: "deepseek/deepseek-chat-v3-0324",
  "deepseek-chat": "deepseek/deepseek-chat-v3-0324",
  reasoner: "deepseek/deepseek-r1",

  // Google
  gemini: "google/gemini-2.5-flash",
  flash: "google/gemini-2.5-flash",
  pro: "google/gemini-2.5-pro",

  // xAI
  grok: "x-ai/grok-3",
  "grok-mini": "x-ai/grok-3-mini",

  // Meta
  llama: "meta-llama/llama-4-maverick",
  maverick: "meta-llama/llama-4-maverick",

  // Qwen
  qwen: "qwen/qwen-2.5-72b-instruct",

  // Mistral
  mistral: "mistralai/mistral-large-2411",
};

/**
 * Resolve a model alias to its full OpenRouter ID.
 */
export function resolveModelAlias(model: string): string {
  const lower = model.toLowerCase().trim();
  return MODEL_ALIASES[lower] ?? lower;
}

/**
 * Build the provider models config pointing at the local proxy.
 */
export function buildProviderModels(baseUrl: string): ModelProviderConfig {
  return {
    baseUrl,
    api: "openai-completions",
    models: BLOCKRUN_MODELS.map((m) => ({ ...m, headers: {} })),
  };
}

/** Check if a model supports tool calling. */
export function supportsToolCalling(modelId: string): boolean {
  const noToolSupport = new Set(["deepseek/deepseek-r1", "meta-llama/llama-3.3-70b-instruct"]);
  return !noToolSupport.has(modelId);
}

/** Check if a model supports vision (image inputs). */
export function supportsVision(modelId: string): boolean {
  const model = BLOCKRUN_MODELS.find((m) => m.id === modelId);
  return model?.input.includes("image") ?? false;
}

/** Check if a model is a reasoning model. */
export function isReasoningModel(modelId: string): boolean {
  return BLOCKRUN_MODELS.find((m) => m.id === modelId)?.reasoning ?? false;
}

/** Get context window for a model. */
export function getModelContextWindow(modelId: string): number | undefined {
  return BLOCKRUN_MODELS.find((m) => m.id === modelId)?.contextWindow;
}

/** Check if a model is agentic-capable (multi-step tool use). */
export function isAgenticModel(modelId: string): boolean {
  const agentic = new Set([
    "openai/gpt-4o", "openai/o3", "openai/o4-mini",
    "openai/gpt-4.1", "openai/gpt-4.1-mini",
    "anthropic/claude-sonnet-4", "anthropic/claude-opus-4",
    "google/gemini-2.5-pro", "google/gemini-2.5-flash",
    "x-ai/grok-3",
  ]);
  return agentic.has(modelId);
}

export function getAgenticModels(): string[] {
  return BLOCKRUN_MODELS.filter((m) => isAgenticModel(m.id)).map((m) => m.id);
}

/** No active promos */
export function getActivePromoPrice(_modelId: string): number | undefined {
  return undefined;
}
