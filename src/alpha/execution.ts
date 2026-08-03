import type { NativeProviderAdapter, NativeProviderRequest } from "./provider.js";
import type { AlphaExecutionProfile } from "./routing.js";
import { ModelOutputObserver, setResponseObservation, type ModelOutputObservation } from "./model-output.js";
import type { RecoveryDecisionReason } from "./execution-outcome.js";

export type ProviderAttemptHandle = {
  attemptId: string;
  attemptIndex: number;
  startedAt: Date;
  adapter: NativeProviderAdapter;
  profile: AlphaExecutionProfile;
  networkEndpointIndex?: number;
  networkEndpoint?: string;
  body?: Uint8Array;
};

export type ProviderRecoveryTarget = {
  profile: AlphaExecutionProfile;
  networkEndpointIndex?: number;
  reasoningFallback?: "client_effort" | "default";
  reason: "network_endpoint_fallback" | "same_model_channel_fallback" | "context_model_reroute" | "reasoning_profile_fallback" | "reasoning_client_effort_fallback" | "reasoning_default_fallback";
};

export type ProviderRecoveryStopReason = RecoveryDecisionReason | "recovery_budget_exhausted";

export function providerAttemptIdentity(input: {
  executionProfileId: string;
  networkEndpoint?: string;
  reasoningFallback?: "client_effort" | "default";
}): string {
  return `${input.executionProfileId}:${input.networkEndpoint ?? "primary"}:${input.reasoningFallback ?? "selected"}`;
}

export class ProviderPreOutputError extends Error {
  readonly name = "ProviderPreOutputError";

  constructor(
    readonly code: "header_timeout" | "slow_first_model_event" | "stream_ended_before_model_event" | "recovery_budget_exhausted",
    readonly observation: ModelOutputObservation,
    readonly details: {
      upstreamStatus?: number;
      responseHeaders?: Record<string, string>;
      providerRequestId?: string;
      endpoint?: string;
      executionProfileId?: string;
    } = {},
  ) {
    super(code);
  }
}

export type BufferedProviderFailure = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  observation?: ReturnType<ModelOutputObserver["result"]>;
};

export type ProviderRecoveryOptions = {
  initial: ProviderAttemptHandle;
  maxAttempts?: number;
  recoveryBudgetMs?: number;
  minimumAttemptBudgetMs?: number;
  selectRecoveryProfile?(current: AlphaExecutionProfile): AlphaExecutionProfile | undefined;
  selectRecoveryTarget?(current: ProviderAttemptHandle, failure?: BufferedProviderFailure, error?: unknown): ProviderRecoveryTarget | undefined | Promise<ProviderRecoveryTarget | undefined>;
  firstModelEventDeadlineMs?(attempt: ProviderAttemptHandle, request: NativeProviderRequest): number | Promise<number>;
  isRecoverableResponse?(response: Response, attempt: ProviderAttemptHandle): boolean;
  isRecoverableFailure?(failure: BufferedProviderFailure, attempt: ProviderAttemptHandle): boolean;
  startRetry(profile: AlphaExecutionProfile, attemptIndex: number, target?: ProviderRecoveryTarget): Promise<ProviderAttemptHandle>;
  recordFailedAttempt(input: {
    attempt: ProviderAttemptHandle;
    latencyMs: number;
    response?: BufferedProviderFailure;
    error?: unknown;
    attemptsBudgetExhausted: boolean;
    timeBudgetExhausted: boolean;
  }): Promise<void>;
  recordRecoveryDecision?(input: {
    attempt: ProviderAttemptHandle;
    recoveryDecision: ProviderRecoveryStopReason | "executed";
    nextTarget?: ProviderRecoveryTarget;
    attemptsBudgetExhausted: boolean;
    timeBudgetExhausted: boolean;
  }): Promise<void>;
  commitRecoveryTarget?(current: ProviderAttemptHandle, target: ProviderRecoveryTarget): void;
  onSelected?(attempt: ProviderAttemptHandle): void;
  onRecoveryDecision?(reason: RecoveryDecisionReason): void;
};

export function isRecoverableProviderStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export type ContextOverflowClassification = {
  isContextOverflow: boolean;
  reportedContextLimit?: number;
};

export function contextOverflowRecoveryEligible(input: {
  isContextOverflow: boolean;
  modelVisibleOutputBytes: number;
  clientDisconnected: boolean;
  automaticRouting: boolean;
}): boolean {
  return input.isContextOverflow
    && input.modelVisibleOutputBytes === 0
    && !input.clientDisconnected
    && input.automaticRouting;
}

export function classifyProviderContextOverflow(
  failure: Pick<BufferedProviderFailure, "body"> | string,
): ContextOverflowClassification {
  const raw = typeof failure === "string" ? failure : failure.body.toString("utf8");
  let evidence = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: { type?: unknown; code?: unknown; message?: unknown } };
    const structured = [parsed.error?.type, parsed.error?.code, parsed.error?.message]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    if (structured) evidence = structured;
  } catch {
    // Some Providers return plain text or HTML error bodies.
  }
  const normalized = evidence.toLowerCase();
  const isContextOverflow = /context[_ -]length[_ -]exceeded|context[_ -]window[_ -]exceeded|maximum context length|context window exceeded|prompt is too long|input exceeds the context window|too many tokens for this model/.test(normalized);
  if (!isContextOverflow) return { isContextOverflow: false };
  const limitMatch = /(?:maximum|max(?:imum)?|limit|context window)[^0-9]{0,32}([0-9][0-9,]{3,})/i.exec(evidence);
  const reportedContextLimit = limitMatch?.[1] ? Number(limitMatch[1].replaceAll(",", "")) : undefined;
  return {
    isContextOverflow: true,
    reportedContextLimit: Number.isFinite(reportedContextLimit) ? reportedContextLimit : undefined,
  };
}

export type FirstModelEventDeadlineInput = {
  estimatedInputTokens: number;
  successfulLatenciesMs: number[];
  recentErrorClasses: string[];
  profileState?: string;
};

export function computeFirstModelEventDeadlineMs(input: FirstModelEventDeadlineInput): number {
  const fallback = input.estimatedInputTokens >= 100_000 ? 75_000 : 45_000;
  const samples = input.successfulLatenciesMs.filter(Number.isFinite).sort((a, b) => a - b);
  if (samples.length < 10) return fallback;
  const percentile = (ratio: number): number => samples[Math.min(samples.length - 1, Math.ceil(samples.length * ratio) - 1)]!;
  const p50 = percentile(0.5);
  const p95 = percentile(0.95);
  const recentFailures = input.recentErrorClasses.slice(0, 5).filter((value) => (
    value === "slow_first_model_event"
    || value === "timeout"
    || value === "provider_5xx"
    || value === "provider_edge_timeout"
  )).length;
  const volatile = (p50 > 0 && p95 / p50 > 3)
    || recentFailures >= 2
    || input.profileState === "degraded";
  if (volatile) return fallback;
  return Math.max(30_000, Math.min(90_000, Math.round(p95 * 1.5)));
}

async function bufferFailure(response: Response): Promise<BufferedProviderFailure> {
  const observer = new ModelOutputObserver(Date.now());
  const body = Buffer.from(await response.arrayBuffer());
  observer.observe(body);
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
    observation: observer.result(),
  };
}

async function waitForFirstModelEvent(
  response: Response,
  signal: AbortSignal,
  deadlineMs: number,
  startedAt: number,
  attempt: ProviderAttemptHandle,
): Promise<Response> {
  if (!response.body || !(response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) return response;
  const reader = response.body.getReader();
  const observer = new ModelOutputObserver(startedAt);
  const buffered: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderPreOutputError("slow_first_model_event", observer.result(), {
      upstreamStatus: response.status,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      providerRequestId: response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined,
      endpoint: attempt.networkEndpoint,
      executionProfileId: attempt.profile.executionProfileId,
    })), deadlineMs);
  });
  try {
    while (!observer.hasModelEvent()) {
      const item = await Promise.race([reader.read(), timeout]);
      if (item.done) break;
      buffered.push(item.value);
      observer.observe(item.value);
    }
    if (!observer.hasModelEvent()) throw new ProviderPreOutputError("stream_ended_before_model_event", observer.result(), {
      upstreamStatus: response.status,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      providerRequestId: response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined,
      endpoint: attempt.networkEndpoint,
      executionProfileId: attempt.profile.executionProfileId,
    });
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (signal.aborted) throw signal.reason;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of buffered) controller.enqueue(chunk);
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          controller.enqueue(item.value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  const rebuilt = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  setResponseObservation(rebuilt, observer.result());
  return rebuilt;
}

export function createRecoveringProviderAdapter(options: ProviderRecoveryOptions): NativeProviderAdapter {
  const legacyTarget = (profile: AlphaExecutionProfile): ProviderRecoveryTarget | undefined => {
    const recovery = options.selectRecoveryProfile?.(profile);
    return recovery ? { profile: recovery, reason: "same_model_channel_fallback" } : undefined;
  };
  return {
    async execute(request: NativeProviderRequest): Promise<Response> {
      const maxAttempts = options.maxAttempts ?? 2;
      const recoveryStartedAt = Date.now();
      const recoveryBudgetMs = options.recoveryBudgetMs ?? Number.POSITIVE_INFINITY;
      const minimumAttemptBudgetMs = options.minimumAttemptBudgetMs ?? 1;
      let current = options.initial;
      while (true) {
        const startedAt = Date.now();
        let responseFailure: BufferedProviderFailure | undefined;
        let attemptError: unknown;
        let recoverable: boolean;
        try {
          const adaptiveDeadline = await (options.firstModelEventDeadlineMs?.(current, request)
            ?? (request.body.byteLength / 4 >= 100_000 ? 75_000 : 45_000));
          const remainingBudget = Math.max(0, recoveryBudgetMs - (Date.now() - recoveryStartedAt));
          const deadline = Math.max(1, Math.min(adaptiveDeadline, remainingBudget));
          const attemptAbort = new AbortController();
          const attemptSignal = AbortSignal.any([request.signal, attemptAbort.signal]);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const headerTimeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const error = new ProviderPreOutputError("header_timeout", {
                rawResponseBytes: 0, modelVisibleOutputBytes: 0, protocolCompleted: false,
              }, {
                endpoint: current.networkEndpoint,
                executionProfileId: current.profile.executionProfileId,
              });
              attemptAbort.abort(error);
              reject(error);
            }, deadline);
          });
          let response: Response;
          try {
            response = await Promise.race([
              current.adapter.execute({ ...request, body: current.body ?? request.body, signal: attemptSignal }),
              headerTimeout,
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
          if ((response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
            const remaining = Math.max(1, deadline - (Date.now() - startedAt));
            response = await waitForFirstModelEvent(response, attemptSignal, remaining, startedAt, current);
          }
          const responseRecoverable = isRecoverableProviderStatus(response.status)
            || options.isRecoverableResponse?.(response, current) === true;
          const inspectFailure = !response.ok && options.isRecoverableFailure !== undefined;
          if (!responseRecoverable && !inspectFailure) {
            options.onRecoveryDecision?.("not_recoverable");
            options.onSelected?.(current);
            return response;
          }
          responseFailure = await bufferFailure(response);
          const failureRecoverable = options.isRecoverableFailure?.(responseFailure, current) === true;
          recoverable = responseRecoverable || failureRecoverable;
          if (!recoverable) {
            options.onRecoveryDecision?.("not_recoverable");
            options.onSelected?.(current);
            return new Response(new Uint8Array(responseFailure.body), { status: responseFailure.status, headers: responseFailure.headers });
          }
        } catch (error) {
          attemptError = error;
          recoverable = !request.signal.aborted;
        }

        const elapsed = Date.now() - recoveryStartedAt;
        const remainingBudget = Math.max(0, recoveryBudgetMs - elapsed);
        const attemptsBudgetExhausted = current.attemptIndex >= maxAttempts;
        const timeBudgetExhausted = remainingBudget < minimumAttemptBudgetMs;
        const preliminaryStop: ProviderRecoveryStopReason | undefined = request.signal.aborted
          ? "client_disconnected"
          : attemptsBudgetExhausted ? "max_attempts_reached"
            : timeBudgetExhausted ? "recovery_budget_exhausted"
              : !recoverable ? "not_recoverable" : undefined;
        await options.recordFailedAttempt({
          attempt: current,
          latencyMs: Date.now() - startedAt,
          response: responseFailure,
          error: attemptError,
          attemptsBudgetExhausted,
          timeBudgetExhausted,
        });
        const selectedTarget = preliminaryStop ? undefined
          : await options.selectRecoveryTarget?.(current, responseFailure, attemptError);
        const recoveryTarget = selectedTarget ?? (preliminaryStop ? undefined : legacyTarget(current.profile));
        const recoveryDecision: ProviderRecoveryStopReason | "executed" = preliminaryStop
          ?? (recoveryTarget ? "executed" : "no_compatible_profile");
        options.onRecoveryDecision?.(recoveryDecision);
        await options.recordRecoveryDecision?.({
          attempt: current,
          recoveryDecision,
          nextTarget: recoveryTarget,
          attemptsBudgetExhausted,
          timeBudgetExhausted,
        });
        if (!recoveryTarget) {
          options.onSelected?.(current);
          if (attemptError) throw attemptError;
          return new Response(new Uint8Array(responseFailure?.body ?? Buffer.from(recoveryDecision)), {
            status: responseFailure?.status ?? (recoveryDecision === "recovery_budget_exhausted" ? 504 : 502),
            headers: responseFailure?.headers,
          });
        }
        options.commitRecoveryTarget?.(current, recoveryTarget);
        current = await options.startRetry(recoveryTarget.profile, current.attemptIndex + 1, recoveryTarget);
      }
    },
  };
}
