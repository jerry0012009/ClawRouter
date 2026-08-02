import type { ProfileBillingPrice } from "./routing.js";

export type PricingDisplayMode = "payable_only" | "reference_only" | "comparison";

export type PublicReferenceSource = {
  vendor: string;
  models: string[];
  nativeUnit?: "CNY per 1M tokens";
  status?: string;
};

export type PublicReferencePrice = {
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cachedInputPricePerMillion?: number | null;
  currency: "USD" | "CNY";
};

export function parsePricingDisplayMode(value: string | undefined): PricingDisplayMode {
  const mode = value?.trim() || "comparison";
  if (mode === "payable_only" || mode === "reference_only" || mode === "comparison") return mode;
  throw new Error("ACU_PRICING_DISPLAY_MODE must be payable_only, reference_only, or comparison");
}

export function parseReferenceUsdCny(value: string | undefined): number {
  const rate = value?.trim() ? Number(value) : 7.2;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("ACU_PRICING_REFERENCE_USD_CNY must be a finite positive number");
  }
  return rate;
}

export function selectPublicReferenceSource(
  modelId: string,
  sources: PublicReferenceSource[],
): PublicReferenceSource | undefined {
  const candidates = sources.filter((source) => source.models.includes(modelId));
  return candidates.find((source) => source.vendor !== "OpenRouter")
    ?? candidates.find((source) => source.vendor === "OpenRouter");
}

export function buildReferencePricing(input: {
  price: PublicReferencePrice;
  source: PublicReferenceSource | undefined;
  observedAt: string;
  fxCnyPerUsd: number;
}): Record<string, unknown> | undefined {
  if (!input.source || input.source.status === "not_normalized_in_flat_usd_catalog") return undefined;
  const multiplier = input.price.currency === "USD" ? input.fxCnyPerUsd : 1;
  const sourceType = input.source.vendor === "OpenRouter" ? "openrouter" : "official";
  return {
    inputCnyPerMillion: input.price.inputPricePerMillion * multiplier,
    outputCnyPerMillion: input.price.outputPricePerMillion * multiplier,
    ...(input.price.cachedInputPricePerMillion == null ? {} : {
      cachedInputCnyPerMillion: input.price.cachedInputPricePerMillion * multiplier,
    }),
    sourceType,
    sourceName: sourceType === "openrouter"
      ? "OpenRouter public pricing"
      : `${input.source.vendor} official pricing`,
    observedAt: input.observedAt,
    originalCurrency: input.price.currency,
    ...(input.price.currency === "USD" ? { fxCnyPerUsd: input.fxCnyPerUsd } : {}),
  };
}

type PayableProfileCandidate = {
  enabled?: boolean;
  administratorAllowed?: boolean;
  autoRouteEnabled?: boolean;
  health?: string;
  usageTrusted?: boolean;
  effectiveCostStatus?: string;
  cooldownUntil?: number | string;
};

export function selectPayableProfile<T extends PayableProfileCandidate>(
  profiles: T[],
  score: (profile: T) => number,
  nowMs = Date.now(),
): T | undefined {
  return profiles
    .filter((profile) => profile.enabled === true
      && profile.administratorAllowed === true
      && profile.autoRouteEnabled !== false
      && profile.health === "healthy"
      && profile.usageTrusted !== false
      && profile.effectiveCostStatus !== "missing"
      && (profile.cooldownUntil === undefined || Number(profile.cooldownUntil) <= nowMs))
    .sort((left, right) => score(left) - score(right))[0];
}

export function buildPayablePricing(input: {
  billingPrice: Pick<ProfileBillingPrice, "inputPricePerMillion" | "outputPricePerMillion"
    | "cachedInputPricePerMillion"> & { cacheWritePricePerMillion?: number; status?: "verified" | "estimated" };
  cashCnyPerNominalUsd: number;
  retailMarkupMultiplier: number;
  effectiveCostStatus: string | undefined;
  pricingPolicyVersion: string;
}): Record<string, unknown> {
  const multiplier = input.cashCnyPerNominalUsd * input.retailMarkupMultiplier;
  const status = input.billingPrice.status === "verified" && input.effectiveCostStatus === "verified"
    ? "verified" : "estimated";
  return {
    inputCnyPerMillion: input.billingPrice.inputPricePerMillion * multiplier,
    outputCnyPerMillion: input.billingPrice.outputPricePerMillion * multiplier,
    ...(input.billingPrice.cachedInputPricePerMillion == null ? {} : {
      cachedInputCnyPerMillion: input.billingPrice.cachedInputPricePerMillion * multiplier,
    }),
    status,
    pricingPolicyVersion: input.pricingPolicyVersion,
  };
}
