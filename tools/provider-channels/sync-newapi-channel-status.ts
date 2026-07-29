#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const catalogPath = resolve("deploy/alpha/newapi-acu-catalog.json");
const profiles = JSON.parse(await readFile(resolve("deploy/alpha/execution-profiles.json"), "utf8")) as Array<Record<string, unknown>>;
const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
  responses: Array<Record<string, unknown>>;
  curveModelStatuses: Array<Record<string, unknown>>;
};
for (const item of catalog.curveModelStatuses) {
  const modelId = String(item.modelId);
  const healthyChannels = new Set(profiles.filter((profile) => profile.modelId === modelId
    && profile.enabled === true && profile.health === "healthy").map((profile) => String(profile.channel)));
  item.healthyChannelCount = healthyChannels.size;
  item.temporarilyUnavailableReason = healthyChannels.size === 0
    ? `No active verified Channel (${(item.statuses as string[]).join(", ")})` : null;
}
for (const item of catalog.responses) {
  const modelId = String(item.modelId);
  const healthyChannels = new Set(profiles.filter((profile) => profile.modelId === modelId
    && profile.protocols instanceof Array && profile.protocols.includes("responses")
    && profile.enabled === true && profile.health === "healthy").map((profile) => String(profile.channel)));
  item.healthyChannelCount = healthyChannels.size;
  if (modelId === "gpt-5.6-luna" && healthyChannels.size > 1) item.provider = "Multi-provider";
}
await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(JSON.stringify({ curveModels: catalog.curveModelStatuses.length,
  modelsWithHealthyChannel: catalog.curveModelStatuses.filter((item) => Number(item.healthyChannelCount) > 0).length }));
