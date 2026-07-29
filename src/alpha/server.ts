#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readAcuRuntimeConfig } from "../acu/config.js";
import type { RoutingDecision } from "../router/types.js";
import { AlphaDatabase } from "./database.js";
import { createAlphaGatewayServer } from "./gateway.js";
import { createAcuJudgeRunner } from "./judge-runner.js";
import { AlphaRequestProcessor } from "./processor.js";
import { createNativeProviderAdapter, type NativeProviderConfig } from "./provider.js";
import { AlphaRepository } from "./repository.js";
import type { AlphaExecutionProfile } from "./routing.js";
import { readProviderEconomicsCatalog, type ProviderEconomics } from "./provider-economics.js";
import { UsageOutboxWorker } from "./usage-outbox.js";
import { canonicalAdvertisedContextWindow } from "./context-admission.js";

export type ConfiguredExecutionProfile = AlphaExecutionProfile & {
  baseUrl?: string;
  baseUrlEnv?: string;
  apiKeyEnv: string;
  authMode: NativeProviderConfig["authMode"];
  anthropicVersion?: string;
  stripV1Path?: boolean;
  economicsProviderId?: string;
  networkFallbackBaseUrlEnvs?: string[];
  channelId?: string;
  routingGroupName?: string;
  observedBillingMultiplier?: number;
  effectiveCostStatus?: "verified" | "estimated" | "missing";
};

export function economicsForExecutionProfile(
  economics: ProviderEconomics,
  profile: Pick<ConfiguredExecutionProfile, "apiKeyEnv" | "channelId" | "effectiveCostStatus" | "observedBillingMultiplier">,
): ProviderEconomics {
  return {
    ...economics,
    apiKeyEnv: profile.apiKeyEnv,
    observedBillingMultiplier: profile.observedBillingMultiplier ?? economics.observedBillingMultiplier,
    enabled: profile.effectiveCostStatus === "missing" ? false : economics.enabled,
    // A registered Channel owns its runtime circuit independently. The
    // legacy provider-level health only applies to profiles that have not
    // yet migrated to the Channel Registry.
    health: profile.channelId ? "healthy" : economics.health,
  };
}

export type AlphaServiceConfig = {
  bindAddress: string;
  port: number;
  databaseUrl: string;
  trustedIdentitySecret: string;
  adminTraceToken: string;
  newApiInternalBaseUrl: string;
  profiles: ConfiguredExecutionProfile[];
  providerEconomics: ProviderEconomics[];
  judgeEconomicsProviderId?: string;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required environment variable is missing: ${name}`);
  return value;
}

function positivePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : 8403;
}

function validateProfile(value: unknown, index: number): ConfiguredExecutionProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Execution profile ${index} must be an object`);
  }
  const profile = value as Partial<ConfiguredExecutionProfile>;
  const requiredStrings: Array<keyof ConfiguredExecutionProfile> = [
    "executionProfileId",
    "modelId",
    "provider",
    "channel",
    "apiKeyEnv",
    "authMode",
  ];
  for (const key of requiredStrings) {
    if (typeof profile[key] !== "string" || !profile[key]) {
      throw new Error(`Execution profile ${index} is missing ${key}`);
    }
  }
  if (!Array.isArray(profile.protocols) || profile.protocols.length === 0) {
    throw new Error(`Execution profile ${index} must declare native protocols`);
  }
  if (!profile.baseUrl && !profile.baseUrlEnv) {
    throw new Error(`Execution profile ${index} must declare baseUrl or baseUrlEnv`);
  }
  return profile as ConfiguredExecutionProfile;
}

async function configuredProfiles(): Promise<ConfiguredExecutionProfile[]> {
  const inline = process.env.ACU_EXECUTION_PROFILES_JSON?.trim();
  const file = process.env.ACU_EXECUTION_PROFILES_FILE?.trim();
  if (!inline && !file) throw new Error("ACU_EXECUTION_PROFILES_JSON or ACU_EXECUTION_PROFILES_FILE is required");
  const parsed = JSON.parse(inline ?? await readFile(file!, "utf8")) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("At least one execution profile is required");
  return parsed.map(validateProfile);
}

export async function readAlphaServiceConfig(): Promise<AlphaServiceConfig> {
  const economicsPath = requiredEnvironment("ACU_PROVIDER_ECONOMICS_FILE");
  return {
    bindAddress: process.env.ACU_BIND_ADDRESS?.trim() || "0.0.0.0",
    port: positivePort(process.env.ACU_PORT),
    databaseUrl: requiredEnvironment("ACU_DATABASE_URL"),
    trustedIdentitySecret: requiredEnvironment("ACU_TRUSTED_IDENTITY_SECRET"),
    adminTraceToken: requiredEnvironment("ACU_ADMIN_TRACE_TOKEN"),
    newApiInternalBaseUrl: requiredEnvironment("NEW_API_INTERNAL_BASE_URL"),
    profiles: await configuredProfiles(),
    providerEconomics: (await readProviderEconomicsCatalog(economicsPath)).providers,
    judgeEconomicsProviderId: process.env.ACU_JUDGE_ECONOMICS_PROVIDER_ID?.trim() || undefined,
  };
}

function rulesFallbackDecision(): RoutingDecision {
  return {
    model: "rules-fallback",
    tier: "MEDIUM",
    confidence: 0.65,
    method: "rules",
    reasoning: "Alpha P0 deterministic rules fallback",
    costEstimate: 0,
    baselineCost: 0,
    savings: 0,
  };
}

export async function startAlphaService(config?: AlphaServiceConfig): Promise<void> {
  const serviceConfig = config ?? await readAlphaServiceConfig();
  const database = new AlphaDatabase({ connectionString: serviceConfig.databaseUrl });
  await database.query("SELECT 1");
  const profiles = serviceConfig.profiles.map((profile) => {
    const baseUrl = profile.baseUrl ?? requiredEnvironment(profile.baseUrlEnv!);
    const apiKey = requiredEnvironment(profile.apiKeyEnv);
    const economics = serviceConfig.providerEconomics.find((item) => (
      item.providerId === (profile.economicsProviderId ?? profile.provider)
    ));
    if (!economics) throw new Error(`No Provider Economics for ${profile.provider}`);
    if (!profile.channelId && economics.apiKeyEnv !== profile.apiKeyEnv) {
      throw new Error(`Provider Economics environment mismatch for ${profile.executionProfileId}`);
    }
    const channelEconomics = economicsForExecutionProfile(economics, profile);
    const safeProfile: AlphaExecutionProfile = {
      executionProfileId: profile.executionProfileId,
      modelId: profile.modelId,
      providerModelId: profile.providerModelId ?? profile.modelId,
      actualModelAliases: profile.actualModelAliases,
      provider: profile.provider,
      channel: profile.channel,
      channelId: profile.channelId ?? profile.channel,
      routingGroupName: profile.routingGroupName,
      effectiveCostStatus: profile.effectiveCostStatus,
      protocols: profile.protocols,
      toolCallSupport: profile.toolCallSupport,
      supportedToolTypes: profile.supportedToolTypes,
      thinkingSupport: profile.thinkingSupport,
      supportedReasoningEfforts: profile.supportedReasoningEfforts,
      contextWindow: profile.contextWindow,
      canonicalAdvertisedContextWindow: profile.canonicalAdvertisedContextWindow
        ?? canonicalAdvertisedContextWindow(profile.modelId),
      providerDeclaredContextWindow: profile.providerDeclaredContextWindow ?? null,
      observedSuccessfulInputTokens: profile.observedSuccessfulInputTokens ?? 0,
      providerHardContextCap: profile.providerHardContextCap ?? null,
      contextCapabilityStatus: profile.contextCapabilityStatus ?? "unverified_long_context",
      contextCapabilitySource: profile.contextCapabilitySource ?? "canonical_advertised_default",
      contextLastVerifiedAt: profile.contextLastVerifiedAt,
      health: profile.health,
      enabled: profile.enabled,
      administratorAllowed: profile.administratorAllowed,
      economics: channelEconomics,
      usageTrusted: profile.usageTrusted,
      recentSuccessRate: profile.recentSuccessRate,
      observedLatencyMs: profile.observedLatencyMs,
      webToolDeclarationAccepted: profile.webToolDeclarationAccepted,
      webSearchExecutionVerified: profile.webSearchExecutionVerified,
      webSearchStreamingVerified: profile.webSearchStreamingVerified,
      webSearchResultVerified: profile.webSearchResultVerified,
      webSearchRecentSuccessRate: profile.webSearchRecentSuccessRate,
      webSearchObservedLatencyMs: profile.webSearchObservedLatencyMs,
      webSearchLastVerifiedAt: profile.webSearchLastVerifiedAt,
      webSearchFailureReason: profile.webSearchFailureReason,
    };
    const endpoints = [{ endpoint: new URL(baseUrl).host, baseUrl }, ...(profile.networkFallbackBaseUrlEnvs ?? []).map((name) => {
      const fallbackBaseUrl = requiredEnvironment(name);
      return { endpoint: new URL(fallbackBaseUrl).host, baseUrl: fallbackBaseUrl };
    })];
    const adapters = endpoints.map((endpoint) => ({
      endpoint: endpoint.endpoint,
      adapter: createNativeProviderAdapter({
        provider: profile.provider,
        channel: profile.channel,
        baseUrl: endpoint.baseUrl,
        apiKey,
        authMode: profile.authMode,
        anthropicVersion: profile.anthropicVersion,
        stripV1Path: profile.stripV1Path,
      }),
    }));
    return {
      profile: safeProfile,
      adapter: adapters[0].adapter,
      adapters,
    };
  });
  const judgeConfig = readAcuRuntimeConfig();
  const judgeRunner = createAcuJudgeRunner({
    config: judgeConfig,
    rulesDecision: rulesFallbackDecision(),
  });
  const judgeEconomics = serviceConfig.judgeEconomicsProviderId
    ? serviceConfig.providerEconomics.find((item) => item.providerId === serviceConfig.judgeEconomicsProviderId)
    : undefined;
  if (serviceConfig.judgeEconomicsProviderId && !judgeEconomics) {
    throw new Error(`No Provider Economics for Judge ${serviceConfig.judgeEconomicsProviderId}`);
  }
  const processor = new AlphaRequestProcessor({
    database,
    profiles: profiles.map((item) => item.profile),
    adapters: new Map(profiles.map((item) => [item.profile.executionProfileId, item.adapter])),
    networkAdapters: new Map(profiles.map((item) => [item.profile.executionProfileId, item.adapters])),
    judgeRunner,
    judgeEconomics,
  });
  const repository = new AlphaRepository(database);
  const usageOutbox = new UsageOutboxWorker({
    repository,
    baseUrl: serviceConfig.newApiInternalBaseUrl,
    sharedSecret: serviceConfig.trustedIdentitySecret,
  });
  const server = createAlphaGatewayServer({
    trustedIdentitySecret: serviceConfig.trustedIdentitySecret,
    adminTrace: {
      token: serviceConfig.adminTraceToken,
      load: (logicalRequestId) => repository.getAdminLogicalRequestTrace(logicalRequestId),
    },
    models: profiles.map((item) => item.profile.modelId),
    resolveExecution: processor.resolveExecution.bind(processor),
    onTrace: processor.handleTrace.bind(processor),
    onTraceError(error, trace) {
      const context = trace.resolution.context as { logicalRequestId?: string } | undefined;
      console.error("Alpha trace persistence failed", {
        logicalRequestId: context?.logicalRequestId ?? "unavailable",
        error: error instanceof Error ? error.message : "unknown_error",
      });
    },
    async healthCheck() {
      await database.query("SELECT 1 FROM acu_sessions LIMIT 1");
      return { postgres: "ok" };
    },
  });
  server.listen(serviceConfig.port, serviceConfig.bindAddress, () => {
    console.log(`ACU Router Alpha listening on ${serviceConfig.bindAddress}:${serviceConfig.port}`);
    console.log(`Loaded ${profiles.length} execution profiles`);
    usageOutbox.start();
  });
  const shutdown = async (signal: string) => {
    console.log(`ACU Router Alpha received ${signal}; shutting down`);
    server.close();
    await usageOutbox.stop();
    await database.close();
  };
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  startAlphaService().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "ACU Router Alpha failed to start");
    process.exitCode = 1;
  });
}
