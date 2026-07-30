#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
import { cashCnyPerNominalUsd, readProviderEconomicsCatalog, type ProviderEconomics } from "./provider-economics.js";
import { UsageOutboxWorker } from "./usage-outbox.js";
import { canonicalAdvertisedContextWindow } from "./context-admission.js";
import { ACU_ROUTING_MODEL_VERSION } from "../acu/config.js";

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
  maxRequestBytes: number;
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

function requestBodyBytes(value: string | undefined): number {
  const megabytes = Number.parseInt(value ?? "", 10);
  return (Number.isInteger(megabytes) && megabytes > 0 ? megabytes : 128) * 1024 * 1024;
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
    maxRequestBytes: requestBodyBytes(process.env.ACU_MAX_REQUEST_BODY_MB),
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
  const judgeEconomics = serviceConfig.judgeEconomicsProviderId
    ? serviceConfig.providerEconomics.find((item) => item.providerId === serviceConfig.judgeEconomicsProviderId)
    : undefined;
  if (serviceConfig.judgeEconomicsProviderId && !judgeEconomics) {
    throw new Error(`No Provider Economics for Judge ${serviceConfig.judgeEconomicsProviderId}`);
  }
  const judgeRunner = createAcuJudgeRunner({
    config: judgeConfig,
    rulesDecision: rulesFallbackDecision(),
    backupCashCnyPerNominalUsd: judgeEconomics ? cashCnyPerNominalUsd(judgeEconomics) : undefined,
  });
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
    adminChannelMonitor: {
      token: serviceConfig.adminTraceToken,
      async load(range) {
        const interval = range === "7d" ? "7 days" : range === "24h" ? "24 hours" : "1 hour";
        const [channels, profileHealth, attempts, history] = await Promise.all([
          database.query<Record<string, unknown>>("SELECT * FROM acu_channel_health ORDER BY provider_id,channel_id"),
          database.query<Record<string, unknown>>("SELECT * FROM acu_provider_model_profile_health ORDER BY canonical_model_id,provider_id,channel_id"),
          database.query<Record<string, unknown>>(
            `SELECT execution_profile_id, count(*)::int request_count,
              count(*) FILTER (WHERE status='success')::int success_count,
              count(*) FILTER (WHERE http_status=429)::int rate_limited_count,
              count(*) FILTER (WHERE http_status BETWEEN 500 AND 599)::int server_error_count,
              count(*) FILTER (WHERE error_category='slow_first_model_event' OR metadata_json->>'errorClass'='slow_first_model_event')::int watchdog_count,
              count(*) FILTER (WHERE attempt_index>1 AND status='success')::int recovery_count,
              percentile_cont(.5) WITHIN GROUP (ORDER BY (metadata_json->>'first_model_event_latency_ms')::double precision)
                FILTER (WHERE metadata_json ? 'first_model_event_latency_ms') p50_first_model_event_ms,
              percentile_cont(.95) WITHIN GROUP (ORDER BY (metadata_json->>'first_model_event_latency_ms')::double precision)
                FILTER (WHERE metadata_json ? 'first_model_event_latency_ms') p95_first_model_event_ms
             FROM acu_attempts WHERE attempt_kind='provider' AND started_at>=now()-$1::interval
             GROUP BY execution_profile_id`, [interval]),
          database.query<Record<string, unknown>>(
            `SELECT date_trunc('hour',started_at) bucket,execution_profile_id,count(*)::int request_count,
              count(*) FILTER (WHERE status='success')::int success_count,
              count(*) FILTER (WHERE http_status=429)::int rate_limited_count,
              count(*) FILTER (WHERE http_status BETWEEN 500 AND 599)::int server_error_count,
              count(*) FILTER (WHERE metadata_json->>'errorClass'='slow_first_model_event')::int watchdog_count,
              count(*) FILTER (WHERE attempt_index>1 AND status='success')::int recovery_count,
              percentile_cont(.5) WITHIN GROUP (ORDER BY (metadata_json->>'first_model_event_latency_ms')::double precision)
                FILTER (WHERE metadata_json ? 'first_model_event_latency_ms') p50_first_model_event_ms,
              percentile_cont(.95) WITHIN GROUP (ORDER BY (metadata_json->>'first_model_event_latency_ms')::double precision)
                FILTER (WHERE metadata_json ? 'first_model_event_latency_ms') p95_first_model_event_ms
             FROM acu_attempts WHERE attempt_kind='provider' AND started_at>=now()-$1::interval
             GROUP BY bucket,execution_profile_id ORDER BY bucket`, [interval]),
        ]);
        const healthByChannel = new Map(channels.rows.map((row) => [String(row.channel_id), row]));
        const healthByProfile = new Map(profileHealth.rows.map((row) => [String(row.execution_profile_id), row]));
        const aggregateByProfile = new Map(attempts.rows.map((row) => [String(row.execution_profile_id), row]));
        const publicProfiles = serviceConfig.profiles.map((profile) => {
          const channel = healthByChannel.get(profile.channelId ?? profile.channel) ?? {};
          const runtime = healthByProfile.get(profile.executionProfileId) ?? {};
          const aggregate = aggregateByProfile.get(profile.executionProfileId) ?? {};
          let endpointHost = "";
          try { endpointHost = new URL(profile.baseUrl ?? process.env[profile.baseUrlEnv ?? ""] ?? "").host; } catch { /* absent configuration */ }
          return {
            executionProfileId: profile.executionProfileId,
            canonicalModel: profile.modelId,
            protocol: profile.protocols,
            provider: profile.provider,
            channel: profile.channelId ?? profile.channel,
            endpointHost,
            multiplier: profile.observedBillingMultiplier,
            effectiveCostStatus: profile.effectiveCostStatus,
            enabled: profile.enabled,
            administratorAllowed: profile.administratorAllowed,
            routingEligible: profile.enabled && profile.administratorAllowed && !["open", "disabled"].includes(String(channel.circuit_state ?? profile.health)),
            state: channel.circuit_state ?? runtime.circuit_state ?? profile.health,
            recentSuccessRate: channel.recent_success_rate ?? runtime.recent_success_rate,
            consecutiveFailures: channel.consecutive_failures ?? runtime.consecutive_failures ?? 0,
            p50FirstModelEventLatencyMs: aggregate.p50_first_model_event_ms,
            p95FirstModelEventLatencyMs: aggregate.p95_first_model_event_ms,
            lastError: channel.error_class ?? runtime.error_class,
            lastSuccessAt: channel.last_success_at ?? runtime.last_success_at,
            cooldownUntil: channel.cooldown_until ?? runtime.cooldown_until,
          };
        });
        let supplyInventory: unknown[] = [];
        try {
          const discovery = JSON.parse(await readFile(process.env.ACU_PROVIDER_DISCOVERY_FILE ?? "/app/config/provider-channel-model-discovery.json", "utf8")) as { channels?: unknown[] };
          supplyInventory = discovery.channels ?? [];
        } catch { /* inventory is optional at runtime */ }
        return { range, profiles: publicProfiles, history: history.rows, supplyInventory, generatedAt: new Date().toISOString() };
      },
      async pause(channelId, durationMinutes, actor) {
        const profile = serviceConfig.profiles.find((item) => (item.channelId ?? item.channel) === channelId);
        if (!profile) throw new Error("Unknown Channel");
        const cooldownUntil = new Date(Date.now() + durationMinutes * 60_000);
        await database.transaction(async (client) => {
          await client.query(
            `INSERT INTO acu_channel_health (channel_id,provider_id,circuit_state,cooldown_until,consecutive_failures,recent_success_rate,error_class,updated_at)
             VALUES ($1,$2,'open',$3,0,1,'manual_pause',now())
             ON CONFLICT(channel_id) DO UPDATE SET circuit_state='open',cooldown_until=excluded.cooldown_until,
               error_class='manual_pause',half_open_probe_in_flight=false,updated_at=now()`,
            [channelId, profile.provider, cooldownUntil],
          );
          await client.query(
            `INSERT INTO acu_channel_admin_actions(action_id,channel_id,action,duration_minutes,actor,metadata_json)
             VALUES ($1,$2,'manual_pause',$3,$4,$5::jsonb)`,
            [`channel_action_${randomUUID()}`, channelId, durationMinutes, actor, JSON.stringify({ provider: profile.provider })],
          );
        });
        return { channelId, state: "open", cooldownUntil: cooldownUntil.toISOString(), recovery: "half_open_probe" };
      },
    },
    models: profiles.map((item) => item.profile.modelId),
    maxRequestBytes: serviceConfig.maxRequestBytes,
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
      const migration = await database.query<{ migration_version: string }>(
        "SELECT migration_version FROM acu_schema_migrations ORDER BY migration_version DESC LIMIT 1",
      );
      return {
        postgres: "ok",
        runningCommit: process.env.BUILD_COMMIT_SHA ?? "unknown",
        buildTime: process.env.BUILD_TIME ?? "unknown",
        buildBranch: process.env.BUILD_BRANCH ?? "unknown",
        schemaVersion: process.env.ACU_SCHEMA_VERSION ?? "unknown",
        latestMigration: migration.rows[0]?.migration_version ?? "unknown",
        judgePrimaryModel: judgeConfig.judgeModel,
        judgeBackupModel: judgeConfig.backupJudgeModel ?? null,
        routingFormulaVersion: ACU_ROUTING_MODEL_VERSION,
      };
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
