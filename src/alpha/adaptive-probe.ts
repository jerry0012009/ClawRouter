import { randomUUID } from "node:crypto";
import {
  applyAttemptOutcome,
  classifyAttemptOutcome,
  type AttemptOutcome,
  type HealthScope,
  type HealthSnapshot,
} from "./channel-health.js";
import type { AlphaDatabase } from "./database.js";
import type { NativeProviderAdapter } from "./provider.js";
import { providerCostBreakdown } from "./provider-economics.js";
import type { AlphaExecutionProfile } from "./routing.js";
import { AlphaRepository, alphaId } from "./repository.js";
import { parseProviderUsage } from "./usage.js";

type Json = Record<string, unknown>;

export function adaptiveProbeIntervalMinutes(userRequestsLast30Minutes: number): number | null {
  if (userRequestsLast30Minutes <= 0) return null;
  if (userRequestsLast30Minutes <= 5) return 60;
  if (userRequestsLast30Minutes <= 20) return 30;
  return 15;
}

export const FULL_POOL_BUDGET_FRACTION = 0.8;
export const ACTIVE_RECOVERY_WINDOW_MS = 6 * 60 * 60_000;

export function fullPoolBudgetLimit(dailyBudgetCny: number, manual: boolean): number {
  return manual ? dailyBudgetCny : dailyBudgetCny * FULL_POOL_BUDGET_FRACTION;
}

export function recoveredAfterLastFailure(
  health: Pick<HealthSnapshot, "lastSuccessAt" | "lastFailureAt">,
): boolean {
  return Boolean(
    health.lastSuccessAt &&
    (!health.lastFailureAt || health.lastSuccessAt.getTime() > health.lastFailureAt.getTime()),
  );
}

export function recoveryCooldownDue(
  health: Pick<HealthSnapshot, "state" | "cooldownUntil">,
  now = Date.now(),
): boolean {
  return (
    ["open", "half_open"].includes(health.state) &&
    (!health.cooldownUntil || health.cooldownUntil.getTime() <= now)
  );
}

export function activeRecoveryRequired(input: {
  recoveryStartedAt: Date;
  recentModelDemand: boolean;
  now?: number;
}): boolean {
  return (
    input.recentModelDemand ||
    (input.now ?? Date.now()) - input.recoveryStartedAt.getTime() <= ACTIVE_RECOVERY_WINDOW_MS
  );
}

export function fullPoolProbeDue(input: {
  manual: boolean;
  lastCompletedAt?: Date;
  userRequestsLastSixHours: number;
  now?: number;
  intervalMs?: number;
}): boolean {
  if (input.manual) return true;
  const now = input.now ?? Date.now();
  const intervalMs = input.intervalMs ?? 6 * 60 * 60_000;
  if (input.lastCompletedAt && now - input.lastCompletedAt.getTime() < intervalMs) return false;
  return input.userRequestsLastSixHours > 0;
}

export function deriveProbeValidation(input: {
  responseOk: boolean;
  validStream: boolean;
  usageTrusted: boolean;
  actualModel?: string;
  acceptedModels: Set<string>;
}): {
  actualModelVerified: boolean;
  actualModelMismatch: boolean;
  validProbe: boolean;
  errorCode?: string;
} {
  const actualModelVerified =
    typeof input.actualModel === "string" &&
    input.actualModel.length > 0 &&
    input.acceptedModels.has(input.actualModel);
  const actualModelMismatch = Boolean(input.actualModel && !actualModelVerified);
  const errorCode = !input.responseOk
    ? undefined
    : !input.validStream
      ? "protocol_incompatible"
      : !input.usageTrusted
        ? "usage_untrusted"
        : !input.actualModel
          ? "actual_model_missing"
          : actualModelMismatch
            ? "actual_model_mismatch"
            : undefined;
  return {
    actualModelVerified,
    actualModelMismatch,
    validProbe: input.responseOk && input.validStream && input.usageTrusted && actualModelVerified,
    errorCode,
  };
}

export function adaptiveProbePayload(protocol: string, providerModel: string): Json {
  return protocol === "messages"
    ? {
        model: providerModel,
        max_tokens: 4,
        stream: true,
        messages: [{ role: "user", content: "只输出 OK" }],
      }
    : { model: providerModel, input: "只输出 OK", max_output_tokens: 16, stream: true };
}

export function validNativeProbeStream(protocol: string, body: Buffer): boolean {
  let terminal = false;
  let modelEvent = false;
  for (const line of body.toString("utf8").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data) as Json;
      if (protocol === "messages") {
        terminal ||= event.type === "message_stop";
        modelEvent ||= event.type === "content_block_start" || event.type === "content_block_delta";
      } else {
        terminal ||= event.type === "response.completed";
      }
    } catch {
      return false;
    }
  }
  return terminal && (protocol !== "messages" || modelEvent);
}

export function probeResponseMetadata(
  protocol: string,
  response: Response | undefined,
  body: Buffer,
  actualModel: string | undefined,
  usageTrusted: boolean,
  errorCode: string | undefined,
): Json {
  const text = body.toString("utf8");
  const observedEventTypes = [
    ...new Set(
      text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("event:"))
        .map((line) => line.slice("event:".length).trim())
        .filter(Boolean),
    ),
  ];
  const hasMessageStart = /"type"\s*:\s*"message_start"/.test(text);
  const hasModelEvent = /"model"\s*:\s*"[^"]+"/.test(text);
  const hasMessageStop = /"type"\s*:\s*"message_stop"/.test(text);
  const failures = errorCode ? [errorCode] : [];
  return {
    responseContentType: response?.headers.get("content-type") ?? null,
    responseByteLength: body.byteLength,
    observedEventTypes,
    hasMessageStart,
    hasModelEvent,
    hasMessageStop,
    hasUsage: usageTrusted,
    actualModel: actualModel ?? null,
    primaryErrorCode: errorCode ?? null,
    validationFailures: failures,
    responsePreview: errorCode
      ? text
          .slice(0, 2048)
          .replace(/(authorization|x-api-key|cookie)\s*[:=]\s*[^\n&]+/gi, "$1: [redacted]")
      : undefined,
    protocol,
  };
}

export type AdaptiveProbeWorkerOptions = {
  database: AlphaDatabase;
  profiles: AlphaExecutionProfile[];
  adapters: Map<string, NativeProviderAdapter>;
  dailyBudgetCny: number;
  timeoutMs?: number;
  fullPoolIntervalMs?: number;
};

const MANUAL_FULL_POOL_QUEUE_ID = "__full_pool__";

export class AdaptiveProbeWorker {
  private running = false;
  private timer?: NodeJS.Timeout;
  private readonly workerId = randomUUID();

  constructor(private readonly options: AdaptiveProbeWorkerOptions) {}

  start(): void {
    this.timer = setInterval(() => void this.runOnce(), 60_000);
    this.timer.unref();
  }

  wake(): void {
    queueMicrotask(() => void this.runOnce());
  }

  enqueue(executionProfileId: string): void {
    void new AlphaRepository(this.options.database)
      .enqueueProfileProbe(executionProfileId)
      .then(() => this.wake())
      .catch(() => undefined);
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const lease = await this.options.database.query(
        `UPDATE acu_probe_worker_lease SET holder_id=$1,lease_until=now()+interval '2 minutes',updated_at=now()
         WHERE singleton=true AND (lease_until<=now() OR holder_id=$1) RETURNING singleton`,
        [this.workerId],
      );
      if (!lease.rowCount) return;
      if (!(await this.runTargetedRecoveryIfEligible())) await this.runFullPoolIfEligible();
    } finally {
      await this.options.database
        .query(
          "UPDATE acu_probe_worker_lease SET lease_until=now(),updated_at=now() WHERE singleton=true AND holder_id=$1",
          [this.workerId],
        )
        .catch(() => undefined);
      this.running = false;
    }
  }

  private async runTargetedRecoveryIfEligible(): Promise<boolean> {
    const queued = await this.options.database.query<{
      execution_profile_id: string;
      enqueued_at: Date;
    }>(
      `SELECT execution_profile_id,enqueued_at FROM acu_profile_probe_queue
       WHERE execution_profile_id<>$1 ORDER BY enqueued_at LIMIT 100`,
      [MANUAL_FULL_POOL_QUEUE_ID],
    );
    if (!queued.rowCount) return false;
    const repository = new AlphaRepository(this.options.database);
    for (const row of queued.rows) {
      const profile = this.options.profiles.find(
        (candidate) => candidate.executionProfileId === row.execution_profile_id,
      );
      if (
        !profile ||
        profile.verificationStatus === "rejected" ||
        !profile.enabled ||
        !profile.administratorAllowed ||
        !this.options.adapters.has(profile.executionProfileId)
      ) {
        await repository.deleteProfileProbe(row.execution_profile_id);
        continue;
      }
      const channelId = profile.channelId ?? profile.channel;
      const [channel, runtime] = await Promise.all([
        repository.channelHealth(channelId),
        repository.profileHealth(profile.executionProfileId),
      ]);
      const channelBlocked = channel && ["open", "half_open"].includes(channel.state);
      if (runtime && recoveredAfterLastFailure(runtime) && !channelBlocked) {
        await repository.deleteProfileProbeIfRecovered(profile.executionProfileId);
        continue;
      }
      const sameModelProfileIds = this.options.profiles
        .filter((candidate) => candidate.modelId === profile.modelId)
        .map((candidate) => candidate.executionProfileId);
      const recentModelDemand = await repository.hasRecentModelDemand(
        profile.modelId,
        sameModelProfileIds,
      );
      if (
        !activeRecoveryRequired({ recoveryStartedAt: new Date(row.enqueued_at), recentModelDemand })
      ) {
        await repository.deleteProfileProbe(profile.executionProfileId);
        continue;
      }
      const blocked = [channel, runtime].filter(
        (health): health is HealthSnapshot =>
          health !== undefined && ["open", "half_open"].includes(health.state),
      );
      if (blocked.some((health) => !recoveryCooldownDue(health))) continue;
      const budget = await this.options.database.query<{ spend: string }>(
        `SELECT coalesce(sum(cost_cny) FILTER (WHERE started_at>=date_trunc('day',now())),0)::text spend
         FROM acu_profile_probe_attempts`,
      );
      if (Number(budget.rows[0]?.spend ?? 0) >= this.options.dailyBudgetCny) return false;
      let channelClaimed = false;
      if (channel && ["open", "half_open"].includes(channel.state)) {
        channelClaimed = await repository.claimHalfOpenProbe("channel", channelId);
        if (!channelClaimed) continue;
      }
      if (
        runtime &&
        ["open", "half_open"].includes(runtime.state) &&
        !(await repository.claimHalfOpenProbe("profile", profile.executionProfileId))
      ) {
        if (channelClaimed) await repository.releaseHalfOpenProbe("channel", channelId);
        continue;
      }
      const result = await this.probe(
        profile,
        repository,
        channel ?? { state: "healthy", consecutiveFailures: 0, recentSuccessRate: 1 },
        runtime ?? { state: "healthy", consecutiveFailures: 0, recentSuccessRate: 1 },
      );
      if (result.success) await repository.deleteProfileProbe(profile.executionProfileId);
      return true;
    }
    return false;
  }

  private async runFullPoolIfEligible(): Promise<boolean> {
    const requested = await this.options.database.query(
      "SELECT 1 FROM acu_profile_probe_queue WHERE execution_profile_id=$1",
      [MANUAL_FULL_POOL_QUEUE_ID],
    );
    const manual = Boolean(requested.rowCount);
    const intervalMs = this.options.fullPoolIntervalMs ?? 6 * 60 * 60_000;
    const latest = await this.options.database.query<{ started_at: Date | null }>(
      "SELECT max(started_at) started_at FROM acu_full_pool_probe_runs",
    );
    const lastRunAt = latest.rows[0]?.started_at;
    const activity = manual
      ? { rowCount: 0 }
      : await this.options.database.query(
          "SELECT 1 FROM acu_logical_requests WHERE started_at>=now()-interval '6 hours' LIMIT 1",
        );
    if (
      !fullPoolProbeDue({
        manual,
        lastCompletedAt: lastRunAt ? new Date(lastRunAt) : undefined,
        userRequestsLastSixHours: activity.rowCount ?? 0,
        intervalMs,
      })
    )
      return false;
    const budget = await this.options.database.query<{ spend: string }>(
      `SELECT coalesce(sum(cost_cny) FILTER (WHERE started_at>=date_trunc('day',now())),0)::text spend
       FROM acu_profile_probe_attempts`,
    );
    const budgetLimit = fullPoolBudgetLimit(this.options.dailyBudgetCny, manual);
    if (Number(budget.rows[0]?.spend ?? 0) >= budgetLimit) return false;
    const runId = `full_pool_${randomUUID().replaceAll("-", "")}`;
    const lastProbes = await this.options.database.query<{
      execution_profile_id: string;
      last_probe_at: Date;
    }>(
      `SELECT execution_profile_id,max(started_at) last_probe_at FROM acu_profile_probe_attempts
       GROUP BY execution_profile_id`,
    );
    const lastProbeByProfile = new Map(
      lastProbes.rows.map((row) => [
        row.execution_profile_id,
        new Date(row.last_probe_at).getTime(),
      ]),
    );
    const queuedProfiles = await this.options.database.query<{ execution_profile_id: string }>(
      "SELECT execution_profile_id FROM acu_profile_probe_queue WHERE execution_profile_id<>$1",
      [MANUAL_FULL_POOL_QUEUE_ID],
    );
    const queuedIds = new Set(queuedProfiles.rows.map((row) => row.execution_profile_id));
    const profiles = this.options.profiles
      .filter(
        (profile) =>
          profile.enabled &&
          profile.administratorAllowed &&
          profile.verificationStatus !== "rejected" &&
          this.options.adapters.has(profile.executionProfileId) &&
          (manual || profile.autoRouteEnabled !== false || profile.requiresFreshProbe === true),
      )
      .sort(
        (left, right) =>
          (lastProbeByProfile.get(left.executionProfileId) ?? 0) -
          (lastProbeByProfile.get(right.executionProfileId) ?? 0),
      );
    await this.options.database.query(
      `INSERT INTO acu_full_pool_probe_runs
        (full_pool_probe_run_id,status,trigger,profile_count,metadata_json)
       VALUES ($1,'running',$2,$3,$4::jsonb)`,
      [
        runId,
        manual ? "manual" : "scheduled_activity",
        profiles.length,
        JSON.stringify({ intervalHours: intervalMs / 3_600_000, userActivityRequired: !manual }),
      ],
    );
    let attempted = 0;
    let success = 0;
    let failed = 0;
    let costCny = 0;
    let status = "completed";
    const failedChannels = new Set<string>();
    try {
      const repository = new AlphaRepository(this.options.database);
      for (const profile of profiles) {
        const channelId = profile.channelId ?? profile.channel;
        if (failedChannels.has(channelId)) continue;
        const [channels, runtimes] = await Promise.all([
          repository.batchChannelHealth([channelId]),
          repository.batchProfileHealth([profile.executionProfileId]),
        ]);
        const channelHealth = channels.get(channelId);
        const profileHealth = runtimes.get(profile.executionProfileId);
        if (
          queuedIds.has(profile.executionProfileId) &&
          [channelHealth, profileHealth].some(
            (health) => health && ["open", "half_open"].includes(health.state),
          )
        )
          continue;
        const currentSpend = Number(budget.rows[0]?.spend ?? 0) + costCny;
        if (currentSpend >= budgetLimit) {
          status = "budget_exhausted";
          break;
        }
        await this.options.database.query(
          `UPDATE acu_probe_worker_lease SET lease_until=now()+interval '2 minutes',updated_at=now()
           WHERE singleton=true AND holder_id=$1`,
          [this.workerId],
        );
        const result = await this.probe(
          profile,
          repository,
          channelHealth ?? { state: "healthy", consecutiveFailures: 0, recentSuccessRate: 1 },
          profileHealth ?? { state: "healthy", consecutiveFailures: 0, recentSuccessRate: 1 },
          {
            probeMode: "full_pool",
            fullPoolProbeRunId: runId,
            trigger: manual ? "manual" : "scheduled_activity",
          },
        );
        attempted += 1;
        costCny += result.costCny;
        if (result.success) {
          success += 1;
          await repository.deleteProfileProbe(profile.executionProfileId);
        } else {
          failed += 1;
          const sameModelProfileIds = this.options.profiles
            .filter((candidate) => candidate.modelId === profile.modelId)
            .map((candidate) => candidate.executionProfileId);
          if (await repository.hasRecentModelDemand(profile.modelId, sameModelProfileIds)) {
            await repository.enqueueProfileProbe(profile.executionProfileId);
          } else {
            await repository.deleteProfileProbe(profile.executionProfileId);
          }
          if (result.failureScope === "channel") failedChannels.add(channelId);
        }
        await this.options.database.query(
          `UPDATE acu_full_pool_probe_runs SET attempted_count=$2,success_count=$3,failed_count=$4,cost_cny=$5
           WHERE full_pool_probe_run_id=$1`,
          [runId, attempted, success, failed, costCny.toFixed(10)],
        );
      }
    } catch (error) {
      status = "failed";
      await this.options.database.query(
        `UPDATE acu_full_pool_probe_runs SET metadata_json=metadata_json||$2::jsonb
         WHERE full_pool_probe_run_id=$1`,
        [runId, JSON.stringify({ error: error instanceof Error ? error.message : String(error) })],
      );
    }
    await Promise.all([
      this.options.database.query(
        `UPDATE acu_full_pool_probe_runs SET status=$2,attempted_count=$3,success_count=$4,failed_count=$5,
          cost_cny=$6,completed_at=now() WHERE full_pool_probe_run_id=$1`,
        [runId, status, attempted, success, failed, costCny.toFixed(10)],
      ),
      manual
        ? this.options.database.query(
            "DELETE FROM acu_profile_probe_queue WHERE execution_profile_id=$1",
            [MANUAL_FULL_POOL_QUEUE_ID],
          )
        : Promise.resolve(),
    ]);
    return true;
  }

  private async probe(
    profile: AlphaExecutionProfile,
    repository: AlphaRepository,
    channelHealth: HealthSnapshot,
    profileHealth: HealthSnapshot,
    probeMetadata: Json = {},
  ): Promise<{ success: boolean; costCny: number; failureScope: HealthScope }> {
    const protocol = profile.protocols.includes("responses") ? "responses" : profile.protocols[0];
    const providerModel = profile.providerModelId ?? profile.modelId;
    const payload = adaptiveProbePayload(protocol, providerModel);
    const body = Buffer.from(JSON.stringify(payload));
    const startedAt = new Date();
    const probeAttemptId = `probe_${alphaId("att").slice(4)}`;
    let response: Response | undefined;
    let responseBody = Buffer.alloc(0);
    let outcome: AttemptOutcome;
    let usageTrusted = false;
    let inputTokens = 0n;
    let cachedInputTokens = 0n;
    let cacheCreationInputTokens = 0n;
    let outputTokens = 0n;
    let reasoningTokens = 0n;
    let actualModel: string | undefined;
    let costCny = 0;
    let costBreakdown: Json = {};
    try {
      response = await this.options.adapters.get(profile.executionProfileId)!.execute({
        protocol,
        path: protocol === "messages" ? "/v1/messages" : "/v1/responses",
        query: "",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "user-agent": "acu-adaptive-probe/1",
        },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
      responseBody = Buffer.from(await response.arrayBuffer());
      const usage = parseProviderUsage({
        protocol,
        body: responseBody,
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        requestedModel: profile.modelId,
        requestBytes: body.byteLength,
        billingPrice: profile.billingPrice,
      });
      inputTokens = usage.inputTokens;
      cachedInputTokens = usage.cachedInputTokens;
      cacheCreationInputTokens = usage.cacheCreationInputTokens ?? 0n;
      outputTokens = usage.outputTokens;
      reasoningTokens = usage.reasoningTokens;
      actualModel = usage.actualModel;
      usageTrusted = usage.usageSource === "provider_usage";
      const acceptedModels = new Set([
        profile.modelId,
        providerModel,
        ...(profile.actualModelAliases ?? []),
      ]);
      const validStream =
        (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream") &&
        validNativeProbeStream(protocol, responseBody);
      const probeValidation = deriveProbeValidation({
        responseOk: response.ok,
        validStream,
        usageTrusted,
        actualModel,
        acceptedModels,
      });
      outcome = {
        success: probeValidation.validProbe,
        httpStatus: response.status,
        errorCode: probeValidation.errorCode,
        errorMessage:
          response.ok && validStream ? undefined : responseBody.toString("utf8").slice(0, 512),
        usageTrusted,
        actualModelMismatch: probeValidation.actualModelMismatch,
        actualModelVerified: probeValidation.actualModelVerified,
        totalLatencyMs: Date.now() - startedAt.getTime(),
      };
      if (profile.economics && usageTrusted) {
        const breakdown = providerCostBreakdown(profile.economics, Number(usage.providerCostUsd));
        costCny = breakdown.effectiveCashCostCny;
        costBreakdown = {
          catalogNominalCostUsd: breakdown.nominalProviderCostUsd,
          billingMultiplier: profile.economics.observedBillingMultiplier,
          providerBalanceCharge: breakdown.providerBalanceCharge,
          providerBalanceCurrency: breakdown.providerBalanceCurrency,
          providerCreditCashCostCny: breakdown.providerCreditCashCostCny,
          effectiveCashCostCny: breakdown.effectiveCashCostCny,
          effectiveCostStatus: breakdown.effectiveCostStatus,
          effectiveCostSource: breakdown.effectiveCostSource,
          effectiveCostVersion: breakdown.effectiveCostVersion,
        };
      } else if (profile.economics) {
        costBreakdown = {
          effectiveCostStatus: "unavailable",
          costUnavailableReason: "provider_usage_unavailable",
          untrustedEstimatedNominalCostUsd: Number(usage.providerCostUsd),
          billingMultiplier: profile.economics.observedBillingMultiplier,
          providerCreditCashCostCny:
            profile.economics.rechargeCashCny !== null &&
            profile.economics.creditsReceivedUsd !== null
              ? profile.economics.rechargeCashCny / profile.economics.creditsReceivedUsd
              : null,
        };
      }
    } catch (error) {
      outcome = {
        success: false,
        errorCode: error instanceof Error ? error.name : "probe_error",
        errorMessage: error instanceof Error ? error.message : String(error),
        totalLatencyMs: Date.now() - startedAt.getTime(),
      };
    }
    let classified = classifyAttemptOutcome(outcome, profileHealth.consecutiveFailures);
    if (classified.scope === "channel")
      classified = classifyAttemptOutcome(outcome, channelHealth.consecutiveFailures);
    const validProbe =
      classified.errorClass === "none" &&
      outcome.success &&
      outcome.usageTrusted === true &&
      outcome.actualModelVerified === true;
    const updates: Array<Promise<void>> = [];
    const channelWasBlocked = ["open", "half_open"].includes(channelHealth.state);
    const profileWasBlocked = ["open", "half_open"].includes(profileHealth.state);
    if (classified.scope === "channel" || (validProbe && channelWasBlocked)) {
      updates.push(
        repository.saveChannelHealth({
          channelId: profile.channelId ?? profile.channel,
          providerId: profile.provider,
          snapshot: applyAttemptOutcome(channelHealth, outcome, startedAt),
        }),
      );
    }
    if (classified.scope === "profile" || validProbe) {
      updates.push(
        repository.saveProfileHealth({
          executionProfileId: profile.executionProfileId,
          channelId: profile.channelId ?? profile.channel,
          providerId: profile.provider,
          canonicalModelId: profile.modelId,
          protocol,
          snapshot: applyAttemptOutcome(profileHealth, outcome, startedAt),
          usageTrusted: classified.usageTrusted && usageTrusted && profile.usageTrusted !== false,
          actualModelVerified: outcome.actualModelVerified === true,
          healthReason: classified.errorClass,
        }),
      );
    }
    await Promise.all([
      ...updates,
      this.options.database.query(
        `INSERT INTO acu_profile_probe_attempts
          (probe_attempt_id,execution_profile_id,channel_id,provider_id,canonical_model_id,protocol,status,
           http_status,error_class,latency_ms,input_tokens,output_tokens,actual_model,usage_trusted,cost_cny,
           metadata_json,started_at,completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,now())`,
        [
          probeAttemptId,
          profile.executionProfileId,
          profile.channelId ?? profile.channel,
          profile.provider,
          profile.modelId,
          protocol,
          validProbe ? "success" : "failed",
          response?.status ?? null,
          classified.errorClass,
          outcome.totalLatencyMs ?? null,
          inputTokens.toString(),
          outputTokens.toString(),
          actualModel ?? null,
          usageTrusted,
          costCny.toFixed(10),
          JSON.stringify({
            rawResponseBytes: responseBody.byteLength,
            inputTokens: inputTokens.toString(),
            cachedInputTokens: cachedInputTokens.toString(),
            cacheCreationInputTokens: cacheCreationInputTokens.toString(),
            outputTokens: outputTokens.toString(),
            reasoningTokens: reasoningTokens.toString(),
            actualModel: actualModel ?? null,
            usageSource: usageTrusted ? "provider_usage" : "unavailable",
            errorCode: outcome.errorCode ?? null,
            errorMessage: outcome.errorMessage ?? null,
            costBreakdown,
            ...probeResponseMetadata(
              protocol,
              response,
              responseBody,
              actualModel,
              usageTrusted,
              outcome.errorCode ?? classified.errorClass,
            ),
            ...probeMetadata,
          }),
          startedAt,
        ],
      ),
    ]);
    if (!validProbe && classified.scope !== "channel" && channelWasBlocked) {
      await repository.releaseHalfOpenProbe("channel", profile.channelId ?? profile.channel);
    }
    if (!validProbe && classified.scope !== "profile" && profileWasBlocked) {
      await repository.releaseHalfOpenProbe("profile", profile.executionProfileId);
    }
    return { success: validProbe, costCny, failureScope: validProbe ? "none" : classified.scope };
  }
}
