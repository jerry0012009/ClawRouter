export type CircuitState = "healthy" | "degraded" | "open" | "half_open" | "disabled";
export type HealthScope = "none" | "channel" | "profile";
export type ProviderErrorClass =
  | "none" | "client_cancelled" | "authentication" | "quota_exhausted" | "rate_limited"
  | "network" | "timeout" | "provider_5xx" | "model_not_found" | "protocol_incompatible"
  | "tool_incompatible" | "actual_model_mismatch" | "usage_untrusted" | "other_provider_error";

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

export type AttemptOutcome = {
  success: boolean;
  clientCancelled?: boolean;
  httpStatus?: number;
  errorCode?: string;
  errorMessage?: string;
  retryAfterSeconds?: number;
  actualModelMismatch?: boolean;
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
};

function networkBackoff(failures: number): number {
  if (failures <= 1) return 30;
  if (failures === 2) return 120;
  if (failures === 3) return 600;
  return 1_800;
}

export function classifyAttemptOutcome(outcome: AttemptOutcome, consecutiveFailures: number): ClassifiedOutcome {
  if (outcome.clientCancelled) return { errorClass: "client_cancelled", scope: "none", permanent: false, cooldownSeconds: 0, usageTrusted: true };
  if (outcome.success && outcome.actualModelMismatch) return { errorClass: "actual_model_mismatch", scope: "profile", permanent: true, cooldownSeconds: 0, usageTrusted: true };
  if (outcome.success && outcome.usageTrusted === false) return { errorClass: "usage_untrusted", scope: "profile", permanent: false, cooldownSeconds: 1_800, usageTrusted: false };
  if (outcome.success) return { errorClass: "none", scope: "none", permanent: false, cooldownSeconds: 0, usageTrusted: true };
  const code = `${outcome.errorCode ?? ""} ${outcome.errorMessage ?? ""}`.toLowerCase();
  if (outcome.httpStatus === 401 || outcome.httpStatus === 403) return { errorClass: "authentication", scope: "channel", permanent: true, cooldownSeconds: 0, usageTrusted: true };
  if (/insufficient.*(?:quota|balance|credit)|quota.*exhaust|余额不足|额度/.test(code)) return { errorClass: "quota_exhausted", scope: "channel", permanent: false, cooldownSeconds: 1_800, usageTrusted: true };
  if (outcome.httpStatus === 429) return { errorClass: "rate_limited", scope: "channel", permanent: false,
    cooldownSeconds: Math.max(1, outcome.retryAfterSeconds ?? networkBackoff(consecutiveFailures + 1)), usageTrusted: true };
  if (/model[_ -]?not[_ -]?found|unknown model|does not exist/.test(code)) return { errorClass: "model_not_found", scope: "profile", permanent: true, cooldownSeconds: 0, usageTrusted: true };
  if (/tool.*(?:unsupported|not supported)|unsupported.*tool/.test(code)) return { errorClass: "tool_incompatible", scope: "profile", permanent: true, cooldownSeconds: 0, usageTrusted: true };
  if (/protocol|unsupported.*(?:responses|messages)|invalid.*schema/.test(code)) return { errorClass: "protocol_incompatible", scope: "profile", permanent: true, cooldownSeconds: 0, usageTrusted: true };
  if (outcome.httpStatus && [502, 503, 504].includes(outcome.httpStatus)) return { errorClass: "provider_5xx", scope: "channel", permanent: false, cooldownSeconds: networkBackoff(consecutiveFailures + 1), usageTrusted: true };
  if (outcome.httpStatus === 500) return { errorClass: "provider_5xx", scope: "profile", permanent: false, cooldownSeconds: networkBackoff(consecutiveFailures + 1), usageTrusted: true };
  if (/timeout|timed out|aborterror/.test(code)) return { errorClass: "timeout", scope: "channel", permanent: false, cooldownSeconds: networkBackoff(consecutiveFailures + 1), usageTrusted: true };
  if (/econn|enotfound|network|fetch failed|socket/.test(code)) return { errorClass: "network", scope: "channel", permanent: false, cooldownSeconds: networkBackoff(consecutiveFailures + 1), usageTrusted: true };
  return { errorClass: "other_provider_error", scope: "profile", permanent: false, cooldownSeconds: networkBackoff(consecutiveFailures + 1), usageTrusted: true };
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
