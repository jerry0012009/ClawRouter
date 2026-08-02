import type { NativeProviderAdapter, NativeProviderRequest } from "./provider.js";
import type { AlphaExecutionProfile } from "./routing.js";
import { ModelOutputObserver, setResponseObservation } from "./model-output.js";
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

export type BufferedProviderFailure = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  observation?: ReturnType<ModelOutputObserver["result"]>;
};

export type ProviderRecoveryOptions = {
  initial: ProviderAttemptHandle;
  maxAttempts?: number;
  selectRecoveryProfile?(current: AlphaExecutionProfile): AlphaExecutionProfile | undefined;
  selectRecoveryTarget?(current: ProviderAttemptHandle, failure?: BufferedProviderFailure, error?: unknown): ProviderRecoveryTarget | undefined;
  hasRecoveryTarget?(current: ProviderAttemptHandle): boolean;
  firstModelEventDeadlineMs?(attempt: ProviderAttemptHandle, request: NativeProviderRequest): number;
  isRecoverableResponse?(response: Response, attempt: ProviderAttemptHandle): boolean;
  isRecoverableFailure?(failure: BufferedProviderFailure, attempt: ProviderAttemptHandle): boolean;
  startRetry(profile: AlphaExecutionProfile, attemptIndex: number, target?: ProviderRecoveryTarget): Promise<ProviderAttemptHandle>;
  recordFailedAttempt(input: {
    attempt: ProviderAttemptHandle;
    latencyMs: number;
    response?: BufferedProviderFailure;
    error?: unknown;
  }): Promise<void>;
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

class SlowFirstModelEventError extends Error {
  constructor(readonly observation: ReturnType<ModelOutputObserver["result"]>) {
    super("slow_first_model_event");
    this.name = "SlowFirstModelEventError";
  }
}

async function waitForFirstModelEvent(response: Response, signal: AbortSignal, deadlineMs: number, startedAt: number): Promise<Response> {
  if (!response.body || !(response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) return response;
  const reader = response.body.getReader();
  const observer = new ModelOutputObserver(startedAt);
  const buffered: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SlowFirstModelEventError(observer.result())), deadlineMs);
  });
  try {
    while (!observer.hasModelEvent()) {
      const item = await Promise.race([reader.read(), timeout]);
      if (item.done) break;
      buffered.push(item.value);
      observer.observe(item.value);
    }
    if (!observer.hasModelEvent()) throw new Error("provider_stream_ended_before_model_event");
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
      let current = options.initial;
      while (true) {
        const startedAt = Date.now();
        let recoveryTarget: ProviderRecoveryTarget | undefined;
        try {
          const watchdogEnabled = options.hasRecoveryTarget?.(current) === true;
          const deadline = options.firstModelEventDeadlineMs?.(current, request) ?? (request.body.byteLength / 4 >= 100_000 ? 75_000 : 45_000);
          const attemptAbort = new AbortController();
          const attemptSignal = AbortSignal.any([request.signal, attemptAbort.signal]);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const headerTimeout = new Promise<never>((_, reject) => {
            if (!watchdogEnabled) return;
            timer = setTimeout(() => {
              const error = new SlowFirstModelEventError({ rawResponseBytes: 0, modelVisibleOutputBytes: 0 });
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
          if (response.ok && watchdogEnabled) {
            const remaining = Math.max(1, deadline - (Date.now() - startedAt));
            response = await waitForFirstModelEvent(response, attemptSignal, remaining, startedAt);
          }
          const responseRecoverable = isRecoverableProviderStatus(response.status)
            || options.isRecoverableResponse?.(response, current) === true;
          const inspectFailure = !response.ok && options.isRecoverableFailure !== undefined;
          if ((!responseRecoverable && !inspectFailure) || current.attemptIndex >= maxAttempts || request.signal.aborted) {
            options.onRecoveryDecision?.(!responseRecoverable && !inspectFailure ? "not_recoverable"
              : request.signal.aborted ? "client_disconnected" : "max_attempts_reached");
            options.onSelected?.(current);
            return response;
          }
          const failure = await bufferFailure(response);
          const failureRecoverable = options.isRecoverableFailure?.(failure, current) === true;
          const recoverable = responseRecoverable || failureRecoverable;
          if (!recoverable) {
            options.onRecoveryDecision?.("not_recoverable");
            options.onSelected?.(current);
            return new Response(new Uint8Array(failure.body), { status: failure.status, headers: failure.headers });
          }
          recoveryTarget = options.selectRecoveryTarget?.(current, failure) ?? legacyTarget(current.profile);
          if (!recoveryTarget) {
            options.onRecoveryDecision?.("no_compatible_profile");
            options.onSelected?.(current);
            return new Response(new Uint8Array(failure.body), { status: failure.status, headers: failure.headers });
          }
          options.onRecoveryDecision?.("executed");
          await options.recordFailedAttempt({
            attempt: current,
            latencyMs: Date.now() - startedAt,
            response: failure,
          });
        } catch (error) {
          if (request.signal.aborted || current.attemptIndex >= maxAttempts) {
            options.onRecoveryDecision?.(request.signal.aborted ? "client_disconnected" : "max_attempts_reached");
            throw error;
          }
          recoveryTarget = options.selectRecoveryTarget?.(current, undefined, error) ?? legacyTarget(current.profile);
          if (!recoveryTarget) {
            options.onRecoveryDecision?.("no_compatible_profile");
            throw error;
          }
          options.onRecoveryDecision?.("executed");
          await options.recordFailedAttempt({
            attempt: current,
            latencyMs: Date.now() - startedAt,
            error,
          });
        }
        current = await options.startRetry(recoveryTarget.profile, current.attemptIndex + 1, recoveryTarget);
      }
    },
  };
}
