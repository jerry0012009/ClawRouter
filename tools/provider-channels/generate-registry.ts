#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GROUP_SLUGS, inferMultiplier, inferProtocolCandidates, validateDotenv } from "./normalize-env.js";
import { validateProviderChannelRegistry, type ProviderChannelRegistry } from "../../src/alpha/channel-registry.js";

function assignments(text: string): Map<string, string> {
  validateDotenv(text);
  return new Map(text.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    return match ? [[match[1], match[2]]] : [];
  }));
}

function prefix(provider: string, slug: string): string {
  return `ACU_CHANNEL_${provider.toUpperCase()}_${slug.toUpperCase()}`;
}

async function main(): Promise<void> {
  const envPath = resolve(process.argv[2] ?? ".env");
  const outputPath = resolve(process.argv[3] ?? "deploy/alpha/provider-channels.json");
  const env = assignments(await readFile(envPath, "utf8"));
  const channels = Object.entries(GROUP_SLUGS).flatMap(([group, slug]) => {
    const providerId = env.has(`${prefix("lucen", slug)}_API_KEY`) ? "lucen"
      : env.has(`${prefix("blackai", slug)}_API_KEY`) ? "blackai" : undefined;
    if (!providerId) return [];
    const variablePrefix = prefix(providerId, slug);
    const observedBillingMultiplier = inferMultiplier(group);
    const rechargeRatio = providerId === "lucen" ? 1 : null;
    return [{
      channelId: `${providerId}-${slug.replaceAll("_", "-")}`,
      providerId,
      providerAccountId: `founder-${providerId}-account`,
      displayName: `${providerId === "lucen" ? "Lucen" : "BlackAI"} / ${group}`,
      routingGroupName: group,
      routingGroupSlug: slug,
      protocolCandidates: inferProtocolCandidates(group),
      apiKeyEnv: `${variablePrefix}_API_KEY`,
      primaryBaseUrlEnv: `${variablePrefix}_BASE_URL`,
      networkFallbackBaseUrlEnvs: [1, 2].map((index) => `${variablePrefix}_FALLBACK_${index}_BASE_URL`)
        .filter((name) => env.has(name)),
      rechargeCashRatioCnyPerCreditUsd: rechargeRatio,
      effectiveCostStatus: rechargeRatio === null ? "missing" as const : "estimated" as const,
      effectiveCostSource: rechargeRatio === null
        ? "Exact BlackAI purchase batch is not available in machine-readable configuration"
        : "Founder Lucen recharge batch CNY 500 for USD 500; group multiplier parsed from operator label",
      observedBillingMultiplier,
      multiplierStatus: observedBillingMultiplier === null ? "unknown" as const : "observed" as const,
      enabled: true,
      discoveryStatus: "pending" as const,
      activationStatus: "inactive" as const,
      notes: ["Directory discovery does not imply protocol compatibility or Active Pool admission"],
    }];
  });
  const registry: ProviderChannelRegistry = {
    schemaVersion: "acu-provider-channel-registry-v1",
    generatedAt: new Date().toISOString(),
    channels,
  };
  validateProviderChannelRegistry(registry);
  await writeFile(outputPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o644 });
  console.log(JSON.stringify({ output: outputPath, channels: channels.length,
    providers: Object.fromEntries(["lucen", "blackai"].map((id) => [id, channels.filter((item) => item.providerId === id).length])) }));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Registry generation failed");
  process.exitCode = 1;
});
