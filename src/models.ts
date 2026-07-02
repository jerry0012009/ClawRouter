/**
 * OpenRouter Model Definitions
 *
 * Only includes models verified working with the current API key.
 * Tested 2026-07-02 against openrouter.ai/api/v1.
 *
 * @see https://openrouter.ai/models
 */

import type { ModelDefinitionConfig, ModelProviderConfig } from "./types.js";

export const BLOCKRUN_MODELS: ModelDefinitionConfig[] = [
  // ── Paid (cheap, verified working) ──
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
  {
    id: "qwen/qwen-2.5-72b-instruct",
    name: "Qwen 2.5 72B",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.25, output: 0.5, cacheRead: 0.0625, cacheWrite: 0.25 },
    contextWindow: 131_072,
    maxTokens: 16_384,
  },

  // ── Free (verified working) ──
  {
    id: "openai/gpt-oss-20b:free",
    name: "GPT-OSS 20B (Free)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 16_384,
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    name: "Nemotron Super 120B (Free)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 16_384,
  },
  {
    id: "nvidia/nemotron-nano-9b-v2:free",
    name: "Nemotron Nano 9B (Free)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 16_384,
  },
  {
    id: "google/gemma-4-26b-a4b-it:free",
    name: "Gemma 4 26B (Free)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 16_384,
  },
  {
    id: "google/gemma-4-31b-it:free",
    name: "Gemma 4 31B (Free)",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 16_384,
  },
  {
    id: "liquid/lfm-2.5-1.2b-thinking:free",
    name: "Liquid LFM 2.5 Thinking (Free)",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 16_384,
  },
];

/** Alias for backward compatibility */
export const OPENCLAW_MODELS = BLOCKRUN_MODELS;

export const MODEL_ALIASES: Record<string, string> = {
  // DeepSeek
  deepseek: "deepseek/deepseek-chat-v3-0324",
  "deepseek-chat": "deepseek/deepseek-chat-v3-0324",

  // Meta
  llama: "meta-llama/llama-4-maverick",
  maverick: "meta-llama/llama-4-maverick",
  "llama-3.3": "meta-llama/llama-3.3-70b-instruct",

  // Qwen
  qwen: "qwen/qwen-2.5-72b-instruct",

  // Free models
  free: "nvidia/nemotron-3-super-120b-a12b:free",
  nemotron: "nvidia/nemotron-3-super-120b-a12b:free",
  gemma: "google/gemma-4-31b-it:free",
  gpt: "openai/gpt-oss-20b:free",
};

export function resolveModelAlias(model: string): string {
  const lower = model.toLowerCase().trim();
  return MODEL_ALIASES[lower] ?? lower;
}

export function buildProviderModels(baseUrl: string): ModelProviderConfig {
  return {
    baseUrl,
    api: "openai-completions",
    models: BLOCKRUN_MODELS.map((m) => ({ ...m, headers: {} })),
  };
}

export function supportsToolCalling(modelId: string): boolean {
  const noToolSupport = new Set(["liquid/lfm-2.5-1.2b-thinking:free"]);
  return !noToolSupport.has(modelId);
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
  return ["deepseek/deepseek-chat-v3-0324", "meta-llama/llama-4-maverick", "qwen/qwen-2.5-72b-instruct"].includes(modelId);
}

export function getAgenticModels(): string[] {
  return BLOCKRUN_MODELS.filter((m) => isAgenticModel(m.id)).map((m) => m.id);
}

export function getActivePromoPrice(_modelId: string): number | undefined {
  return undefined;
}
