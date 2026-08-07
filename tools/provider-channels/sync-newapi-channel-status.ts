#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

const templateCatalogPath = resolve("deploy/alpha/newapi-acu-catalog.json");
const catalogPath = resolve(process.env.ACU_PRICING_RUNTIME_CATALOG_FILE?.trim()
  || "/var/lib/acu/pricing/newapi-acu-catalog.json");
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
let catalog: {
  sourceCatalogVersion: string;
  sourceCatalogContentSha256?: string;
  pricingVersion: string;
  generatedAt?: string;
  displayMode?: string;
  referenceFxCnyPerUsd?: number;
  responses: Array<Record<string, any>>;
  curveModelStatuses: Array<Record<string, unknown>>;
  sourceCatalogGeneratedAt?: string;
  runtimeRefreshedAt?: string;
};
try {
  catalog = JSON.parse(await readFile(catalogPath, "utf8"));
} catch {
  catalog = JSON.parse(await readFile(templateCatalogPath, "utf8"));
}
catalog.sourceCatalogVersion = sourceCatalog.schemaVersion;
catalog.sourceCatalogContentSha256 = createHash("sha256").update(sourceCatalogBody).digest("hex");
catalog.pricingVersion = sourceCatalog.priceVersion;
catalog.sourceCatalogGeneratedAt = sourceCatalog.generatedAt;
catalog.runtimeRefreshedAt = new Date().toISOString();
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
const runtimeProfiles: Array<Record<string, any>> = profiles.map((profile) => ({
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

function configuredProfiles(modelId: string, protocol: "responses" | "messages"): Array<Record<string, any>> {
  return runtimeProfiles.filter((profile) => profile.modelId === modelId
    && profile.enabled === true && profile.administratorAllowed === true
    && profile.autoRouteEnabled !== false
    && Array.isArray(profile.protocols) && profile.protocols.includes(protocol));
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

const configured = runtimeProfiles.filter((profile) => profile.enabled === true
  && profile.administratorAllowed === true && profile.autoRouteEnabled !== false
  && getAcuModel(String(profile.modelId))?.routingEligible === true);
const configuredModelIds = [...new Set(configured.map((profile) => String(profile.modelId)))].sort();
const messagesModelIds = [...new Set(configured
  .filter((profile) => Array.isArray(profile.protocols) && profile.protocols.includes("messages")
    && eligibleProfileIds.has(String(profile.executionProfileId)))
  .map((profile) => String(profile.modelId)))].sort();
const existingResponses = new Map(catalog.responses.map((item) => [String(item.modelId), item]));
const existingStatuses = new Map(catalog.curveModelStatuses.map((item) => [String(item.modelId), item]));
catalog.curveModelStatuses = getAcuCatalog().models
  .filter((model) => configuredModelIds.includes(model.modelId))
  .map((model) => existingStatuses.get(model.modelId) ?? {
  modelId: model.modelId,
  statuses: [],
  healthyChannelCount: 0,
  temporarilyUnavailableReason: "No active verified Channel",
  effectiveCostStatuses: [],
  });
catalog.responses = configuredModelIds.map((modelId) => {
  const model = getAcuModel(modelId);
  if (!model || model.inputPricePerMillion === null || model.outputPricePerMillion === null) {
    throw new Error(`Routing-active model ${modelId} has no catalog pricing`);
  }
  const modelProfiles = configured.filter((profile) => profile.modelId === modelId);
  const protocols = [...new Set(modelProfiles.flatMap((profile) => profile.protocols instanceof Array
    ? profile.protocols.map(String) : []))].filter((value): value is "responses" | "messages" => value === "responses" || value === "messages").sort();
  const existing = existingResponses.get(modelId);
  const protocolPrices: Record<string, Record<string, any>> = Object.fromEntries(protocols.map((protocol) => {
    const router = routerPricing.get(`${protocol}:${modelId}`);
    const old = existing?.payableByProtocol?.[protocol];
    const source = router ?? old ?? existing?.payable ?? {
      inputPriceCnyPerMillion: model.inputPricePerMillion,
      outputPriceCnyPerMillion: model.outputPricePerMillion,
      cachedInputCnyPerMillion: model.cachedInputPricePerMillion,
      effectiveCostStatus: "estimated",
    };
    return [protocol, source];
  }).filter(([, value]) => Boolean(value)));
  if (Object.keys(protocolPrices).length === 0) throw new Error(`Router has no pricing result for ${modelId}`);
  // Router owns Profile V2.2 selection and effective-cost calculation. New API
  // only publishes the exact values returned by Router; it does not recompute
  // provider economics, channel multipliers, or select a Profile itself.
  const payableByProtocol: Record<string, Record<string, any>> = Object.fromEntries(Object.entries(protocolPrices).map(([protocol, price]) => [protocol, {
    inputCnyPerMillion: Number(price.payableInputPriceCnyPerMillion ?? price.inputCnyPerMillion ?? price.inputPriceCnyPerMillion),
    outputCnyPerMillion: Number(price.payableOutputPriceCnyPerMillion ?? price.outputCnyPerMillion ?? price.outputPriceCnyPerMillion),
    ...(price.payableCachedInputPriceCnyPerMillion == null && price.cachedInputCnyPerMillion == null ? {} : {
      cachedInputCnyPerMillion: Number(price.payableCachedInputPriceCnyPerMillion ?? price.cachedInputCnyPerMillion),
    }),
    ...(price.payableCacheWritePriceCnyPerMillion == null ? {} : { cacheWriteCnyPerMillion: Number(price.payableCacheWritePriceCnyPerMillion) }),
    status: price.effectiveCostStatus === "verified" ? "verified" : "estimated",
    pricingPolicyVersion: process.env.ACU_BILLING_POLICY_VERSION?.trim() || "acu-retail-v1",
  }]));
  const representative = Object.values(payableByProtocol).reduce((left, right) =>
    Number(left.inputCnyPerMillion) + Number(left.outputCnyPerMillion)
      <= Number(right.inputCnyPerMillion) + Number(right.outputCnyPerMillion) ? left : right);
  const effectiveInput = Number(representative.inputCnyPerMillion);
  const effectiveOutput = Number(representative.outputCnyPerMillion);
  const effectiveCostStatus = Object.values(protocolPrices).every((item) => item.effectiveCostStatus === "verified")
    ? "verified" : "estimated";
  const payable = {
    inputCnyPerMillion: effectiveInput,
    outputCnyPerMillion: effectiveOutput,
    status: effectiveCostStatus,
    pricingPolicyVersion: process.env.ACU_BILLING_POLICY_VERSION?.trim() || "acu-retail-v1",
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
    cachedInputPricePerMillion: model.cachedInputPricePerMillion,
    effectiveInputPriceCnyPerMillion: effectiveInput,
    effectiveOutputPriceCnyPerMillion: effectiveOutput,
    effectiveCachedInputPriceCnyPerMillion: representative.cachedInputCnyPerMillion,
    payableByProtocol,
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
    activeInAcuAuto: protocols.some((protocol) => configuredProfiles(modelId, protocol).some((profile) => eligibleProfileIds.has(String(profile.executionProfileId)))),
    status: protocols.some((protocol) => configuredProfiles(modelId, protocol).some((profile) => eligibleProfileIds.has(String(profile.executionProfileId)))) ? "routing_active" : "temporarily_unavailable",
    currentlyEligible: protocols.some((protocol) => configuredProfiles(modelId, protocol).some((profile) => eligibleProfileIds.has(String(profile.executionProfileId)))),
    temporarilyUnavailableReason: protocols.some((protocol) => configuredProfiles(modelId, protocol).some((profile) => eligibleProfileIds.has(String(profile.executionProfileId)))) ? null : "all configured Profiles temporarily unavailable",
    healthyChannelCount: new Set(modelProfiles.filter((profile) => eligibleProfileIds.has(String(profile.executionProfileId))).map((profile) => String(profile.channelId ?? profile.channel))).size,
  };
});

for (const item of catalog.curveModelStatuses) {
  const modelId = String(item.modelId);
  const routedProfiles = configured.filter((profile) => profile.modelId === modelId);
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
await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(catalogPath), { recursive: true }));
const temporaryCatalogPath = `${catalogPath}.tmp`;
await writeFile(temporaryCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
await rename(temporaryCatalogPath, catalogPath);
const newApiDatabaseUrl = process.env.ACU_NEWAPI_DATABASE_URL?.trim();
if (newApiDatabaseUrl) {
  const pool = new pg.Pool({ connectionString: newApiDatabaseUrl, max: 1, application_name: "newapi-messages-ability-sync" });
  try {
    const publishedMessages = ["acu-auto", ...messagesModelIds.filter((modelId) => modelId !== "acu-auto")];
    const models = publishedMessages.join(",");
    await pool.query("BEGIN");
    await pool.query("UPDATE channels SET models = $1, header_override = $2 WHERE name = 'ACU Messages Alpha'", [models, '{"*":""}']);
    const channel = await pool.query<{ id: number }>("SELECT id FROM channels WHERE name = 'ACU Messages Alpha' LIMIT 1");
    if (channel.rows[0]) {
      await pool.query("DELETE FROM abilities WHERE channel_id = $1 AND tag = 'acu-router'", [channel.rows[0].id]);
      for (const modelId of publishedMessages) {
        await pool.query(
          `INSERT INTO abilities ("group", model, channel_id, enabled, priority, weight, tag)
           VALUES ('default', $1, $2, true, 0, 0, 'acu-router')
           ON CONFLICT ("group", model, channel_id) DO UPDATE SET enabled = true, tag = 'acu-router'`,
          [modelId, channel.rows[0].id],
        );
      }
    }
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
}
console.log(JSON.stringify({ curveModels: catalog.curveModelStatuses.length,
  modelsWithHealthyChannel: catalog.curveModelStatuses.filter((item) => Number(item.healthyChannelCount) > 0).length,
  messagesModels: ["acu-auto", ...messagesModelIds.filter((modelId) => modelId !== "acu-auto")] }));
