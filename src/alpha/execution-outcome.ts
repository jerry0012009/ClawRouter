export type ExecutionOutcome = {
  deliveryStatus:
    | "completed"
    | "client_cancelled_before_output"
    | "client_cancelled_after_output"
    | "upstream_failed_before_output"
    | "upstream_incomplete_after_output";
  recoveryStatus:
    | "not_needed"
    | "eligible"
    | "executed"
    | "blocked_after_output"
    | "no_compatible_target"
    | "max_attempts_reached"
    | "client_disconnected";
  billingStatus: "provider_usage_verified" | "estimated" | "unknown";
  healthImpact: "success" | "none" | "profile_failure" | "channel_failure";
};

export type CostCompletenessStatus = "complete" | "provider_cost_unknown" | "partially_estimated";

export function costCompletenessStatus(input: { providerUsageReported: boolean; estimated: boolean }): CostCompletenessStatus {
  if (input.providerUsageReported) return "complete";
  return input.estimated ? "partially_estimated" : "provider_cost_unknown";
}

export type RecoveryDecisionReason =
  | "not_recoverable"
  | "output_already_visible"
  | "client_disconnected"
  | "max_attempts_reached"
  | "no_same_model_profile"
  | "no_compatible_profile"
  | "deadline_exhausted"
  | "recovery_budget_exhausted"
  | "executed";

export function classifyExecutionOutcome(input: {
  httpStatus?: number;
  complete: boolean;
  clientCancelled: boolean;
  modelVisibleOutputBytes: number;
  providerUsageReported: boolean;
  actualModelMismatch?: boolean;
  hostedWebIncompatible?: boolean;
  recoveryExecuted?: boolean;
  recoveryTargetAvailable?: boolean;
}): ExecutionOutcome {
  const hasOutput = input.modelVisibleOutputBytes > 0;
  const billingStatus = input.providerUsageReported ? "provider_usage_verified" : "unknown";
  if (input.clientCancelled) return {
    deliveryStatus: hasOutput ? "client_cancelled_after_output" : "client_cancelled_before_output",
    recoveryStatus: hasOutput ? "blocked_after_output" : "client_disconnected",
    billingStatus,
    healthImpact: "none",
  };
  if (input.actualModelMismatch || input.hostedWebIncompatible) return {
    deliveryStatus: input.complete ? "completed" : hasOutput ? "upstream_incomplete_after_output" : "upstream_failed_before_output",
    recoveryStatus: hasOutput ? "blocked_after_output" : "eligible",
    billingStatus,
    healthImpact: "profile_failure",
  };
  if (input.httpStatus === 200 && input.complete) return {
    deliveryStatus: "completed",
    recoveryStatus: "not_needed",
    billingStatus,
    healthImpact: "success",
  };
  if (hasOutput) return {
    deliveryStatus: "upstream_incomplete_after_output",
    recoveryStatus: input.recoveryExecuted ? "executed" : "blocked_after_output",
    billingStatus,
    healthImpact: "none",
  };
  return {
    deliveryStatus: "upstream_failed_before_output",
    recoveryStatus: input.recoveryExecuted ? "executed" : input.recoveryTargetAvailable === false
      ? "no_compatible_target" : "eligible",
    billingStatus,
    healthImpact: "profile_failure",
  };
}
