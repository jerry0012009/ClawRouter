import { randomUUID } from "node:crypto";
import { applyAttemptOutcome, classifyAttemptOutcome, type AttemptOutcome, type HealthSnapshot } from "./channel-health.js";
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

export function probeBackoffMinutes(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  if (consecutiveFailures === 1) return 5;
  if (consecutiveFailures === 2) return 15;
  if (consecutiveFailures === 3) return 60;
  return 360;
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
    void this.options.database.query(
      `INSERT INTO acu_profile_probe_queue (execution_profile_id,enqueued_at)
       VALUES ($1,now()) ON CONFLICT (execution_profile_id) DO UPDATE
       SET enqueued_at=LEAST(acu_profile_probe_queue.enqueued_at,excluded.enqueued_at)`,
      [executionProfileId],
    ).then(() => this.wake()).catch(() => undefined);
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
      await this.runEligibleProbe();
    } finally {
      await this.options.database.query(
        "UPDATE acu_probe_worker_lease SET lease_until=now(),updated_at=now() WHERE singleton=true AND holder_id=$1",
        [this.workerId],
      ).catch(() => undefined);
      this.running = false;
    }
  }

  private async runEligibleProbe(): Promise<void> {
    if (await this.runFullPoolIfEligible()) return;
    const queued = await this.options.database.query<{ execution_profile_id: string }>(
      "SELECT execution_profile_id FROM acu_profile_probe_queue ORDER BY enqueued_at LIMIT 100",
    );
    const targetedQueued = queued.rows.some((row) => row.execution_profile_id !== MANUAL_FULL_POOL_QUEUE_ID);
    const activity = await this.options.database.query<{ request_count: number }>(
      "SELECT count(*)::int request_count FROM acu_logical_requests WHERE started_at>=now()-interval '30 minutes'",
    );
    const intervalMinutes = adaptiveProbeIntervalMinutes(Number(activity.rows[0]?.request_count ?? 0));
    if (intervalMinutes === null && !targetedQueued) return;
    const budget = await this.options.database.query<{ spend: string; last_probe_at: Date | null }>(
      `SELECT coalesce(sum(cost_cny) FILTER (WHERE started_at>=date_trunc('day',now())),0)::text spend,
        max(started_at) last_probe_at FROM acu_profile_probe_attempts`,
    );
    if (Number(budget.rows[0]?.spend ?? 0) >= this.options.dailyBudgetCny) return;
    const lastProbeAt = budget.rows[0]?.last_probe_at;
    if (!targetedQueued && intervalMinutes !== null && lastProbeAt
      && Date.now() - new Date(lastProbeAt).getTime() < intervalMinutes * 60_000) return;

    const repository = new AlphaRepository(this.options.database);
    const [channels, runtimes] = await Promise.all([
      repository.batchChannelHealth(this.options.profiles.map((profile) => profile.channelId ?? profile.channel)),
      repository.batchProfileHealth(this.options.profiles.map((profile) => profile.executionProfileId)),
    ]);
    const queuedOrder = new Map(queued.rows.map((row, index) => [row.execution_profile_id, index]));
    const candidates = this.options.profiles.filter((profile) => {
      if (!profile.enabled || !profile.administratorAllowed || !this.options.adapters.has(profile.executionProfileId)) return false;
      const channel = channels.get(profile.channelId ?? profile.channel);
      const runtime = runtimes.get(profile.executionProfileId);
      const lastAttemptAt = runtime?.lastAttemptAt ?? channel?.lastAttemptAt;
      const consecutiveFailures = Math.max(runtime?.consecutiveFailures ?? 0, channel?.consecutiveFailures ?? 0);
      const retryAt = lastAttemptAt
        ? lastAttemptAt.getTime() + probeBackoffMinutes(consecutiveFailures) * 60_000
        : 0;
      if (retryAt > Date.now()) return false;
      const cooldownExpired = [channel, runtime].some((health) =>
        health && ["open", "half_open"].includes(health.state)
          && (!health.cooldownUntil || health.cooldownUntil.getTime() <= Date.now()));
      const lastSuccessAt = profile.requiresFreshProbe ? runtime?.lastSuccessAt
        : runtime?.lastSuccessAt ?? channel?.lastSuccessAt;
      const stale = !lastSuccessAt || Date.now() - lastSuccessAt.getTime() > 120 * 60_000;
      return cooldownExpired || (profile.requiresFreshProbe === true && stale);
    }).sort((left, right) => (queuedOrder.get(left.executionProfileId) ?? Number.MAX_SAFE_INTEGER)
      - (queuedOrder.get(right.executionProfileId) ?? Number.MAX_SAFE_INTEGER));
    for (const profile of candidates) {
      const recent = await this.options.database.query(
        `SELECT 1 FROM acu_attempts WHERE attempt_kind='provider' AND execution_profile_id=$1
          AND status='success' AND started_at>=now()-interval '60 minutes' LIMIT 1`,
        [profile.executionProfileId],
      );
      if (recent.rowCount) {
        await this.options.database.query("DELETE FROM acu_profile_probe_queue WHERE execution_profile_id=$1", [profile.executionProfileId]);
        continue;
      }
      const channelId = profile.channelId ?? profile.channel;
      const channel = channels.get(channelId);
      const runtime = runtimes.get(profile.executionProfileId);
      if (channel && ["open", "half_open"].includes(channel.state)
        && !await repository.claimHalfOpenProbe("channel", channelId)) continue;
      if (runtime && ["open", "half_open"].includes(runtime.state)
        && !await repository.claimHalfOpenProbe("profile", profile.executionProfileId)) continue;
      await this.probe(profile, repository, channel ?? { state: "healthy", consecutiveFailures: 0, recentSuccessRate: 1 },
        runtime ?? { state: "healthy", consecutiveFailures: 0, recentSuccessRate: 1 });
      await this.options.database.query("DELETE FROM acu_profile_probe_queue WHERE execution_profile_id=$1", [profile.executionProfileId]);
      return;
    }
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
    const activity = manual ? { rowCount: 0 } : await this.options.database.query(
      "SELECT 1 FROM acu_logical_requests WHERE started_at>=now()-interval '6 hours' LIMIT 1",
    );
    if (!fullPoolProbeDue({
      manual,
      lastCompletedAt: lastRunAt ? new Date(lastRunAt) : undefined,
      userRequestsLastSixHours: activity.rowCount ?? 0,
      intervalMs,
    })) return false;
    const budget = await this.options.database.query<{ spend: string }>(
      `SELECT coalesce(sum(cost_cny) FILTER (WHERE started_at>=date_trunc('day',now())),0)::text spend
       FROM acu_profile_probe_attempts`,
    );
    if (Number(budget.rows[0]?.spend ?? 0) >= this.options.dailyBudgetCny) return false;
    const runId = `full_pool_${randomUUID().replaceAll("-", "")}`;
    const lastProbes = await this.options.database.query<{ execution_profile_id: string; last_probe_at: Date }>(
      `SELECT execution_profile_id,max(started_at) last_probe_at FROM acu_profile_probe_attempts
       GROUP BY execution_profile_id`,
    );
    const lastProbeByProfile = new Map(lastProbes.rows.map((row) => [
      row.execution_profile_id, new Date(row.last_probe_at).getTime(),
    ]));
    const profiles = this.options.profiles.filter((profile) => profile.enabled && profile.administratorAllowed
      && this.options.adapters.has(profile.executionProfileId))
      .sort((left, right) => (lastProbeByProfile.get(left.executionProfileId) ?? 0)
        - (lastProbeByProfile.get(right.executionProfileId) ?? 0));
    await this.options.database.query(
      `INSERT INTO acu_full_pool_probe_runs
        (full_pool_probe_run_id,status,trigger,profile_count,metadata_json)
       VALUES ($1,'running',$2,$3,$4::jsonb)`,
      [runId, manual ? "manual" : "scheduled_activity", profiles.length,
        JSON.stringify({ intervalHours: intervalMs / 3_600_000, userActivityRequired: !manual })],
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
        const currentSpend = Number(budget.rows[0]?.spend ?? 0) + costCny;
        if (currentSpend >= this.options.dailyBudgetCny) {
          status = "budget_exhausted";
          break;
        }
        await this.options.database.query(
          `UPDATE acu_probe_worker_lease SET lease_until=now()+interval '2 minutes',updated_at=now()
           WHERE singleton=true AND holder_id=$1`,
          [this.workerId],
        );
        const [channels, runtimes] = await Promise.all([
          repository.batchChannelHealth([profile.channelId ?? profile.channel]),
          repository.batchProfileHealth([profile.executionProfileId]),
        ]);
        const result = await this.probe(
          profile,
          repository,
          channels.get(profile.channelId ?? profile.channel) ?? { state: "healthy", consecutiveFailures: 0, recentSuccessRate: 1 },
          runtimes.get(profile.executionProfileId) ?? { state: "healthy", consecutiveFailures: 0, recentSuccessRate: 1 },
          { probeMode: "full_pool", fullPoolProbeRunId: runId, trigger: manual ? "manual" : "scheduled_activity" },
        );
        attempted += 1;
        costCny += result.costCny;
        if (result.success) success += 1;
        else {
          failed += 1;
          failedChannels.add(channelId);
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
        ? this.options.database.query("DELETE FROM acu_profile_probe_queue WHERE execution_profile_id=$1", [MANUAL_FULL_POOL_QUEUE_ID])
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
  ): Promise<{ success: boolean; costCny: number }> {
    const protocol = profile.protocols.includes("responses") ? "responses" : profile.protocols[0];
    const providerModel = profile.providerModelId ?? profile.modelId;
    const payload = protocol === "messages"
      ? { model: providerModel, max_tokens: 4, stream: true, messages: [{ role: "user", content: "只输出 OK" }] }
      : { model: providerModel, input: "只输出 OK", max_output_tokens: 4, stream: true };
    const body = Buffer.from(JSON.stringify(payload));
    const startedAt = new Date();
    const probeAttemptId = `probe_${alphaId("att").slice(4)}`;
    let response: Response | undefined;
    let responseBody = Buffer.alloc(0);
    let outcome: AttemptOutcome;
    let usageTrusted = false;
    let inputTokens = 0n;
    let cachedInputTokens = 0n;
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
        headers: { "content-type": "application/json", accept: "text/event-stream", "user-agent": "acu-adaptive-probe/1" },
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
      });
      inputTokens = usage.inputTokens;
      cachedInputTokens = usage.cachedInputTokens;
      outputTokens = usage.outputTokens;
      reasoningTokens = usage.reasoningTokens;
      actualModel = usage.actualModel;
      usageTrusted = usage.usageSource === "provider_usage";
      const acceptedModels = new Set([profile.modelId, providerModel, ...(profile.actualModelAliases ?? [])]);
      const actualModelMismatch = Boolean(actualModel && !acceptedModels.has(actualModel));
      const validStream = (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")
        && responseBody.toString("utf8").split(/\r?\n/).some((line) => line.startsWith("data:") && line.slice(5).trim().length > 0);
      outcome = {
        success: response.ok && validStream,
        httpStatus: response.status,
        errorCode: response.ok && !validStream ? "protocol_incompatible" : undefined,
        errorMessage: response.ok && validStream ? undefined : responseBody.toString("utf8").slice(0, 512),
        usageTrusted,
        actualModelMismatch,
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
          providerCreditCashCostCny: profile.economics.rechargeCashCny !== null
            && profile.economics.creditsReceivedUsd !== null
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
    const classified = classifyAttemptOutcome(outcome, channelHealth.consecutiveFailures);
    const validProbe = classified.errorClass === "none";
    const updates: Array<Promise<void>> = [];
    if (classified.scope === "channel" || validProbe) {
      updates.push(repository.saveChannelHealth({
        channelId: profile.channelId ?? profile.channel,
        providerId: profile.provider,
        snapshot: applyAttemptOutcome(channelHealth, outcome),
      }));
    }
    if (classified.scope === "profile" || validProbe) {
      updates.push(repository.saveProfileHealth({
        executionProfileId: profile.executionProfileId,
        channelId: profile.channelId ?? profile.channel,
        providerId: profile.provider,
        canonicalModelId: profile.modelId,
        protocol,
        snapshot: applyAttemptOutcome(profileHealth, outcome),
        usageTrusted: classified.usageTrusted && usageTrusted && profile.usageTrusted !== false,
        actualModelVerified: !outcome.actualModelMismatch,
        healthReason: classified.errorClass,
      }));
    }
    await Promise.all([
      ...updates,
      this.options.database.query(
        `INSERT INTO acu_profile_probe_attempts
          (probe_attempt_id,execution_profile_id,channel_id,provider_id,canonical_model_id,protocol,status,
           http_status,error_class,latency_ms,input_tokens,output_tokens,actual_model,usage_trusted,cost_cny,
           metadata_json,started_at,completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,now())`,
        [probeAttemptId, profile.executionProfileId, profile.channelId ?? profile.channel, profile.provider,
          profile.modelId, protocol, validProbe ? "success" : "failed", response?.status ?? null,
          classified.errorClass, outcome.totalLatencyMs ?? null, inputTokens.toString(), outputTokens.toString(),
          actualModel ?? null, usageTrusted, costCny.toFixed(10), JSON.stringify({
            rawResponseBytes: responseBody.byteLength,
            inputTokens: inputTokens.toString(),
            cachedInputTokens: cachedInputTokens.toString(),
            outputTokens: outputTokens.toString(),
            reasoningTokens: reasoningTokens.toString(),
            actualModel: actualModel ?? null,
            usageSource: usageTrusted ? "provider_usage" : "unavailable",
            errorCode: outcome.errorCode ?? null,
            errorMessage: outcome.errorMessage ?? null,
            costBreakdown,
            ...probeMetadata,
          }), startedAt],
      ),
    ]);
    return { success: validProbe, costCny };
  }
}
