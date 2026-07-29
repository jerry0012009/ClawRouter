#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateProviderChannelRegistry, validateProviderModelProfiles } from "../../src/alpha/channel-registry.js";

const channelPath = resolve("deploy/alpha/provider-channels.json");
const discoveryPath = resolve("deploy/alpha/provider-channel-model-discovery.json");
const profilePath = resolve("deploy/alpha/provider-model-profiles.json");
const channels = validateProviderChannelRegistry(JSON.parse(await readFile(channelPath, "utf8")) as unknown);
const discovery = JSON.parse(await readFile(discoveryPath, "utf8")) as { channels: Array<{ channelId: string; status: string }> };
const profiles = validateProviderModelProfiles(JSON.parse(await readFile(profilePath, "utf8")) as unknown);
for (const channel of channels.channels) {
  const observed = discovery.channels.find((item) => item.channelId === channel.channelId);
  channel.discoveryStatus = observed?.status === "success" ? "success"
    : observed?.status === "auth_failed" ? "auth_failed"
      : observed?.status === "unavailable" ? "unavailable" : "failed";
  channel.activationStatus = profiles.profiles.some((item) => item.channelId === channel.channelId && item.activeInAcuAuto)
    ? "active" : "inactive";
}
validateProviderChannelRegistry(channels);
await writeFile(channelPath, `${JSON.stringify(channels, null, 2)}\n`);
console.log(JSON.stringify({ active: channels.channels.filter((item) => item.activationStatus === "active").length,
  inactive: channels.channels.filter((item) => item.activationStatus === "inactive").length }));
