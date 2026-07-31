#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAcuModel } from "../../src/acu/catalog.js";

const catalogPath = resolve("deploy/alpha/newapi-acu-catalog.json");
const profiles = JSON.parse(await readFile(resolve("deploy/alpha/execution-profiles.json"), "utf8")) as Array<Record<string, unknown>>;
const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
  responses: Array<Record<string, unknown>>;
  curveModelStatuses: Array<Record<string, unknown>>;
};
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

function displayProvider(providerIds: string[]): string {
  if (providerIds.length > 1) return "Multi-provider";
  const provider = providerIds[0] ?? "Unknown";
  return provider === "lucen" ? "Lucen" : provider === "blackai" ? "BlackAI"
    : provider === "closeai" ? "CloseAI" : provider;
}

const active = profiles.filter((profile) => profile.enabled === true
  && profile.administratorAllowed === true && profile.autoRouteEnabled !== false);
const activeModelIds = [...new Set(active.map((profile) => String(profile.modelId)))].sort();
const existingResponses = new Map(catalog.responses.map((item) => [String(item.modelId), item]));
catalog.responses = activeModelIds.map((modelId) => {
  const model = getAcuModel(modelId);
  if (!model || model.inputPricePerMillion === null || model.outputPricePerMillion === null) {
    throw new Error(`Routing-active model ${modelId} has no catalog pricing`);
  }
  const modelProfiles = active.filter((profile) => profile.modelId === modelId);
  const protocols = [...new Set(modelProfiles.flatMap((profile) => profile.protocols instanceof Array
    ? profile.protocols.map(String) : []))].sort();
  const channels = new Set(modelProfiles.map((profile) => String(profile.channelId ?? profile.channel)));
  const providers = [...new Set(modelProfiles.map((profile) => String(profile.provider)))].sort();
  const existing = existingResponses.get(modelId);
  return {
    modelId,
    role: existing?.role ?? String(modelProfiles[0]?.capabilityTier ?? "Verified"),
    inputPricePerMillion: model.inputPricePerMillion,
    outputPricePerMillion: model.outputPricePerMillion,
    cachedInputPricePerMillion: model.cachedInputPricePerMillion ?? model.inputPricePerMillion,
    protocol: protocols.map((protocol) => protocol === "responses" ? "Responses" : "Messages").join(" + "),
    toolCall: modelProfiles.every((profile) => profile.toolCallSupport === true),
    reasoning: modelProfiles.every((profile) => profile.thinkingSupport === true),
    activeInAcuAuto: true,
    provider: displayProvider(providers),
    status: "routing_active",
    healthyChannelCount: channels.size,
    effectiveCostStatuses: effectiveCostStatuses(modelProfiles),
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
for (const item of catalog.responses) {
  const modelId = String(item.modelId);
  const healthyProfiles = activeProfiles(modelId, false);
  const healthyChannels = new Set(healthyProfiles.map((profile) => String(profile.channel)));
  item.healthyChannelCount = healthyChannels.size;
  item.effectiveCostStatuses = effectiveCostStatuses(healthyProfiles);
}
await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(JSON.stringify({ curveModels: catalog.curveModelStatuses.length,
  modelsWithHealthyChannel: catalog.curveModelStatuses.filter((item) => Number(item.healthyChannelCount) > 0).length }));
