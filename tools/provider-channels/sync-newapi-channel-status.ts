#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildModelCurve, getAcuCatalog, getAcuModel } from "../../src/acu/catalog.js";
import {
  buildPayablePricing,
  buildReferencePricing,
  parsePricingDisplayMode,
  parseReferenceUsdCny,
  selectPayableProfile,
  selectPublicReferenceSource,
} from "../../src/alpha/pricing-view.js";
import {
  DEFAULT_BILLING_POLICY_VERSION,
  parseRetailMarkupMultiplier,
} from "../../src/alpha/retail-charge.js";

const catalogPath = resolve("deploy/alpha/newapi-acu-catalog.json");
const sourceCatalogPath = resolve("src/acu/catalog/model-catalog.json");
const sourceCatalogBody = await readFile(sourceCatalogPath);
const sourceCatalog = JSON.parse(sourceCatalogBody.toString("utf8")) as {
  schemaVersion: string;
  generatedAt: string;
  priceVersion: string;
};
const referenceSources = JSON.parse(await readFile(resolve("deploy/alpha/official-price-sources.json"), "utf8")) as {
  observedAt: string;
  sources: Array<{ vendor: string; models: string[]; nativeUnit?: "CNY per 1M tokens"; status?: string }>;
};
const profiles = JSON.parse(await readFile(resolve("deploy/alpha/execution-profiles.json"), "utf8")) as Array<Record<string, unknown>>;
const economicsCatalog = JSON.parse(await readFile(resolve("deploy/alpha/provider-economics.json"), "utf8")) as {
  providers: Array<Record<string, unknown>>;
};
const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
  sourceCatalogVersion: string;
  sourceCatalogContentSha256?: string;
  pricingVersion: string;
  generatedAt?: string;
  displayMode?: string;
  referenceFxCnyPerUsd?: number;
  responses: Array<Record<string, unknown>>;
  curveModelStatuses: Array<Record<string, unknown>>;
};
catalog.sourceCatalogVersion = sourceCatalog.schemaVersion;
catalog.sourceCatalogContentSha256 = createHash("sha256").update(sourceCatalogBody).digest("hex");
catalog.pricingVersion = sourceCatalog.priceVersion;
catalog.generatedAt = sourceCatalog.generatedAt;
catalog.displayMode = parsePricingDisplayMode(process.env.ACU_PRICING_DISPLAY_MODE);
catalog.referenceFxCnyPerUsd = parseReferenceUsdCny(process.env.ACU_PRICING_REFERENCE_USD_CNY);
const retailMarkupMultiplier = parseRetailMarkupMultiplier(process.env.ACU_RETAIL_MARKUP_MULTIPLIER);
const pricingPolicyVersion = process.env.ACU_BILLING_POLICY_VERSION?.trim() || DEFAULT_BILLING_POLICY_VERSION;
const economicsByProvider = new Map(economicsCatalog.providers.map((provider) => [String(provider.providerId), provider]));
function activeProfiles(modelId: string, responsesOnly: boolean): Array<Record<string, unknown>> {
  return profiles.filter((profile) => profile.modelId === modelId
    && (!responsesOnly || (profile.protocols instanceof Array && profile.protocols.includes("responses")))
    && profile.enabled === true && profile.health === "healthy");
}

function effectiveCostStatuses(items: Array<Record<string, unknown>>): string[] {
  return [...new Set(items.map((profile) => String(profile.effectiveCostStatus ?? "missing")))]
    .filter((status) => status === "estimated" || status === "verified")
    .sort();
}

function profileCashCnyPerNominalUsd(profile: Record<string, unknown>): number {
  const economics = economicsByProvider.get(String(profile.economicsProviderId ?? profile.provider));
  const rechargeCashCny = Number(economics?.rechargeCashCny);
  const creditsReceivedUsd = Number(economics?.creditsReceivedUsd);
  const multiplier = Number(profile.observedBillingMultiplier ?? economics?.observedBillingMultiplier);
  if (![rechargeCashCny, creditsReceivedUsd, multiplier].every((value) => Number.isFinite(value) && value > 0)) {
    return Number.POSITIVE_INFINITY;
  }
  return multiplier * rechargeCashCny / creditsReceivedUsd;
}

function profileTokenPrices(profile: Record<string, unknown>, model: {
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cachedInputPricePerMillion: number | null;
}): { input: number; output: number; cacheRead: number } {
  const billing = profile.billingPrice && typeof profile.billingPrice === "object"
    ? profile.billingPrice as Record<string, unknown> : undefined;
  const input = Number(billing?.inputPricePerMillion ?? model.inputPricePerMillion);
  const output = Number(billing?.outputPricePerMillion ?? model.outputPricePerMillion);
  const cacheRead = Number(billing?.cachedInputPricePerMillion ?? model.cachedInputPricePerMillion ?? input);
  return { input, output, cacheRead };
}

function profileReferenceScore(profile: Record<string, unknown>, model: {
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cachedInputPricePerMillion: number | null;
}): number {
  const cashMultiplier = profileCashCnyPerNominalUsd(profile);
  const prices = profileTokenPrices(profile, model);
  const healthFactor = profile.health === "degraded" ? 1.2 : profile.health === "unknown" ? 1.1 : 1;
  const successRate = Math.max(0.5, Math.min(1, Number(profile.recentSuccessRate ?? 1)));
  const latencyFactor = 1 + Math.min(0.05, Math.max(0, Number(profile.observedLatencyMs ?? 0)) / 1_200_000);
  return (prices.input + prices.output) * cashMultiplier * healthFactor * latencyFactor / successRate;
}

function referenceProfile(items: Array<Record<string, unknown>>, model: {
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  cachedInputPricePerMillion: number | null;
}): Record<string, unknown> | undefined {
  return selectPayableProfile(items, (profile) => profileReferenceScore(profile, model));
}

const active = profiles.filter((profile) => profile.enabled === true
  && profile.administratorAllowed === true && profile.autoRouteEnabled !== false);
const activeModelIds = [...new Set(active.map((profile) => String(profile.modelId)))].sort();
const existingResponses = new Map(catalog.responses.map((item) => [String(item.modelId), item]));
const existingStatuses = new Map(catalog.curveModelStatuses.map((item) => [String(item.modelId), item]));
catalog.curveModelStatuses = getAcuCatalog().models.map((model) => existingStatuses.get(model.modelId) ?? {
  modelId: model.modelId,
  statuses: [],
  healthyChannelCount: 0,
  temporarilyUnavailableReason: "No active verified Channel",
  effectiveCostStatuses: [],
});
catalog.responses = activeModelIds.map((modelId) => {
  const model = getAcuModel(modelId);
  if (!model || model.inputPricePerMillion === null || model.outputPricePerMillion === null) {
    throw new Error(`Routing-active model ${modelId} has no catalog pricing`);
  }
  const modelProfiles = active.filter((profile) => profile.modelId === modelId);
  const protocols = [...new Set(modelProfiles.flatMap((profile) => profile.protocols instanceof Array
    ? profile.protocols.map(String) : []))].sort();
  const channels = new Set(modelProfiles.map((profile) => String(profile.channelId ?? profile.channel)));
  const existing = existingResponses.get(modelId);
  const healthyProfiles = activeProfiles(modelId, false);
  const costProfile = referenceProfile(healthyProfiles, model);
  const cashMultiplier = costProfile ? profileCashCnyPerNominalUsd(costProfile) : Number.NaN;
  if (!costProfile || !Number.isFinite(cashMultiplier)) {
    throw new Error(`Routing-active model ${modelId} has no healthy Profile with usable CNY economics`);
  }
  const profilePrices = profileTokenPrices(costProfile, model);
  const effectiveCostStatus = costProfile?.effectiveCostStatus === "verified" ? "verified" : "estimated";
  const billing = costProfile.billingPrice && typeof costProfile.billingPrice === "object"
    ? costProfile.billingPrice as Record<string, unknown> : undefined;
  const payable = buildPayablePricing({
    billingPrice: {
      inputPricePerMillion: profilePrices.input,
      outputPricePerMillion: profilePrices.output,
      cachedInputPricePerMillion: profilePrices.cacheRead,
      status: billing?.status === "verified" ? "verified" : "estimated",
    },
    cashCnyPerNominalUsd: cashMultiplier,
    retailMarkupMultiplier,
    effectiveCostStatus,
    pricingPolicyVersion,
  });
  const referenceSource = selectPublicReferenceSource(modelId, referenceSources.sources);
  const reference = buildReferencePricing({
    price: {
      inputPricePerMillion: model.inputPricePerMillion,
      outputPricePerMillion: model.outputPricePerMillion,
      cachedInputPricePerMillion: model.cachedInputPricePerMillion,
      currency: referenceSource?.nativeUnit === "CNY per 1M tokens" ? "CNY" : "USD",
    },
    source: referenceSource,
    observedAt: referenceSources.observedAt,
    fxCnyPerUsd: catalog.referenceFxCnyPerUsd,
  });
  return {
    modelId,
    displayName: model.displayName,
    role: modelProfiles.some((profile) => profile.verificationStatus === "verified_provisional")
      ? "Verified Provisional"
      : existing?.role ?? String(modelProfiles[0]?.capabilityTier ?? "Verified"),
    inputPricePerMillion: model.inputPricePerMillion,
    outputPricePerMillion: model.outputPricePerMillion,
    cachedInputPricePerMillion: model.cachedInputPricePerMillion ?? model.inputPricePerMillion,
    effectiveInputPriceCnyPerMillion: payable.inputCnyPerMillion,
    effectiveOutputPriceCnyPerMillion: payable.outputCnyPerMillion,
    effectiveCachedInputPriceCnyPerMillion: payable.cachedInputCnyPerMillion,
    costCurrency: "CNY",
    costSemantics: "estimated_user_payable_price",
    payable,
    ...(reference ? { reference } : {}),
    effectiveCostStatus,
    curveProfile: model.curveProfile,
    profileConfidence: model.profileConfidence,
    curve: buildModelCurve(model).map(({ difficultyScore, estimatedQuality, qualityLower, qualityUpper }) => ({
      difficultyScore, estimatedQuality, qualityLower, qualityUpper,
    })),
    protocol: protocols.map((protocol) => protocol === "responses" ? "Responses" : "Messages").join(" + "),
    toolCall: modelProfiles.every((profile) => profile.toolCallSupport === true),
    reasoning: modelProfiles.every((profile) => profile.thinkingSupport === true),
    activeInAcuAuto: true,
    status: "routing_active",
  };
});

for (const item of catalog.curveModelStatuses) {
  const modelId = String(item.modelId);
  const routedProfiles = active.filter((profile) => profile.modelId === modelId);
  if (routedProfiles.length > 0) {
    const protocols = new Set(routedProfiles.flatMap((profile) => profile.protocols instanceof Array
      ? profile.protocols.map(String) : []));
    item.statuses = [
      ...(protocols.has("responses") ? ["active_responses"] : []),
      ...(protocols.has("messages") ? ["active_messages"] : []),
    ];
  }
  const healthyProfiles = activeProfiles(modelId, (item.statuses as string[]).includes("active_responses"));
  const healthyChannels = new Set(healthyProfiles.map((profile) => String(profile.channel)));
  item.healthyChannelCount = healthyChannels.size;
  item.effectiveCostStatuses = effectiveCostStatuses(healthyProfiles);
  item.temporarilyUnavailableReason = healthyChannels.size === 0
    ? `No active verified Channel (${(item.statuses as string[]).join(", ")})` : null;
}
await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(JSON.stringify({ curveModels: catalog.curveModelStatuses.length,
  modelsWithHealthyChannel: catalog.curveModelStatuses.filter((item) => Number(item.healthyChannelCount) > 0).length }));
