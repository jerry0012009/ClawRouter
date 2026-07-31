import { getAcuModel } from "../acu/catalog.js";
import type { AlphaProtocol } from "./repository.js";

export type AlphaUsage = {
  inputTokens: bigint;
  cachedInputTokens: bigint;
  outputTokens: bigint;
  reasoningTokens: bigint;
  actualModel?: string;
  usageSource: "provider_usage" | "response_text_estimate";
  providerCostUsd: string;
};

export type ProviderBillingStatus = "provider_usage_verified" | "estimated" | "unknown";

export function classifyProviderBilling(usage: Pick<AlphaUsage, "usageSource">): ProviderBillingStatus {
  return usage.usageSource === "provider_usage" ? "provider_usage_verified" : "unknown";
}

export function resolveProviderBilling(usage: Pick<AlphaUsage, "usageSource" | "providerCostUsd">): {
  actualCostUsd: string;
  providerBilled: true | undefined;
  billingStatus: ProviderBillingStatus;
} {
  const verified = usage.usageSource === "provider_usage";
  return {
    actualCostUsd: verified ? usage.providerCostUsd : "0.0000000000",
    providerBilled: verified ? true : undefined,
    billingStatus: classifyProviderBilling(usage),
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function integer(value: unknown): bigint {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? BigInt(Math.round(numeric)) : 0n;
}

function jsonPayloads(body: Buffer, contentType: string): unknown[] {
  const text = body.toString("utf8");
  if (contentType.toLowerCase().includes("text/event-stream")) {
    return text.split(/\r?\n/).flatMap((line) => {
      if (!line.startsWith("data:")) return [];
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return [];
      try { return [JSON.parse(data) as unknown]; } catch { return []; }
    });
  }
  try { return [JSON.parse(text) as unknown]; } catch { return []; }
}

function parseResponses(payloads: unknown[]): Omit<AlphaUsage, "providerCostUsd"> | undefined {
  let result: Omit<AlphaUsage, "providerCostUsd"> | undefined;
  for (const payload of payloads) {
    const root = object(payload);
    const response = object(root?.response) ?? root;
    const usage = object(response?.usage);
    if (!usage) continue;
    const inputDetails = object(usage.input_tokens_details);
    const outputDetails = object(usage.output_tokens_details);
    result = {
      inputTokens: integer(usage.input_tokens),
      cachedInputTokens: integer(inputDetails?.cached_tokens),
      outputTokens: integer(usage.output_tokens),
      reasoningTokens: integer(outputDetails?.reasoning_tokens),
      actualModel: typeof response?.model === "string" ? response.model : undefined,
      usageSource: "provider_usage",
    };
  }
  return result;
}

function parseMessages(payloads: unknown[]): Omit<AlphaUsage, "providerCostUsd"> | undefined {
  let inputTokens = 0n;
  let cachedInputTokens = 0n;
  let outputTokens = 0n;
  let reasoningTokens = 0n;
  let actualModel: string | undefined;
  let found = false;
  for (const payload of payloads) {
    const root = object(payload);
    const message = object(root?.message) ?? root;
    const usage = object(root?.usage) ?? object(message?.usage);
    if (!usage) continue;
    found = true;
    inputTokens = integer(usage.input_tokens) || inputTokens;
    cachedInputTokens = integer(usage.cache_read_input_tokens) + integer(usage.cache_creation_input_tokens)
      || cachedInputTokens;
    outputTokens = integer(usage.output_tokens) || outputTokens;
    reasoningTokens = integer(usage.reasoning_tokens) || reasoningTokens;
    if (typeof message?.model === "string") actualModel = message.model;
  }
  return found ? {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    actualModel,
    usageSource: "provider_usage",
  } : undefined;
}

export function calculateProviderCost(
  modelId: string,
  inputTokens: bigint,
  cachedInputTokens: bigint,
  outputTokens: bigint,
): string {
  const model = getAcuModel(modelId);
  if (!model || model.inputPricePerMillion === null || model.outputPricePerMillion === null) return "0.0000000000";
  const uncached = inputTokens > cachedInputTokens ? inputTokens - cachedInputTokens : 0n;
  const cachedPrice = model.cachedInputPricePerMillion ?? model.inputPricePerMillion;
  const cost = (
    Number(uncached) * model.inputPricePerMillion
    + Number(cachedInputTokens) * cachedPrice
    + Number(outputTokens) * model.outputPricePerMillion
  ) / 1_000_000;
  return cost.toFixed(10);
}

export function parseProviderUsage(input: {
  protocol: AlphaProtocol;
  body: Buffer;
  contentType: string;
  requestedModel: string;
  requestBytes: number;
}): AlphaUsage {
  const payloads = jsonPayloads(input.body, input.contentType);
  const parsed = input.protocol === "responses" ? parseResponses(payloads) : parseMessages(payloads);
  const usage = parsed ?? {
    inputTokens: BigInt(Math.ceil(input.requestBytes / 4)),
    cachedInputTokens: 0n,
    outputTokens: BigInt(Math.ceil(input.body.length / 4)),
    reasoningTokens: 0n,
    usageSource: "response_text_estimate" as const,
  };
  return {
    ...usage,
    providerCostUsd: calculateProviderCost(
      input.requestedModel,
      usage.inputTokens,
      usage.cachedInputTokens,
      usage.outputTokens,
    ),
  };
}

export function sumCost(...values: Array<string | undefined>): string {
  return values.reduce((sum, value) => sum + Number(value ?? 0), 0).toFixed(10);
}
