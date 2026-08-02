import type { AlphaProtocol, AlphaRepository } from "./repository.js";
import type { AlphaExecutionProfile } from "./routing.js";
import {
  applyAttemptOutcome,
  classifyAttemptOutcome,
  type AttemptOutcome,
  type HealthSnapshot,
} from "./channel-health.js";

export type RuntimeHealthOutcomeResult = {
  errorClass: string;
  scope: "none" | "channel" | "profile";
  cooldownUntil?: Date;
};

export async function recordSharedRuntimeHealthOutcome(input: {
  repository: AlphaRepository;
  profile: AlphaExecutionProfile;
  protocol: AlphaProtocol;
  outcome: AttemptOutcome;
  wakeProbe?: (executionProfileId?: string) => void;
}): Promise<RuntimeHealthOutcomeResult> {
  const { repository, profile, protocol, outcome } = input;
  const channelId = profile.channelId ?? profile.channel;
  const [channelCurrent, profileCurrent] = await Promise.all([
    repository.channelHealth(channelId),
    repository.profileHealth(profile.executionProfileId),
  ]);
  let classified = classifyAttemptOutcome(outcome, profileCurrent?.consecutiveFailures ?? 0);
  if (classified.scope === "channel") {
    classified = classifyAttemptOutcome(outcome, channelCurrent?.consecutiveFailures ?? 0);
  }
  const initial = (): HealthSnapshot => ({ state: "healthy", consecutiveFailures: 0, recentSuccessRate: 1 });
  const attemptedAt = outcome.attemptedAt ?? new Date();
  const channelWasBlocked = ["open", "half_open"].includes(channelCurrent?.state ?? "");
  if (classified.scope === "channel" || (outcome.success && channelWasBlocked)) {
    await repository.saveChannelHealth({
      channelId,
      providerId: profile.provider,
      snapshot: applyAttemptOutcome(channelCurrent ?? initial(), outcome, attemptedAt),
    });
  }
  if (classified.scope === "profile" || outcome.success) {
    await repository.saveProfileHealth({
      executionProfileId: profile.executionProfileId,
      channelId,
      providerId: profile.provider,
      canonicalModelId: profile.modelId,
      protocol,
      snapshot: applyAttemptOutcome(profileCurrent ?? initial(), outcome, attemptedAt),
      usageTrusted: outcome.success
        ? outcome.usageTrusted === true
        : classified.usageTrusted && (profileCurrent?.usageTrusted ?? profile.usageTrusted !== false),
      actualModelVerified: outcome.actualModelVerified
        ?? (outcome.actualModelMismatch || outcome.errorCode === "actual_model_missing"
          ? false : profileCurrent?.actualModelVerified ?? true),
      healthReason: classified.errorClass,
    });
  }
  if (!outcome.success && classified.scope !== "none") {
    await repository.enqueueProfileProbe(profile.executionProfileId);
    if (classified.scope === "profile") await repository.deleteProfileProbeIfRecovered(profile.executionProfileId);
    input.wakeProbe?.(profile.executionProfileId);
  } else if (outcome.success) {
    await repository.deleteProfileProbeIfRecovered(profile.executionProfileId);
  }
  const persisted = classified.scope === "profile"
    ? await repository.profileHealth(profile.executionProfileId)
    : await repository.channelHealth(channelId);
  return { errorClass: classified.errorClass, scope: classified.scope, cooldownUntil: persisted?.cooldownUntil };
}
