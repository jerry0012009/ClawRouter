import type { AlphaDatabase } from "./database.js";
import type { AlphaRepository } from "./repository.js";
import type { AlphaExecutionProfile } from "./routing.js";

export const MINIMUM_RECOVERY_ATTEMPT_BUDGET_MS = 15_000;

export type FirstModelEventDeadlineInput = {
  estimatedInputTokens: number;
  successfulLatenciesMs: number[];
  recentErrorClasses: string[];
  profileState?: string;
};

export function recoveryBudgetMs(estimatedInputTokens: number): number {
  return estimatedInputTokens >= 100_000 ? 270_000 : 180_000;
}

export function hasRecoveryAttemptBudget(poolDeadlineAt: number, now: number): boolean {
  return poolDeadlineAt - now >= MINIMUM_RECOVERY_ATTEMPT_BUDGET_MS;
}

export function computeFirstModelEventDeadlineMs(input: FirstModelEventDeadlineInput): number {
  const fallback = input.estimatedInputTokens >= 100_000 ? 75_000 : 45_000;
  const samples = input.successfulLatenciesMs.filter(Number.isFinite).sort((a, b) => a - b);
  if (samples.length < 10) return fallback;
  const percentile = (ratio: number): number =>
    samples[Math.min(samples.length - 1, Math.ceil(samples.length * ratio) - 1)]!;
  const p50 = percentile(0.5);
  const p95 = percentile(0.95);
  const recentFailures = input.recentErrorClasses
    .slice(0, 5)
    .filter(
      (value) =>
        value === "slow_first_model_event" ||
        value === "timeout" ||
        value === "provider_5xx" ||
        value === "provider_edge_timeout",
    ).length;
  const volatile =
    (p50 > 0 && p95 / p50 > 3) || recentFailures >= 2 || input.profileState === "degraded";
  if (volatile) return fallback;
  return Math.max(30_000, Math.min(90_000, Math.round(p95 * 1.5)));
}

export async function resolveProfileAttemptDeadlineMs(input: {
  database: Pick<AlphaDatabase, "query">;
  repository: Pick<AlphaRepository, "profileHealth">;
  profile: AlphaExecutionProfile;
  estimatedInputTokens: number;
}): Promise<number> {
  const longContext = input.estimatedInputTokens >= 100_000;
  const [latencies, outcomes, runtime] = await Promise.all([
    input.database.query<{ latency_ms: number }>(
      `SELECT (metadata_json->>'first_model_event_latency_ms')::double precision AS latency_ms
       FROM acu_attempts
       WHERE attempt_kind='provider' AND status='success' AND execution_profile_id=$1
         AND metadata_json ? 'first_model_event_latency_ms'
         AND CASE WHEN $2::boolean THEN input_tokens>=100000 ELSE input_tokens<100000 END
         AND completed_at >= now()-interval '24 hours'
       ORDER BY completed_at DESC LIMIT 50`,
      [input.profile.executionProfileId, longContext],
    ),
    input.database.query<{ error_class: string }>(
      `SELECT COALESCE(metadata_json->>'errorClass',error_category,'') AS error_class
       FROM acu_attempts WHERE attempt_kind='provider' AND execution_profile_id=$1
         AND completed_at >= now()-interval '24 hours'
       ORDER BY completed_at DESC LIMIT 5`,
      [input.profile.executionProfileId],
    ),
    input.repository.profileHealth(input.profile.executionProfileId),
  ]);
  return computeFirstModelEventDeadlineMs({
    estimatedInputTokens: input.estimatedInputTokens,
    successfulLatenciesMs: latencies.rows.map((row) => Number(row.latency_ms)),
    recentErrorClasses: outcomes.rows.map((row) => row.error_class),
    profileState: runtime?.state ?? input.profile.health,
  });
}
