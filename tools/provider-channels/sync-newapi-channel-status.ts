#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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
for (const item of catalog.curveModelStatuses) {
  const modelId = String(item.modelId);
  const healthyProfiles = activeProfiles(modelId, (item.statuses as string[]).includes("active_responses"));
  const healthyChannels = new Set(healthyProfiles.map((profile) => String(profile.channel)));
  item.healthyChannelCount = healthyChannels.size;
  item.effectiveCostStatuses = effectiveCostStatuses(healthyProfiles);
  item.temporarilyUnavailableReason = healthyChannels.size === 0
    ? `No active verified Channel (${(item.statuses as string[]).join(", ")})` : null;
}
for (const item of catalog.responses) {
  const modelId = String(item.modelId);
  const healthyProfiles = activeProfiles(modelId, true);
  const healthyChannels = new Set(healthyProfiles.map((profile) => String(profile.channel)));
  item.healthyChannelCount = healthyChannels.size;
  item.effectiveCostStatuses = effectiveCostStatuses(healthyProfiles);
  if (modelId === "gpt-5.6-luna" && healthyChannels.size > 1) item.provider = "Multi-provider";
}
await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(JSON.stringify({ curveModels: catalog.curveModelStatuses.length,
  modelsWithHealthyChannel: catalog.curveModelStatuses.filter((item) => Number(item.healthyChannelCount) > 0).length }));
