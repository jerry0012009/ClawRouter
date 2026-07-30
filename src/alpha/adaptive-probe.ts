import { applyAttemptOutcome, classifyAttemptOutcome, type AttemptOutcome, type HealthSnapshot } from "./channel-health.js";
import type { AlphaDatabase } from "./database.js";
import type { NativeProviderAdapter } from "./provider.js";
import { providerCostBreakdown } from "./provider-economics.js";
import type { AlphaExecutionProfile } from "./routing.js";
import { AlphaRepository, alphaId } from "./repository.js";
import { parseProviderUsage } from "./usage.js";

export function adaptiveProbeIntervalMinutes(userRequestsLast30Minutes: number): number | null {
  if (userRequestsLast30Minutes <= 0) return null;
  if (userRequestsLast30Minutes <= 5) return 60;
  if (userRequestsLast30Minutes <= 20) return 30;
  return 15;
}

export type AdaptiveProbeWorkerOptions = {
  database: AlphaDatabase;
  profiles: AlphaExecutionProfile[];
  adapters: Map<string, NativeProviderAdapter>;
  dailyBudgetCny: number;
  timeoutMs?: number;
};

export class AdaptiveProbeWorker {
  private running = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly options: AdaptiveProbeWorkerOptions) {}

  start(): void {
    this.timer = setInterval(() => void this.runOnce(), 60_000);
    this.timer.unref();
  }

  wake(): void {
    queueMicrotask(() => void this.runOnce());
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runEligibleProbe();
    } finally {
      this.running = false;
    }
  }

  private async runEligibleProbe(): Promise<void> {
    const activity = await this.options.database.query<{ request_count: number }>(
      "SELECT count(*)::int request_count FROM acu_logical_requests WHERE started_at>=now()-interval '30 minutes'",
    );
    const intervalMinutes = adaptiveProbeIntervalMinutes(Number(activity.rows[0]?.request_count ?? 0));
    if (intervalMinutes === null) return;
    const budget = await this.options.database.query<{ spend: string; last_probe_at: Date | null }>(
      `SELECT coalesce(sum(cost_cny) FILTER (WHERE started_at>=date_trunc('day',now())),0)::text spend,
        max(started_at) last_probe_at FROM acu_profile_probe_attempts`,
    );
    if (Number(budget.rows[0]?.spend ?? 0) >= this.options.dailyBudgetCny) return;
    const lastProbeAt = budget.rows[0]?.last_probe_at;
    if (lastProbeAt && Date.now() - new Date(lastProbeAt).getTime() < intervalMinutes * 60_000) return;

    const repository = new AlphaRepository(this.options.database);
    const [channels, runtimes] = await Promise.all([
      repository.batchChannelHealth(this.options.profiles.map((profile) => profile.channelId ?? profile.channel)),
      repository.batchProfileHealth(this.options.profiles.map((profile) => profile.executionProfileId)),
    ]);
    const candidates = this.options.profiles.filter((profile) => {
      if (!profile.enabled || !profile.administratorAllowed || !this.options.adapters.has(profile.executionProfileId)) return false;
      const channel = channels.get(profile.channelId ?? profile.channel);
      const runtime = runtimes.get(profile.executionProfileId);
      const cooldownExpired = [channel, runtime].some((health) =>
        health && ["open", "half_open"].includes(health.state)
          && (!health.cooldownUntil || health.cooldownUntil.getTime() <= Date.now()));
      const lastSuccessAt = runtime?.lastSuccessAt ?? channel?.lastSuccessAt;
      const stale = !lastSuccessAt || Date.now() - lastSuccessAt.getTime() > 120 * 60_000;
      return cooldownExpired || (profile.requiresFreshProbe === true && stale);
    });
    for (const profile of candidates) {
      const recent = await this.options.database.query(
        `SELECT 1 FROM acu_attempts WHERE attempt_kind='provider' AND execution_profile_id=$1
          AND status='success' AND started_at>=now()-interval '60 minutes' LIMIT 1`,
        [profile.executionProfileId],
      );
      if (recent.rowCount) continue;
      const channelId = profile.channelId ?? profile.channel;
      const channel = channels.get(channelId);
      const runtime = runtimes.get(profile.executionProfileId);
      if (channel && ["open", "half_open"].includes(channel.state)
        && !await repository.claimHalfOpenProbe("channel", channelId)) continue;
      if (runtime && ["open", "half_open"].includes(runtime.state)
        && !await repository.claimHalfOpenProbe("profile", profile.executionProfileId)) continue;
      await this.probe(profile, repository, channel ?? { state: "healthy", consecutiveFailures: 0, recentSuccessRate: 1 },
        runtime ?? { state: "healthy", consecutiveFailures: 0, recentSuccessRate: 1 });
      return;
    }
  }

  private async probe(
    profile: AlphaExecutionProfile,
    repository: AlphaRepository,
    channelHealth: HealthSnapshot,
    profileHealth: HealthSnapshot,
  ): Promise<void> {
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
    let outputTokens = 0n;
    let actualModel: string | undefined;
    let costCny = 0;
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
      outputTokens = usage.outputTokens;
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
      if (profile.economics) {
        costCny = providerCostBreakdown(profile.economics, Number(usage.providerCostUsd)).effectiveCashCostCny;
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
          actualModel ?? null, usageTrusted, costCny.toFixed(10), JSON.stringify({ rawResponseBytes: responseBody.byteLength }), startedAt],
      ),
    ]);
  }
}
