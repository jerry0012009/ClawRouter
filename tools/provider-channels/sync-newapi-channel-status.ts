#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { buildModelCurve, getAcuCatalog, getAcuModel } from "../../src/acu/catalog.js";
import {
  buildReferencePricing,
  parsePricingDisplayMode,
  parseReferenceUsdCny,
  selectPublicReferenceSource,
} from "../../src/alpha/pricing-view.js";
import { monitorRoutingStatus, type MonitorHealthRow } from "../../src/alpha/channel-monitor.js";
import type { ConfiguredExecutionProfile } from "../../src/alpha/server.js";

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

type RuntimeHealth = {
  execution_profile_id?: string;
  circuit_state?: string;
  recent_success_rate?: number;
  total_latency_ms?: number;
  usage_trusted?: boolean;
  actual_model_verified?: boolean;
  cooldown_until?: string | Date | null;
};

const runtimeHealth = new Map<string, RuntimeHealth>();
const channelHealth = new Map<string, MonitorHealthRow>();
const runtimeDatabaseUrl = process.env.ACU_PRICING_RUNTIME_DATABASE_URL?.trim();
if (!runtimeDatabaseUrl) {
  throw new Error("ACU_PRICING_RUNTIME_DATABASE_URL is required to publish routing-aware pricing");
}
{
  const pool = new pg.Pool({ connectionString: runtimeDatabaseUrl, max: 1, application_name: "newapi-pricing-sync" });
  try {
    const result = await pool.query<RuntimeHealth & { execution_profile_id: string }>(
      `SELECT execution_profile_id, circuit_state, recent_success_rate, total_latency_ms,
              usage_trusted, actual_model_verified, cooldown_until
         FROM acu_provider_model_profile_health`,
    );
    for (const row of result.rows) runtimeHealth.set(row.execution_profile_id, row);
    const channels = await pool.query<MonitorHealthRow>(
      "SELECT channel_id, circuit_state, cooldown_until FROM acu_channel_health",
    );
    for (const row of channels.rows) channelHealth.set(String(row.channel_id), row);
  } finally {
    await pool.end();
  }
}

const eligibleProfileIds = new Set(profiles.filter((profile) =>
  monitorRoutingStatus(
    profile as ConfiguredExecutionProfile,
    channelHealth.get(String(profile.channelId ?? profile.channel)) ?? {},
    runtimeHealth.get(String(profile.executionProfileId)) as MonitorHealthRow ?? {},
  ) === "eligible",
).map((profile) => String(profile.executionProfileId)));
const runtimeProfiles = profiles.map((profile) => ({
  ...profile,
  recentSuccessRate: runtimeHealth.get(String(profile.executionProfileId))?.recent_success_rate
    ?? profile.recentSuccessRate,
  observedLatencyMs: runtimeHealth.get(String(profile.executionProfileId))?.total_latency_ms
    ?? profile.observedLatencyMs,
  usageTrusted: runtimeHealth.get(String(profile.executionProfileId))?.usage_trusted
    ?? profile.usageTrusted,
}));

function activeProfiles(modelId: string, responsesOnly: boolean): Array<Record<string, unknown>> {
  return runtimeProfiles.filter((profile) => profile.modelId === modelId
    && (!responsesOnly || (profile.protocols instanceof Array && profile.protocols.includes("responses")))
    && profile.enabled === true && eligibleProfileIds.has(String(profile.executionProfileId)));
}

function effectiveCostStatuses(items: Array<Record<string, unknown>>): string[] {
  return [...new Set(items.map((profile) => String(profile.effectiveCostStatus ?? "missing")))]
    .filter((status) => status === "estimated" || status === "verified")
    .sort();
}

const routerUrl = process.env.ACU_ROUTER_INTERNAL_URL?.trim();
const routerToken = process.env.ACU_ADMIN_TRACE_TOKEN?.trim();
if (!routerUrl || !routerToken) throw new Error("ACU_ROUTER_INTERNAL_URL and ACU_ADMIN_TRACE_TOKEN are required");
const routerPricing = new Map<string, Record<string, any>>();
for (const protocol of ["responses", "messages"] as const) {
  const response = await fetch(`${routerUrl}/internal/admin/selection-corridor`, {
    method: "POST",
    headers: { authorization: `Bearer ${routerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ protocol, inputTokens: 20_000, expectedOutputTokens: 2_000, routingPreference: "balanced", formulaMode: "active" }),
  });
  if (!response.ok) throw new Error(`Router selection corridor failed for ${protocol}: ${response.status}`);
  const body = await response.json() as { pricing?: Record<string, Record<string, unknown>> };
  for (const [modelId, pricing] of Object.entries(body.pricing ?? {})) {
    routerPricing.set(`${protocol}:${modelId}`, pricing);
  }
}

const active = runtimeProfiles.filter((profile) => profile.enabled === true
  && profile.administratorAllowed === true && profile.autoRouteEnabled !== false
  && eligibleProfileIds.has(String(profile.executionProfileId)));
const activeModelIds = [...new Set(active.map((profile) => String(profile.modelId)))].sort();
const existingResponses = new Map(catalog.responses.map((item) => [String(item.modelId), item]));
const existingStatuses = new Map(catalog.curveModelStatuses.map((item) => [String(item.modelId), item]));
catalog.curveModelStatuses = getAcuCatalog().models
  .filter((model) => activeModelIds.includes(model.modelId))
  .map((model) => existingStatuses.get(model.modelId) ?? {
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
  const protocolPrices = protocols
    .map((protocol) => routerPricing.get(`${protocol}:${modelId}`))
    .filter((value): value is Record<string, any> => Boolean(value));
  if (protocolPrices.length === 0) throw new Error(`Router has no pricing result for ${modelId}`);
  // Router owns Profile V2.2 selection and effective-cost calculation. New API
  // only publishes the exact values returned by Router; it does not recompute
  // provider economics, channel multipliers, or select a Profile itself.
  const representative = protocolPrices.reduce((left, right) =>
    Number(left.inputPriceCnyPerMillion) + Number(left.outputPriceCnyPerMillion)
      <= Number(right.inputPriceCnyPerMillion) + Number(right.outputPriceCnyPerMillion) ? left : right);
  const effectiveInput = Number(representative.inputPriceCnyPerMillion);
  const effectiveOutput = Number(representative.outputPriceCnyPerMillion);
  const effectiveCostStatus = protocolPrices.every((item) => item.effectiveCostStatus === "verified")
    ? "verified" : "estimated";
  const payable = {
    inputCnyPerMillion: effectiveInput,
    outputCnyPerMillion: effectiveOutput,
    status: effectiveCostStatus,
    pricingPolicyVersion: "router_profile_v2.2",
  };
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
    effectiveInputPriceCnyPerMillion: effectiveInput,
    effectiveOutputPriceCnyPerMillion: effectiveOutput,
    effectiveCachedInputPriceCnyPerMillion: effectiveInput,
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
const temporaryCatalogPath = `${catalogPath}.tmp`;
await writeFile(temporaryCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
await rename(temporaryCatalogPath, catalogPath);
console.log(JSON.stringify({ curveModels: catalog.curveModelStatuses.length,
  modelsWithHealthyChannel: catalog.curveModelStatuses.filter((item) => Number(item.healthyChannelCount) > 0).length }));
