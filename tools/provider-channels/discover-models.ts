#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAcuCatalog } from "../../src/acu/catalog.js";
import {
  readProviderChannelRegistry,
  validateProviderModelProfiles,
  assertSupplyProfileConservation,
  type ProviderModelProfile,
} from "../../src/alpha/channel-registry.js";
import { validateDotenv } from "./normalize-env.js";

type Discovery = {
  channelId: string;
  providerId: string;
  routingGroupName: string;
  status: "success" | "auth_failed" | "unavailable" | "failed";
  httpStatus: number | null;
  endpointHost: string;
  responseSha256: string | null;
  providerModelIds: string[];
  exactCanonicalMatches: string[];
  unknownModelIds: string[];
  aliasMappingRequired: string[];
  responsesCandidates: string[];
  messagesCandidates: string[];
  observedAt: string;
};

function envMap(text: string): Map<string, string> {
  validateDotenv(text);
  return new Map(text.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    return match ? [[match[1], match[2]]] : [];
  }));
}

function directoryUrl(base: string): URL {
  const url = new URL(base.endsWith("/") ? base : `${base}/`);
  if (url.pathname.endsWith("/v1/")) return new URL("models", url);
  return new URL("models", url);
}

function modelIds(value: unknown): string[] {
  const root = value as { data?: unknown; models?: unknown };
  const list = Array.isArray(root) ? root : Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : [];
  return [...new Set(list.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object") {
      const id = (item as { id?: unknown; name?: unknown }).id ?? (item as { name?: unknown }).name;
      return typeof id === "string" && id ? [id] : [];
    }
    return [];
  }))].sort();
}

async function discover(url: URL, apiKey: string, signal: AbortSignal): Promise<Response> {
  return fetch(url, { headers: { authorization: `Bearer ${apiKey}` }, signal, redirect: "manual" });
}

async function main(): Promise<void> {
  const env = envMap(await readFile(resolve(process.argv[2] ?? ".env"), "utf8"));
  const registryPath = resolve(process.argv[3] ?? "deploy/alpha/provider-channels.json");
  const outputPath = resolve(process.argv[4] ?? "deploy/alpha/provider-channel-model-discovery.json");
  const profilesPath = resolve(process.argv[5] ?? "deploy/alpha/provider-model-profiles.json");
  const registry = await readProviderChannelRegistry(registryPath);
  const canonical = new Set(getAcuCatalog().models.map((item) => item.modelId));
  const observations: Discovery[] = [];
  for (const channel of registry.channels) {
    const key = env.get(channel.apiKeyEnv);
    const base = env.get(channel.primaryBaseUrlEnv);
    if (!key || !base) {
      observations.push({ channelId: channel.channelId, providerId: channel.providerId,
        routingGroupName: channel.routingGroupName, status: "unavailable", httpStatus: null,
        endpointHost: base ? new URL(base).host : "missing", responseSha256: null, providerModelIds: [],
        exactCanonicalMatches: [], unknownModelIds: [], aliasMappingRequired: [], responsesCandidates: [],
        messagesCandidates: [], observedAt: new Date().toISOString() });
      continue;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const url = directoryUrl(base);
      const response = await discover(url, key, controller.signal);
      const raw = Buffer.from(await response.arrayBuffer());
      let ids: string[] = [];
      if (response.ok) {
        try { ids = modelIds(JSON.parse(raw.toString("utf8")) as unknown); } catch { /* classified below */ }
      }
      const matches = ids.filter((id) => canonical.has(id));
      const unknown = ids.filter((id) => !canonical.has(id));
      const status = response.status === 401 || response.status === 403 ? "auth_failed"
        : response.ok && ids.length > 0 ? "success" : response.ok ? "unavailable" : "failed";
      observations.push({ channelId: channel.channelId, providerId: channel.providerId,
        routingGroupName: channel.routingGroupName, status, httpStatus: response.status,
        endpointHost: url.host, responseSha256: createHash("sha256").update(raw).digest("hex"),
        providerModelIds: ids, exactCanonicalMatches: matches, unknownModelIds: unknown,
        aliasMappingRequired: unknown, responsesCandidates: channel.protocolCandidates.includes("responses") ? matches : [],
        messagesCandidates: channel.protocolCandidates.includes("messages") ? matches : [], observedAt: new Date().toISOString() });
    } catch {
      observations.push({ channelId: channel.channelId, providerId: channel.providerId,
        routingGroupName: channel.routingGroupName, status: "failed", httpStatus: null,
        endpointHost: new URL(base).host, responseSha256: null, providerModelIds: [], exactCanonicalMatches: [],
        unknownModelIds: [], aliasMappingRequired: [], responsesCandidates: [], messagesCandidates: [],
        observedAt: new Date().toISOString() });
    } finally {
      clearTimeout(timeout);
    }
  }
  const discoveredRegistry = {
    schemaVersion: "acu-provider-channel-discovery-v1",
    generatedAt: new Date().toISOString(),
    curveModelCount: canonical.size,
    summary: {
      channelCount: observations.length,
      success: observations.filter((item) => item.status === "success").length,
      authFailed: observations.filter((item) => item.status === "auth_failed").length,
      noDirectory: observations.filter((item) => item.status === "unavailable").length,
      failed: observations.filter((item) => item.status === "failed").length,
      curveIntersections: observations.reduce((sum, item) => sum + item.exactCanonicalMatches.length, 0),
      aliasPending: observations.reduce((sum, item) => sum + item.aliasMappingRequired.length, 0),
      responsesCandidates: observations.reduce((sum, item) => sum + item.responsesCandidates.length, 0),
      messagesCandidates: observations.reduce((sum, item) => sum + item.messagesCandidates.length, 0),
    },
    channels: observations,
  };
  const profiles: ProviderModelProfile[] = observations.flatMap((observation) => {
    const channel = registry.channels.find((item) => item.channelId === observation.channelId)!;
    return ([...observation.responsesCandidates.map((canonicalModelId) => ({ canonicalModelId, protocol: "responses" as const })),
      ...observation.messagesCandidates.map((canonicalModelId) => ({ canonicalModelId, protocol: "messages" as const }))]
      .map(({ canonicalModelId, protocol }) => ({
        executionProfileId: `${channel.channelId}:${canonicalModelId}:${protocol}`,
        channelId: channel.channelId,
        providerId: channel.providerId,
        canonicalModelId,
        providerModelId: canonicalModelId,
        protocol,
        toolCallSupport: false,
        supportedToolTypes: [],
        thinkingSupport: false,
        supportedReasoningEfforts: [],
        canonicalAdvertisedContextWindow: null,
        providerDeclaredContextWindow: null,
        observedSuccessfulInputTokens: 0,
        providerHardContextCap: null,
        contextCapabilityStatus: "unverified_long_context" as const,
        contextCapabilitySource: "directory_only",
        contextLastVerifiedAt: null,
        actualModelVerified: false,
        usageTrusted: false,
        effectivePriceAvailable: channel.effectiveCostStatus !== "missing",
        effectiveCostStatus: channel.effectiveCostStatus,
        health: "disabled" as const,
        healthReason: "directory_only_pending_minimal_protocol_preflight",
        lastVerifiedAt: null,
        activeInAcuAuto: false,
        status: "probe_pending" as const,
        activeInRouting: false,
        consecutiveProbeFailures: 0,
        statusReason: "directory_only_pending_minimal_protocol_preflight",
      })));
  });
  const profileRegistry = { schemaVersion: "acu-provider-model-profile-registry-v1" as const,
    generatedAt: new Date().toISOString(), profiles };
  validateProviderModelProfiles(profileRegistry);
  assertSupplyProfileConservation(profiles.map((profile) => profile.executionProfileId), profiles);
  await writeFile(outputPath, `${JSON.stringify(discoveredRegistry, null, 2)}\n`);
  await writeFile(profilesPath, `${JSON.stringify(profileRegistry, null, 2)}\n`);
  console.log(JSON.stringify(discoveredRegistry.summary));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Channel model discovery failed");
  process.exitCode = 1;
});
