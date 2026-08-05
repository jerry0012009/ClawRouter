#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readAcuRuntimeConfig } from "../acu/config.js";
import { AcuJudgeClient } from "../acu/judge.js";
import type { RoutingDecision } from "../router/types.js";
import { AlphaDatabase } from "./database.js";
import { createAlphaGatewayServer } from "./gateway.js";
import { createAcuJudgeRunner } from "./judge-runner.js";
import { AlphaRequestProcessor, hydrateExecutionProfileRuntime } from "./processor.js";
import { createNativeProviderAdapter, type NativeProviderConfig } from "./provider.js";
import { AlphaRepository } from "./repository.js";
import { profileSupportsExecutionPreset, type AlphaExecutionProfile } from "./routing.js";
import { cashCnyPerNominalUsd, readProviderEconomicsCatalog, type ProviderEconomics } from "./provider-economics.js";
import { UsageOutboxWorker } from "./usage-outbox.js";
import { canonicalAdvertisedContextWindow } from "./context-admission.js";
import { ACU_ROUTING_MODEL_VERSION } from "../acu/config.js";
import { getAcuModel } from "../acu/catalog.js";
import { enabledExecutionPresets } from "../acu/execution-presets.js";
import { combinedMonitorState, mergeSupplyInventory, MONITOR_JUDGE_AGGREGATION_SQL, monitorProbeMode, monitorRangeSpec, monitorReasoningMetadata, monitorRoutingStatus, normalizeMonitorQuery, scoreMonitorProfiles, type MonitorProfileAggregate } from "./channel-monitor.js";
import { AdaptiveProbeWorker } from "./adaptive-probe.js";
import { deriveRuntimeEligibility } from "./channel-health.js";
import { recordSharedRuntimeHealthOutcome } from "./runtime-health-outcome.js";
import { resolveProfileAttemptDeadlineMs } from "./execution-timing.js";
import {
  DEFAULT_BILLING_POLICY_VERSION,
  parseRetailMarkupMultiplier,
} from "./retail-charge.js";

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
  retailMarkupMultiplier: number;
  billingPolicyVersion: string;
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

function capabilityTier(modelId: string): "LUNA" | "TERRA" | "SOL" | "FRONTIER" {
  if (modelId.includes("terra") || modelId.includes("sonnet")) return "TERRA";
  if (modelId.includes("sol")) return "SOL";
  if (modelId.includes("5.5") || modelId.includes("opus")) return "FRONTIER";
  return "LUNA";
}

export function routingCandidatesForModel(
  modelId: string,
  profiles: AlphaExecutionProfile[],
): Array<{
  candidateId: string;
  modelId: string;
  displayName: string;
  kind: "base" | "preset";
  presetId?: string;
  reasoningEffort?: string;
  calibrationStatus?: string;
}> {
  const catalog = getAcuModel(modelId);
  const capabilityProfiles = profiles.filter((profile) =>
    profile.modelId === modelId
    && profile.enabled
    && profile.administratorAllowed
    && profile.autoRouteEnabled !== false
    && (!profile.verificationStatus
      || ["verified", "verified_provisional"].includes(profile.verificationStatus))
  );
  return [{
    candidateId: modelId,
    modelId,
    displayName: catalog?.displayName ?? modelId,
    kind: "base",
  }, ...enabledExecutionPresets()
    .filter((preset) => preset.modelId === modelId
      && capabilityProfiles.some((profile) => profileSupportsExecutionPreset(profile, preset)))
    .map((preset) => ({
      candidateId: preset.candidateId,
      modelId,
      displayName: preset.displayName,
      kind: "preset" as const,
      presetId: preset.presetId,
      reasoningEffort: preset.canonicalReasoningEffort,
      calibrationStatus: preset.calibrationStatus,
    }))];
}

function validateProfile(value: unknown, index: number): ConfiguredExecutionProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Execution profile ${index} must be an object`);
  }
  const profile = value as Partial<ConfiguredExecutionProfile>;
  const requiredStrings: Array<keyof ConfiguredExecutionProfile> = ["executionProfileId", "modelId", "provider", "channel", "apiKeyEnv", "authMode"];
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
  if (profile.billingPrice) {
    for (const [field, amount] of Object.entries(profile.billingPrice)) {
      if (field.endsWith("PricePerMillion") && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) {
        throw new Error(`Execution profile ${index} has invalid billingPrice.${field}`);
      }
    }
    if (profile.billingPrice.currency !== "USD_CREDIT" || !profile.billingPrice.source || !profile.billingPrice.observedAt) {
      throw new Error(`Execution profile ${index} has incomplete billingPrice evidence`);
    }
  }
  return profile as ConfiguredExecutionProfile;
}

async function configuredProfiles(): Promise<ConfiguredExecutionProfile[]> {
  const inline = process.env.ACU_EXECUTION_PROFILES_JSON?.trim();
  const file = process.env.ACU_EXECUTION_PROFILES_FILE?.trim();
  if (!inline && !file) throw new Error("ACU_EXECUTION_PROFILES_JSON or ACU_EXECUTION_PROFILES_FILE is required");
  const parsed = JSON.parse(inline ?? (await readFile(file!, "utf8"))) as unknown;
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
    retailMarkupMultiplier: parseRetailMarkupMultiplier(process.env.ACU_RETAIL_MARKUP_MULTIPLIER),
    billingPolicyVersion: process.env.ACU_BILLING_POLICY_VERSION?.trim() || DEFAULT_BILLING_POLICY_VERSION,
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
  const serviceConfig = config ?? (await readAlphaServiceConfig());
  const database = new AlphaDatabase({ connectionString: serviceConfig.databaseUrl });
  await database.query("SELECT 1");
  const profiles = serviceConfig.profiles.map((profile) => {
    const baseUrl = profile.baseUrl ?? requiredEnvironment(profile.baseUrlEnv!);
    const apiKey = requiredEnvironment(profile.apiKeyEnv);
    const economics = serviceConfig.providerEconomics.find((item) => item.providerId === (profile.economicsProviderId ?? profile.provider));
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
      billingPrice: profile.billingPrice,
      protocols: profile.protocols,
      toolCallSupport: profile.toolCallSupport,
      supportedToolTypes: profile.supportedToolTypes,
      thinkingSupport: profile.thinkingSupport,
      supportedReasoningEfforts: profile.supportedReasoningEfforts,
      reasoningControlMode: profile.reasoningControlMode ?? "none",
      contextWindow: profile.contextWindow,
      canonicalAdvertisedContextWindow: profile.canonicalAdvertisedContextWindow ?? canonicalAdvertisedContextWindow(profile.modelId),
      providerDeclaredContextWindow: profile.providerDeclaredContextWindow ?? null,
      observedSuccessfulInputTokens: profile.observedSuccessfulInputTokens ?? 0,
      observedContextFailureThresholdTokens: profile.observedContextFailureThresholdTokens,
      observedJudgeContextFailureThresholdTokens: profile.observedJudgeContextFailureThresholdTokens,
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
      webTransportStatus: profile.webTransportStatus,
      modelVendor: profile.modelVendor ?? getAcuModel(profile.modelId)?.provider,
      modelCategory: profile.modelCategory ?? "text_agent",
      capabilityTier: profile.capabilityTier ?? "LUNA",
      verificationStatus: profile.verificationStatus ?? "verified",
      autoRouteEnabled: profile.autoRouteEnabled ?? true,
      requiresFreshProbe: profile.requiresFreshProbe ?? false,
    };
    const endpoints = [
      { endpoint: new URL(baseUrl).host, baseUrl },
      ...(profile.networkFallbackBaseUrlEnvs ?? []).map((name) => {
        const fallbackBaseUrl = requiredEnvironment(name);
        return { endpoint: new URL(fallbackBaseUrl).host, baseUrl: fallbackBaseUrl };
      }),
    ];
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
      judgeBaseUrl: baseUrl,
      judgeApiKey: apiKey,
    };
  });
  const judgeConfig = readAcuRuntimeConfig();
  const runtimeRepository = new AlphaRepository(database);
  const adapterMap = new Map(profiles.map((item) => [item.profile.executionProfileId, item.adapter]));
  const adaptiveProbe = new AdaptiveProbeWorker({
    database,
    profiles: profiles.map((item) => item.profile),
    adapters: adapterMap,
    dailyBudgetCny: Number(process.env.ACU_PROBE_DAILY_BUDGET_CNY ?? "1.00"),
  });
  const judgeEconomics = serviceConfig.judgeEconomicsProviderId ? serviceConfig.providerEconomics.find((item) => item.providerId === serviceConfig.judgeEconomicsProviderId) : undefined;
  if (serviceConfig.judgeEconomicsProviderId && !judgeEconomics) {
    throw new Error(`No Provider Economics for Judge ${serviceConfig.judgeEconomicsProviderId}`);
  }
  const judgeRunner = createAcuJudgeRunner({
    config: judgeConfig,
    rulesDecision: rulesFallbackDecision(),
    backupCashCnyPerNominalUsd: judgeEconomics ? cashCnyPerNominalUsd(judgeEconomics) : undefined,
    profiles: profiles.map((item) => item.profile),
    loadProfiles: async () => {
      const baseProfiles = profiles.map((item) => item.profile);
      const [channels, runtimes] = await Promise.all([
        runtimeRepository.batchChannelHealth(baseProfiles.map((profile) => profile.channelId ?? profile.channel)),
        runtimeRepository.batchProfileHealth(baseProfiles.map((profile) => profile.executionProfileId)),
      ]);
      return baseProfiles.map((profile) => {
        const runtime = runtimes.get(profile.executionProfileId);
        const channel = channels.get(profile.channelId ?? profile.channel);
        return hydrateExecutionProfileRuntime(profile, runtime, channel);
      });
    },
    profileClients: new Map(profiles.map((item) => {
      const profileConfig = {
      ...judgeConfig,
      judgeModel: judgeConfig.judgeModel,
      judgeProvider: item.profile.provider,
      judgeBaseUrl: item.judgeBaseUrl,
      judgeProtocol: item.profile.protocols.includes("responses") ? "responses" as const : "chat_completions" as const,
      apiKey: item.judgeApiKey,
      backupJudgeModel: undefined,
      backupJudgeBaseUrl: undefined,
      backupApiKey: undefined,
      syncBackupEnabled: false,
      };
      return [item.profile.executionProfileId, new AcuJudgeClient(profileConfig)] as const;
    })),
    recordHealthOutcome: async (profile, outcome) => recordSharedRuntimeHealthOutcome({
      repository: runtimeRepository,
      profile,
      protocol: "responses",
      outcome,
      wakeProbe: (executionProfileId) => executionProfileId ? adaptiveProbe.enqueue(executionProfileId) : adaptiveProbe.wake(),
    }),
    recordContextEvidence: async (profile, evidence) => {
      const runtime = await runtimeRepository.profileHealth(profile.executionProfileId);
      const previousJudgeFailure = Number(runtime?.metadata?.observedJudgeContextFailureThresholdTokens);
      const judgeFailureThreshold = evidence.judgeFailureThresholdTokens === undefined
        ? undefined
        : Math.min(
            Number.isFinite(previousJudgeFailure) ? previousJudgeFailure : Number.POSITIVE_INFINITY,
            evidence.judgeFailureThresholdTokens,
          );
      await runtimeRepository.saveProfileWebHealth({
        executionProfileId: profile.executionProfileId,
        channelId: profile.channelId ?? profile.channel,
        providerId: profile.provider,
        canonicalModelId: profile.modelId,
        protocol: "responses",
        usageTrusted: profile.usageTrusted !== false,
        actualModelVerified: evidence.successInputTokens !== undefined
          ? true : runtime?.actualModelVerified ?? false,
        observedSuccessfulInputTokens: evidence.successInputTokens === undefined
          ? undefined : BigInt(evidence.successInputTokens),
        contextCapabilityStatus: evidence.successInputTokens === undefined ? undefined : "observed_floor",
        contextCapabilitySource: evidence.successInputTokens === undefined
          ? undefined : "judge_provider_usage_observed_success",
        contextLastVerifiedAt: evidence.successInputTokens === undefined ? undefined : new Date(),
        metadata: judgeFailureThreshold === undefined ? {} : {
          observedJudgeContextFailureThresholdTokens: judgeFailureThreshold,
          judgeContextFailureLastObservedAt: new Date().toISOString(),
        },
      });
    },
    profileAttemptDeadlineMs: (profile, estimatedInputTokens) => resolveProfileAttemptDeadlineMs({
      database,
      repository: runtimeRepository,
      profile,
      estimatedInputTokens,
    }),
  });
  const processor = new AlphaRequestProcessor({
    database,
    profiles: profiles.map((item) => item.profile),
    adapters: adapterMap,
    networkAdapters: new Map(profiles.map((item) => [item.profile.executionProfileId, item.adapters])),
    judgeRunner,
    judgeEconomics,
    retailMarkupMultiplier: serviceConfig.retailMarkupMultiplier,
    billingPolicyVersion: serviceConfig.billingPolicyVersion,
    wakeProbe: (executionProfileId) => executionProfileId ? adaptiveProbe.enqueue(executionProfileId) : adaptiveProbe.wake(),
  });
  adaptiveProbe.start();
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
      async load(requestedQuery, monitorUtilityPolicy) {
        const { range, supplyStrategy, scenario } = normalizeMonitorQuery(requestedQuery);
        const { interval, bucket } = monitorRangeSpec(range);
        const catalogValues: unknown[] = [];
        const catalogRows = serviceConfig.profiles
          .map((profile, index) => {
            const offset = index * 4 + 3;
            catalogValues.push(profile.executionProfileId, profile.modelId, profile.provider, profile.channelId ?? profile.channel);
            return `($${offset},$${offset + 1},$${offset + 2},$${offset + 3})`;
          })
          .join(",");
        const historySql = `WITH profile_catalog(execution_profile_id,canonical_model,provider_id,channel_id) AS (
            VALUES ${catalogRows}
          ), base AS (
            SELECT date_bin($2::interval,a.started_at,timestamptz '2000-01-01') bucket,
              a.execution_profile_id,coalesce(c.canonical_model,a.actual_model,a.requested_model) canonical_model,
              coalesce(a.provider,c.provider_id) provider,coalesce(a.channel_id,a.channel,c.channel_id) channel,
              a.status,a.http_status,a.error_category,a.attempt_index,a.metadata_json
            FROM acu_attempts a LEFT JOIN profile_catalog c USING(execution_profile_id)
            WHERE a.attempt_kind='provider' AND a.started_at>=now()-$1::interval
          )
          SELECT bucket,
            CASE WHEN grouping(execution_profile_id)=0 THEN 'profile'
              WHEN grouping(canonical_model)=0 THEN 'channel_model' ELSE 'channel' END scope_type,
            CASE WHEN grouping(execution_profile_id)=0 THEN execution_profile_id
              WHEN grouping(canonical_model)=0 THEN channel||':'||canonical_model ELSE channel END scope_id,
            CASE WHEN grouping(execution_profile_id)=0 THEN execution_profile_id END execution_profile_id,
            CASE WHEN grouping(canonical_model)=0 THEN canonical_model END canonical_model,
            provider,channel,count(*)::int request_count,
            count(*) FILTER (WHERE status='success')::int success_count,
            count(*) FILTER (WHERE status<>'success')::int error_count,
            count(*) FILTER (WHERE http_status=429)::int rate_limited_count,
            count(*) FILTER (WHERE http_status BETWEEN 500 AND 599)::int server_error_count,
            count(*) FILTER (WHERE error_category='slow_first_model_event' OR metadata_json->>'errorClass'='slow_first_model_event')::int watchdog_count,
            count(*) FILTER (WHERE attempt_index>1 AND status='success')::int recovery_count,
            percentile_cont(.5) WITHIN GROUP (ORDER BY (metadata_json->>'first_model_event_latency_ms')::double precision)
              FILTER (WHERE metadata_json ? 'first_model_event_latency_ms') p50_first_model_event_ms,
            percentile_cont(.95) WITHIN GROUP (ORDER BY (metadata_json->>'first_model_event_latency_ms')::double precision)
              FILTER (WHERE metadata_json ? 'first_model_event_latency_ms') p95_first_model_event_ms
          FROM base GROUP BY GROUPING SETS (
            (bucket,provider,channel),
            (bucket,provider,channel,canonical_model),
            (bucket,provider,channel,canonical_model,execution_profile_id)
          ) ORDER BY bucket,scope_type,scope_id`;
        const [channels, profileHealth, attempts, judges, history, cooldowns, adminPauses, probes, probeHistory] = await Promise.all([
          database.query<Record<string, unknown>>("SELECT * FROM acu_channel_health ORDER BY provider_id,channel_id"),
          database.query<Record<string, unknown>>("SELECT * FROM acu_provider_model_profile_health ORDER BY canonical_model_id,provider_id,channel_id"),
          database.query<Record<string, unknown>>(
            `SELECT execution_profile_id, count(*)::int request_count,
              count(*) FILTER (WHERE status='success')::int success_count,
              count(*) FILTER (WHERE status<>'success')::int error_count,
              count(*) FILTER (WHERE metadata_json ? 'first_model_event_latency_ms')::int first_event_sample_count,
              count(*) FILTER (WHERE http_status=429)::int rate_limited_count,
              count(*) FILTER (WHERE http_status BETWEEN 500 AND 599)::int server_error_count,
              count(*) FILTER (WHERE error_category='slow_first_model_event' OR metadata_json->>'errorClass'='slow_first_model_event')::int watchdog_count,
              count(*) FILTER (WHERE attempt_index>1 AND status='success')::int recovery_count,
              percentile_cont(.5) WITHIN GROUP (ORDER BY (metadata_json->>'first_model_event_latency_ms')::double precision)
                FILTER (WHERE metadata_json ? 'first_model_event_latency_ms') p50_first_model_event_ms,
              percentile_cont(.95) WITHIN GROUP (ORDER BY (metadata_json->>'first_model_event_latency_ms')::double precision)
                FILTER (WHERE metadata_json ? 'first_model_event_latency_ms') p95_first_model_event_ms,
              max(started_at) latest_event_at,
              (array_agg(CASE WHEN metadata_json ? 'cooldown_until' THEN 'cooldown'
                WHEN status='success' THEN 'success' ELSE 'failed' END ORDER BY started_at DESC))[1] latest_event_result
             FROM acu_attempts WHERE attempt_kind='provider' AND started_at>=now()-$1::interval
             GROUP BY execution_profile_id`,
            [interval],
          ),
          database.query<Record<string, unknown>>(
            MONITOR_JUDGE_AGGREGATION_SQL,
            [interval],
          ),
          database.query<Record<string, unknown>>(historySql, [interval, bucket, ...catalogValues]),
          database.query<Record<string, unknown>>(
            `SELECT coalesce(channel_id,channel) channel,provider,execution_profile_id,started_at,
              (metadata_json->>'cooldown_until')::timestamptz ended_at,
              coalesce(metadata_json->>'errorClass',error_category,'provider_error') reason,
              coalesce(metadata_json->>'errorClass',error_category) error_class,false manual_pause,false half_open_probe,
              null::text probe_result
             FROM acu_attempts WHERE attempt_kind='provider' AND started_at>=now()-$1::interval
               AND metadata_json ? 'cooldown_until'`,
            [interval],
          ),
          database.query<Record<string, unknown>>(
            `SELECT channel_id channel,null::text provider,null::text execution_profile_id,created_at started_at,
              created_at+(duration_minutes||' minutes')::interval ended_at,'manual_pause' reason,
              'manual_pause' error_class,true manual_pause,false half_open_probe,null::text probe_result
             FROM acu_channel_admin_actions WHERE created_at>=now()-$1::interval`,
            [interval],
          ),
          database.query<Record<string, unknown>>(
            `WITH latest AS (
               SELECT DISTINCT ON (execution_profile_id) execution_profile_id,started_at,status,latency_ms,cost_cny,metadata_json
               FROM acu_profile_probe_attempts ORDER BY execution_profile_id,started_at DESC
             ), daily AS (
               SELECT execution_profile_id,sum(cost_cny) daily_spend,
                 count(*)::int probe_count,count(*) FILTER (WHERE status='success')::int probe_success_count
               FROM acu_profile_probe_attempts WHERE started_at>=date_trunc('day',now()) GROUP BY execution_profile_id
             ), ranged AS (
               SELECT execution_profile_id,
                 count(*) FILTER (WHERE metadata_json->>'probeMode'='full_pool')::int full_pool_probe_count,
                 count(*) FILTER (WHERE metadata_json->>'probeMode'='full_pool' AND status='success')::int full_pool_probe_success_count,
                 count(*) FILTER (WHERE metadata_json->>'probeMode' IS DISTINCT FROM 'full_pool')::int recovery_probe_count,
                 count(*) FILTER (WHERE metadata_json->>'probeMode' IS DISTINCT FROM 'full_pool' AND status='success')::int recovery_probe_success_count,
                 max(started_at) FILTER (WHERE status='success') latest_successful_probe_at,
                 max(started_at) FILTER (WHERE metadata_json->>'probeMode'='full_pool') latest_full_pool_probe_at,
                 max(started_at) latest_range_probe_at,
                 (array_agg(status ORDER BY started_at DESC))[1] latest_range_probe_status,
                 (array_agg(CASE WHEN metadata_json->>'probeMode'='full_pool' THEN 'full_pool' ELSE 'recovery' END ORDER BY started_at DESC))[1] latest_range_probe_mode
               FROM acu_profile_probe_attempts WHERE started_at>=now()-$1::interval GROUP BY execution_profile_id
             ) SELECT latest.*,coalesce(daily.daily_spend,0) daily_spend,
               coalesce(daily.probe_count,0) probe_count,coalesce(daily.probe_success_count,0) probe_success_count,
               coalesce(ranged.full_pool_probe_count,0) full_pool_probe_count,
               coalesce(ranged.full_pool_probe_success_count,0) full_pool_probe_success_count,
               coalesce(ranged.recovery_probe_count,0) recovery_probe_count,
               coalesce(ranged.recovery_probe_success_count,0) recovery_probe_success_count,
               ranged.latest_successful_probe_at,ranged.latest_full_pool_probe_at,ranged.latest_range_probe_at,
               ranged.latest_range_probe_status,ranged.latest_range_probe_mode
             FROM latest LEFT JOIN daily USING(execution_profile_id) LEFT JOIN ranged USING(execution_profile_id)`,
            [interval],
          ),
          database.query<Record<string, unknown>>(
            `SELECT execution_profile_id,channel_id,provider_id,canonical_model_id,protocol,status,
                    http_status,error_class,latency_ms,input_tokens,output_tokens,actual_model,
                    usage_trusted,cost_cny,started_at,completed_at,metadata_json
             FROM acu_profile_probe_attempts
             WHERE started_at>=now()-$1::interval
             ORDER BY started_at DESC`,
            [interval],
          ),
        ]);
        const healthByChannel = new Map(channels.rows.map((row) => [String(row.channel_id), row]));
        const healthByProfile = new Map(profileHealth.rows.map((row) => [String(row.execution_profile_id), row]));
        const aggregateByProfile = new Map(attempts.rows.map((row) => [String(row.execution_profile_id), row]));
        const judgeByProfile = new Map(judges.rows.map((row) => [String(row.execution_profile_id), row]));
        const probeByProfile = new Map(probes.rows.map((row) => [String(row.execution_profile_id), row]));
        const routingEligibleIds = new Set<string>();
        const publicProfiles = serviceConfig.profiles.map((profile) => {
          const channel = healthByChannel.get(profile.channelId ?? profile.channel) ?? {};
          const runtime = healthByProfile.get(profile.executionProfileId) ?? {};
          const aggregate = aggregateByProfile.get(profile.executionProfileId) ?? {};
          const judge = judgeByProfile.get(profile.executionProfileId) ?? {};
          const probe = probeByProfile.get(profile.executionProfileId) ?? {};
          const routingEligibility = monitorRoutingStatus(profile, channel, runtime);
          if (routingEligibility === "eligible") routingEligibleIds.add(profile.executionProfileId);
          const runtimeHealth = deriveRuntimeEligibility({
            profileState: String(runtime.circuit_state ?? profile.health),
            channelState: String(channel.circuit_state ?? "healthy"),
            providerState: "healthy",
            probeState: profile.requiresFreshProbe && !runtime.last_success_at ? "stale" : "fresh",
            enabled: profile.enabled,
            administratorAllowed: profile.administratorAllowed,
          });
          let endpointHost = "";
          try {
            endpointHost = new URL(profile.baseUrl ?? process.env[profile.baseUrlEnv ?? ""] ?? "").host;
          } catch {
            /* absent configuration */
          }
          return {
            executionProfileId: profile.executionProfileId,
            canonicalModel: profile.modelId,
            ...monitorReasoningMetadata(profile),
            protocol: profile.protocols,
            provider: profile.provider,
            channel: profile.channelId ?? profile.channel,
            endpointHost,
            multiplier: Number(profile.observedBillingMultiplier ?? 0),
            effectiveCostStatus: profile.effectiveCostStatus,
            enabled: profile.enabled,
            administratorAllowed: profile.administratorAllowed,
            autoRouteEnabled: profile.autoRouteEnabled !== false,
            routingEligible: routingEligibility === "eligible",
            routingEligibility,
            profileStateRaw: runtimeHealth.profileState,
            channelStateRaw: runtimeHealth.channelState,
            providerStateRaw: runtimeHealth.providerState,
            probeStateRaw: runtimeHealth.probeState,
            effectiveState: runtimeHealth.effectiveState,
            blockingScope: runtimeHealth.blockingScope,
            statusReason: runtimeHealth.statusReason ?? routingEligibility,
            state: combinedMonitorState(profile, channel, runtime),
            channelState: channel.circuit_state ?? "healthy",
            profileState: runtime.circuit_state ?? profile.health,
            usageTrusted: runtime.usage_trusted ?? profile.usageTrusted,
            recentSuccessRate: Number(runtime.recent_success_rate ?? 0),
            requestCount: Number(aggregate.request_count ?? 0),
            successCount: Number(aggregate.success_count ?? 0),
            errorCount: Number(aggregate.error_count ?? 0),
            judgeAttemptCount: Number(judge.judge_attempt_count ?? 0),
            judgeSuccessCount: Number(judge.judge_success_count ?? 0),
            firstEventSampleCount: Number(aggregate.first_event_sample_count ?? 0),
            consecutiveFailures: Number(runtime.consecutive_failures ?? 0),
            p50FirstModelEventLatencyMs: Number(aggregate.p50_first_model_event_ms ?? 0),
            p95FirstModelEventLatencyMs: Number(aggregate.p95_first_model_event_ms ?? 0),
            lastError: runtime.error_class ?? channel.error_class,
            lastSuccessAt: runtime.last_success_at,
            cooldownUntil: runtime.cooldown_until ?? channel.cooldown_until,
            requiresFreshProbe: profile.requiresFreshProbe === true,
            lastProbeAt: probe.started_at,
            probeStatus: probe.status,
            probeLatencyMs: Number(probe.latency_ms ?? 0),
            probeCostCny: Number(probe.cost_cny ?? 0),
            probeDailySpendCny: Number(probe.daily_spend ?? 0),
            probeSuccessRate: Number(probe.probe_count ?? 0) > 0
              ? Number(probe.probe_success_count ?? 0) / Number(probe.probe_count) : null,
            fullPoolProbeCount: Number(probe.full_pool_probe_count ?? 0),
            fullPoolProbeSuccessCount: Number(probe.full_pool_probe_success_count ?? 0),
            recoveryProbeCount: Number(probe.recovery_probe_count ?? 0),
            recoveryProbeSuccessCount: Number(probe.recovery_probe_success_count ?? 0),
            latestSuccessfulProbeAt: probe.latest_successful_probe_at ?? null,
            latestFullPoolProbeAt: probe.latest_full_pool_probe_at ?? null,
            healthEvents: [
              aggregate.latest_event_at ? { source: "production", result: aggregate.latest_event_result, at: aggregate.latest_event_at } : null,
              judge.latest_event_at ? { source: "judge", result: judge.latest_event_result, at: judge.latest_event_at } : null,
              probe.latest_range_probe_at ? {
                source: probe.latest_range_probe_mode === "full_pool" ? "full_pool_probe" : "recovery_probe",
                result: probe.latest_range_probe_status === "success" ? "success" : "failed",
                at: probe.latest_range_probe_at,
              } : null,
            ].filter(Boolean),
            probeFreshness: profile.requiresFreshProbe
              ? probe.started_at && Date.now() - new Date(String(probe.started_at)).getTime() <= 120 * 60_000 ? "fresh" : "stale"
              : "not_required",
            nextEligibleProbeAt: runtime.cooldown_until ?? channel.cooldown_until ?? null,
            profileUtility: null, profileRank: null, profileCandidateCount: null,
            profileCost: null, profileLatencyMs: null,
            costUtility: null, speedUtility: null, reliabilityUtility: null,
            costContribution: null, speedContribution: null, reliabilityContribution: null,
            metricSource: null, formulaVersion: null,
          };
        });
        const monitorAggregates = new Map<string, MonitorProfileAggregate>(attempts.rows.map((row) => [String(row.execution_profile_id), {
          requestCount: Number(row.request_count ?? 0),
          successCount: Number(row.success_count ?? 0),
          firstEventSampleCount: Number(row.first_event_sample_count ?? 0),
          firstEventP50Ms: row.p50_first_model_event_ms == null ? undefined : Number(row.p50_first_model_event_ms),
        }]));
        const profileScores = scoreMonitorProfiles(
          profiles.map((item) => item.profile).filter((profile) => routingEligibleIds.has(profile.executionProfileId)),
          monitorAggregates,
          { supplyStrategy, scenario },
          monitorUtilityPolicy,
        );
        const scoredCountByGroup = new Map<string, number>();
        for (const profile of publicProfiles) {
          const group = `${profile.canonicalModel}\n${profile.protocol[0] ?? ""}`;
          if (profileScores.has(profile.executionProfileId)) {
            scoredCountByGroup.set(group, (scoredCountByGroup.get(group) ?? 0) + 1);
          }
        }
        for (const profile of publicProfiles) {
          const score = profileScores.get(profile.executionProfileId);
          if (!score) continue;
          const group = `${profile.canonicalModel}\n${profile.protocol[0] ?? ""}`;
          Object.assign(profile, {
            profileUtility: score.profileUtility,
            profileRank: score.rank,
            profileCandidateCount: scoredCountByGroup.get(group) ?? 0,
            profileCost: score.profileCost,
            profileLatencyMs: score.profileLatencyMs ?? null,
            costUtility: score.costUtility,
            speedUtility: score.speedUtility,
            reliabilityUtility: score.reliabilityUtility,
            costContribution: score.costContribution,
            speedContribution: score.speedContribution,
            reliabilityContribution: score.reliabilityContribution,
            metricSource: score.metricSource,
            formulaVersion: score.formulaVersion,
          });
        }
        const activeModelPool = [...new Set(serviceConfig.profiles.map((profile) => profile.modelId))]
          .map((modelId) => {
            const catalog = getAcuModel(modelId);
            const modelProfiles = publicProfiles.filter((profile) => profile.canonicalModel === modelId);
            const activeProfiles = modelProfiles.filter((profile) => profile.enabled && profile.administratorAllowed
              && (profile.autoRouteEnabled !== false || profile.routingEligible));
            const healthyProfiles = activeProfiles.filter((profile) => profile.routingEligibility === "eligible");
            const ordered = [...healthyProfiles].sort((left, right) =>
              Number(left.multiplier ?? Number.POSITIVE_INFINITY) - Number(right.multiplier ?? Number.POSITIVE_INFINITY));
            const best = ordered[0];
            const backup = ordered.find((profile) => profile.provider !== best?.provider) ?? ordered[1];
            const routingCandidates = routingCandidatesForModel(modelId, serviceConfig.profiles);
            return {
              modelId,
              vendor: catalog?.provider ?? "Unknown",
              modelCategory: "text_agent",
              capabilityTier: capabilityTier(modelId),
              protocols: [...new Set(activeProfiles.flatMap((profile) => profile.protocol))],
              verificationStatus: activeProfiles.length > 0 ? "verified" : "discovered",
              activeProfileCount: activeProfiles.length,
              healthyProfileCount: healthyProfiles.length,
              independentProviderCount: new Set(activeProfiles.map((profile) => profile.provider)).size,
              currentBestChannel: best?.channel ?? null,
              currentMultiplier: best?.multiplier ?? null,
              backupChannel: backup?.channel ?? null,
              autoRouteEnabled: activeProfiles.length > 0,
              exclusionReason: healthyProfiles.length > 0
                ? null : [...new Set(activeProfiles.map((profile) => profile.routingEligibility))].join(",") || "no_active_profile",
              profiles: modelProfiles,
              routingCandidates,
            };
          });
        let supplyInventory: Array<Record<string, unknown>> = [];
        try {
          const [discovery, preflight] = await Promise.all([
            readFile(process.env.ACU_PROVIDER_DISCOVERY_FILE ?? "/app/config/provider-channel-model-discovery.json", "utf8").then((value) => JSON.parse(value) as { channels?: [] }),
            readFile(process.env.ACU_PROVIDER_PREFLIGHT_FILE ?? "/app/config/provider-channel-preflight-observations.json", "utf8").then((value) => JSON.parse(value) as { observations?: [] }),
          ]);
          supplyInventory = mergeSupplyInventory(discovery.channels ?? [], serviceConfig.profiles, preflight.observations ?? []);
        } catch {
          /* inventory is optional at runtime */
        }
        const activeModelIds = new Set(activeModelPool.map((model) => model.modelId));
        const discoveredModelIds = [...new Set(supplyInventory
          .map((row) => String(row.canonicalModel ?? ""))
          .filter(Boolean))];
        const modelPool = [
          ...activeModelPool,
          ...discoveredModelIds.filter((modelId) => !activeModelIds.has(modelId)).map((modelId) => {
            const catalog = getAcuModel(modelId);
            const discovered = supplyInventory.filter((row) => row.canonicalModel === modelId);
            return {
              modelId,
              vendor: catalog?.provider ?? "Unknown",
              modelCategory: "text_agent",
              capabilityTier: "LUNA",
              protocols: [...new Set(discovered.map((row) => String(row.protocol ?? "")).filter(Boolean))],
              verificationStatus: "rejected",
              activeProfileCount: 0,
              healthyProfileCount: 0,
              independentProviderCount: new Set(discovered.map((row) => String(row.providerId ?? ""))).size,
              currentBestChannel: null,
              currentMultiplier: null,
              backupChannel: null,
              autoRouteEnabled: false,
              exclusionReason: "minimum_validation_not_passed",
              profiles: [],
              routingCandidates: [],
            };
          }),
        ];
        const activeStateIntervals = channels.rows.flatMap((channel) => {
          const state = String(channel.circuit_state ?? "");
          if (state !== "open" && state !== "half_open") return [];
          return [
            {
              channel: channel.channel_id,
              provider: channel.provider_id,
              execution_profile_id: null,
              started_at: channel.last_failure_at ?? channel.updated_at,
              ended_at: channel.cooldown_until ?? new Date().toISOString(),
              reason: state === "half_open" ? "half_open_probe" : channel.error_class,
              error_class: channel.error_class,
              manual_pause: channel.error_class === "manual_pause",
              half_open_probe: state === "half_open",
              probe_result: channel.half_open_probe_in_flight ? "in_flight" : "available",
            },
          ];
        });
        return {
          range,
          supplyStrategy,
          scenario,
          profiles: publicProfiles,
          history: history.rows,
          cooldownIntervals: [...cooldowns.rows, ...adminPauses.rows, ...activeStateIntervals],
          probeHistory: probeHistory.rows.map((row) => ({
            ...row,
            probeMode: monitorProbeMode(row.metadata_json),
            trigger: row.metadata_json && typeof row.metadata_json === "object"
              ? String((row.metadata_json as Record<string, unknown>).trigger ?? "") : "",
          })),
          supplyInventory,
          modelPool,
          generatedAt: new Date().toISOString(),
        };
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
        return {
          channelId,
          state: "open",
          cooldownUntil: cooldownUntil.toISOString(),
          recovery: "half_open_probe",
        };
      },
    },
    adminSelectionCorridor: {
      token: serviceConfig.adminTraceToken,
      load: (inputTokens, expectedOutputTokens, policy) => processor.selectionCorridor(inputTokens, expectedOutputTokens, policy),
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
      const migration = await database.query<{ migration_version: string }>("SELECT migration_version FROM acu_schema_migrations ORDER BY migration_version DESC LIMIT 1");
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
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  startAlphaService().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "ACU Router Alpha failed to start");
    process.exitCode = 1;
  });
}
