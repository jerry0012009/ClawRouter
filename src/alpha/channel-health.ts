export type CircuitState = "healthy" | "degraded" | "open" | "half_open" | "disabled";
export type HealthScope = "none" | "channel" | "profile";
export type ProviderErrorClass =
  | "none" | "client_cancelled" | "authentication" | "quota_exhausted" | "rate_limited"
  | "network" | "timeout" | "slow_first_model_event" | "provider_5xx" | "provider_edge_timeout" | "model_not_found" | "protocol_incompatible"
  | "tool_incompatible" | "actual_model_missing" | "actual_model_mismatch" | "usage_untrusted" | "other_provider_error";

export type HealthSnapshot = {
  state: CircuitState;
  consecutiveFailures: number;
  recentSuccessRate: number;
  cooldownUntil?: Date;
  lastAttemptAt?: Date;
  lastSuccessAt?: Date;
  lastFailureAt?: Date;
  firstTokenLatencyMs?: number;
  totalLatencyMs?: number;
  errorClass?: ProviderErrorClass;
  httpStatus?: number;
};

export type RuntimeHealth = {
  profileState: string;
  channelState: string;
  providerState: string;
  probeState: string;
  effectiveState: "eligible" | "degraded" | "temporarily_unavailable" | "disabled";
  blockingScope?: "profile" | "channel" | "provider" | "probe" | "administrator";
  statusReason?: string;
  cooldownUntil?: Date;
};

export function deriveRuntimeEligibility(input: {
  profileState?: string;
  channelState?: string;
  providerState?: string;
  probeState?: string;
  enabled?: boolean;
  administratorAllowed?: boolean;
  cooldownUntil?: Date;
}): RuntimeHealth {
  const result: RuntimeHealth = {
    profileState: input.profileState ?? "healthy",
    channelState: input.channelState ?? "healthy",
    providerState: input.providerState ?? "healthy",
    probeState: input.probeState ?? "fresh",
    effectiveState: "eligible",
    cooldownUntil: input.cooldownUntil,
  };
  if (!input.enabled || !input.administratorAllowed) return {
    ...result, effectiveState: "disabled", blockingScope: "administrator",
    statusReason: !input.enabled ? "profile_disabled" : "administrator_disabled",
  };
  if (result.providerState === "blocked" || result.providerState === "disabled") return {
    ...result, effectiveState: "disabled", blockingScope: "provider", statusReason: `provider_${result.providerState}`,
  };
  if (result.providerState === "cooldown") return {
    ...result, effectiveState: "temporarily_unavailable", blockingScope: "provider", statusReason: "provider_cooldown",
  };
  for (const [scope, state] of [["channel", result.channelState], ["profile", result.profileState]] as const) {
    if (state === "disabled") return { ...result, effectiveState: "disabled", blockingScope: scope, statusReason: `${scope}_disabled` };
    if (state === "open" || state === "half_open") return {
      ...result, effectiveState: "temporarily_unavailable", blockingScope: scope,
      statusReason: state === "half_open" ? `${scope}_half_open_probe_only` : `${scope}_cooldown`,
    };
  }
  if (result.probeState === "stale") return {
    ...result, effectiveState: "degraded", blockingScope: "probe", statusReason: "probe_stale",
  };
  if ([result.profileState, result.channelState, result.providerState].includes("degraded")) {
    return { ...result, effectiveState: "degraded", statusReason: "runtime_degraded" };
  }
  return result;
}

export type AttemptOutcome = {
  success: boolean;
  clientCancelled?: boolean;
  httpStatus?: number;
  errorCode?: string;
  errorMessage?: string;
  retryAfterSeconds?: number;
  actualModelMismatch?: boolean;
  actualModelVerified?: boolean;
  usageTrusted?: boolean;
  firstTokenLatencyMs?: number;
  totalLatencyMs?: number;
};

export type ClassifiedOutcome = {
  errorClass: ProviderErrorClass;
  scope: HealthScope;
  permanent: boolean;
  cooldownSeconds: number;
  usageTrusted: boolean;
  recoverableBeforeModelOutput: boolean;
  respectRetryAfter: boolean;
  countsAsChannelFailure: boolean;
};

const classified = (input: Omit<ClassifiedOutcome, "usageTrusted"> & { usageTrusted?: boolean }): ClassifiedOutcome => ({
  usageTrusted: input.usageTrusted ?? true,
  ...input,
});

function networkBackoff(failures: number): number {
  if (failures <= 1) return 30;
  if (failures === 2) return 120;
  if (failures === 3) return 600;
  return 1_800;
}

export function classifyAttemptOutcome(outcome: AttemptOutcome, consecutiveFailures: number): ClassifiedOutcome {
  if (outcome.clientCancelled) return classified({ errorClass: "client_cancelled", scope: "none", permanent: false, cooldownSeconds: 0, recoverableBeforeModelOutput: false, respectRetryAfter: false, countsAsChannelFailure: false });
  if (outcome.errorCode === "actual_model_missing") return classified({ errorClass: "actual_model_missing", scope: "profile", permanent: false, cooldownSeconds: 1_800, usageTrusted: false, recoverableBeforeModelOutput: false, respectRetryAfter: false, countsAsChannelFailure: false });
  if (outcome.success && outcome.actualModelMismatch) return classified({ errorClass: "actual_model_mismatch", scope: "profile", permanent: true, cooldownSeconds: 0, recoverableBeforeModelOutput: false, respectRetryAfter: false, countsAsChannelFailure: false });
  if (outcome.success && outcome.usageTrusted === false) return classified({ errorClass: "usage_untrusted", scope: "profile", permanent: false, cooldownSeconds: 1_800, usageTrusted: false, recoverableBeforeModelOutput: false, respectRetryAfter: false, countsAsChannelFailure: false });
  if (outcome.success) return classified({ errorClass: "none", scope: "none", permanent: false, cooldownSeconds: 0, recoverableBeforeModelOutput: false, respectRetryAfter: false, countsAsChannelFailure: false });
  const code = `${outcome.errorCode ?? ""} ${outcome.errorMessage ?? ""}`.toLowerCase();
  if (outcome.httpStatus === 401 || outcome.httpStatus === 403) return classified({ errorClass: "authentication", scope: "channel", permanent: true, cooldownSeconds: 0, recoverableBeforeModelOutput: true, respectRetryAfter: false, countsAsChannelFailure: true });
  if (/insufficient.*(?:quota|balance|credit)|quota.*exhaust|余额不足|额度/.test(code)) return classified({ errorClass: "quota_exhausted", scope: "channel", permanent: false, cooldownSeconds: Math.max(1, outcome.retryAfterSeconds ?? 1_800), recoverableBeforeModelOutput: true, respectRetryAfter: true, countsAsChannelFailure: true });
  if (outcome.httpStatus === 429) return classified({ errorClass: "rate_limited", scope: "channel", permanent: false, cooldownSeconds: Math.max(1, outcome.retryAfterSeconds ?? networkBackoff(consecutiveFailures + 1)), recoverableBeforeModelOutput: true, respectRetryAfter: true, countsAsChannelFailure: true });
  if (/model[_ -]?not[_ -]?found|unknown model|does not exist/.test(code)) return classified({ errorClass: "model_not_found", scope: "profile", permanent: true, cooldownSeconds: 0, recoverableBeforeModelOutput: true, respectRetryAfter: false, countsAsChannelFailure: false });
  if (/tool.*(?:unsupported|not supported)|unsupported.*tool/.test(code)) return classified({ errorClass: "tool_incompatible", scope: "profile", permanent: true, cooldownSeconds: 0, recoverableBeforeModelOutput: true, respectRetryAfter: false, countsAsChannelFailure: false });
  if (/protocol|unsupported.*(?:responses|messages)|invalid.*schema/.test(code)) return classified({ errorClass: "protocol_incompatible", scope: "profile", permanent: true, cooldownSeconds: 0, recoverableBeforeModelOutput: true, respectRetryAfter: false, countsAsChannelFailure: false });
  if (outcome.httpStatus === 200 && /upstream_failed_before_output|stream_ended_before_model_event/.test(code)) {
    return classified({ errorClass: "protocol_incompatible", scope: "profile", permanent: false, cooldownSeconds: 1_800, recoverableBeforeModelOutput: true, respectRetryAfter: false, countsAsChannelFailure: false });
  }
  if (outcome.httpStatus === 524) return classified({ errorClass: "provider_edge_timeout", scope: "channel", permanent: false, cooldownSeconds: Math.max(1, outcome.retryAfterSeconds ?? networkBackoff(consecutiveFailures + 1)), recoverableBeforeModelOutput: true, respectRetryAfter: true, countsAsChannelFailure: true });
  if (outcome.httpStatus && outcome.httpStatus >= 500 && outcome.httpStatus <= 599) return classified({ errorClass: "provider_5xx", scope: "channel", permanent: false, cooldownSeconds: Math.max(1, outcome.retryAfterSeconds ?? networkBackoff(consecutiveFailures + 1)), recoverableBeforeModelOutput: true, respectRetryAfter: true, countsAsChannelFailure: true });
  if (/slow_first_model_event/.test(code)) return classified({ errorClass: "slow_first_model_event", scope: "channel", permanent: false, cooldownSeconds: networkBackoff(consecutiveFailures + 1), recoverableBeforeModelOutput: true, respectRetryAfter: false, countsAsChannelFailure: true });
  if (/timeout|timed out|aborterror/.test(code)) return classified({ errorClass: "timeout", scope: "channel", permanent: false, cooldownSeconds: networkBackoff(consecutiveFailures + 1), recoverableBeforeModelOutput: true, respectRetryAfter: false, countsAsChannelFailure: true });
  if (/econn|enotfound|network|fetch failed|socket/.test(code)) return classified({ errorClass: "network", scope: "channel", permanent: false, cooldownSeconds: networkBackoff(consecutiveFailures + 1), recoverableBeforeModelOutput: true, respectRetryAfter: false, countsAsChannelFailure: true });
  return classified({ errorClass: "other_provider_error", scope: "channel", permanent: false, cooldownSeconds: networkBackoff(consecutiveFailures + 1), recoverableBeforeModelOutput: true, respectRetryAfter: false, countsAsChannelFailure: true });
}

function ewma(previous: number, sample: number): number {
  return Math.max(0, Math.min(1, previous * 0.8 + sample * 0.2));
}

export function applyAttemptOutcome(snapshot: HealthSnapshot, outcome: AttemptOutcome, now = new Date()): HealthSnapshot {
  const classified = classifyAttemptOutcome(outcome, snapshot.consecutiveFailures);
  if (classified.scope === "none" && classified.errorClass === "client_cancelled") return { ...snapshot, lastAttemptAt: now };
  if (outcome.success && classified.errorClass === "none") return {
    ...snapshot,
    state: "healthy",
    consecutiveFailures: 0,
    recentSuccessRate: ewma(snapshot.recentSuccessRate, 1),
    cooldownUntil: undefined,
    lastAttemptAt: now,
    lastSuccessAt: now,
    firstTokenLatencyMs: outcome.firstTokenLatencyMs ?? snapshot.firstTokenLatencyMs,
    totalLatencyMs: outcome.totalLatencyMs ?? snapshot.totalLatencyMs,
    errorClass: "none",
    httpStatus: outcome.httpStatus,
  };
  return {
    ...snapshot,
    state: classified.permanent ? "disabled" : "open",
    consecutiveFailures: snapshot.consecutiveFailures + 1,
    recentSuccessRate: ewma(snapshot.recentSuccessRate, 0),
    cooldownUntil: classified.permanent ? undefined : new Date(now.getTime() + classified.cooldownSeconds * 1_000),
    lastAttemptAt: now,
    lastFailureAt: now,
    firstTokenLatencyMs: outcome.firstTokenLatencyMs ?? snapshot.firstTokenLatencyMs,
    totalLatencyMs: outcome.totalLatencyMs ?? snapshot.totalLatencyMs,
    errorClass: classified.errorClass,
    httpStatus: outcome.httpStatus,
  };
}

export function refreshExpiredCircuit(snapshot: HealthSnapshot, now = new Date()): HealthSnapshot {
  return snapshot.state === "open" && snapshot.cooldownUntil && snapshot.cooldownUntil <= now
    ? { ...snapshot, state: "half_open" }
    : snapshot;
}

export function isCircuitRoutable(snapshot: HealthSnapshot, allowHalfOpenProbe = false): boolean {
  return snapshot.state === "healthy" || snapshot.state === "degraded"
    || (snapshot.state === "half_open" && allowHalfOpenProbe);
}
