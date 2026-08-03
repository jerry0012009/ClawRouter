import { getAcuModel } from "../acu/catalog.js";
import type { CanonicalEnvelope } from "./protocol/types.js";

export type ContextEstimationMethod = "structured_conservative_v2";

export type ContextAdmissionEstimate = {
  estimatedInputTokens: number;
  estimationMethod: ContextEstimationMethod;
  requestedMaxOutputTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  requiredTotalContextTokens: number;
};

const CANONICAL_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5.4-mini": 400_000,
  "gpt-5.6-luna": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.5": 1_050_000,
};

export function canonicalAdvertisedContextWindow(modelId: string): number {
  return CANONICAL_CONTEXT_WINDOWS[modelId] ?? getAcuModel(modelId)?.contextWindow ?? 32_768;
}

function textTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 3) + nonAscii * 2;
}

function structuredTokens(value: unknown): number {
  if (value === null || value === undefined) return 1;
  if (typeof value === "string") return textTokens(value) + 2;
  if (typeof value === "number" || typeof value === "boolean") return textTokens(String(value)) + 1;
  if (Array.isArray(value)) return 2 + value.reduce((sum, item) => sum + structuredTokens(item) + 1, 0);
  if (typeof value === "object") {
    return 2 + Object.entries(value as Record<string, unknown>)
      .reduce((sum, [key, item]) => sum + textTokens(key) + structuredTokens(item) + 2, 0);
  }
  return textTokens(String(value)) + 1;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function estimateContextAdmission(
  envelope: CanonicalEnvelope,
  defaultReservedOutputTokens: number,
): ContextAdmissionEstimate {
  const requestedMaxOutputTokens = nonNegativeInteger(envelope.raw.max_output_tokens)
    ?? nonNegativeInteger(envelope.raw.max_tokens)
    ?? 0;
  const reservedOutputTokens = Math.max(requestedMaxOutputTokens, defaultReservedOutputTokens);
  const estimatedInputTokens = Math.max(1, structuredTokens(envelope.raw));
  const safetyMarginTokens = Math.max(256, Math.ceil(estimatedInputTokens * 0.02));
  return {
    estimatedInputTokens,
    estimationMethod: "structured_conservative_v2",
    requestedMaxOutputTokens,
    reservedOutputTokens,
    safetyMarginTokens,
    requiredTotalContextTokens: estimatedInputTokens + reservedOutputTokens + safetyMarginTokens,
  };
}

export function effectiveContextCeiling(profile: {
  modelId: string;
  canonicalAdvertisedContextWindow?: number;
  providerHardContextCap?: number | null;
  contextCapabilityStatus?: "verified" | "observed_floor" | "unverified_long_context" | "provider_capped";
}): number {
  return profile.providerHardContextCap === null || profile.providerHardContextCap === undefined
    ? Number.MAX_SAFE_INTEGER
    : profile.providerHardContextCap;
}
