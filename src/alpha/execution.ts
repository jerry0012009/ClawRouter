import type { NativeProviderAdapter, NativeProviderRequest } from "./provider.js";
import type { AlphaExecutionProfile } from "./routing.js";
import { ModelOutputObserver, setResponseObservation } from "./model-output.js";

export type ProviderAttemptHandle = {
  attemptId: string;
  attemptIndex: number;
  adapter: NativeProviderAdapter;
  profile: AlphaExecutionProfile;
  networkEndpointIndex?: number;
  networkEndpoint?: string;
  body?: Uint8Array;
};

export type ProviderRecoveryTarget = {
  profile: AlphaExecutionProfile;
  networkEndpointIndex?: number;
  reason: "network_endpoint_fallback" | "same_model_channel_fallback";
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
  startRetry(profile: AlphaExecutionProfile, attemptIndex: number, target?: ProviderRecoveryTarget): Promise<ProviderAttemptHandle>;
  recordFailedAttempt(input: {
    attempt: ProviderAttemptHandle;
    latencyMs: number;
    response?: BufferedProviderFailure;
    error?: unknown;
  }): Promise<void>;
  onSelected?(attempt: ProviderAttemptHandle): void;
};

export function isRecoverableProviderStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
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
          const recoverable = isRecoverableProviderStatus(response.status)
            || options.isRecoverableResponse?.(response, current) === true;
          if (!recoverable
            || current.attemptIndex >= maxAttempts
            || request.signal.aborted) {
            options.onSelected?.(current);
            return response;
          }
          const failure = await bufferFailure(response);
          recoveryTarget = options.selectRecoveryTarget?.(current, failure) ?? legacyTarget(current.profile);
          if (!recoveryTarget) {
            options.onSelected?.(current);
            return new Response(new Uint8Array(failure.body), { status: failure.status, headers: failure.headers });
          }
          await options.recordFailedAttempt({
            attempt: current,
            latencyMs: Date.now() - startedAt,
            response: failure,
          });
        } catch (error) {
          if (request.signal.aborted || current.attemptIndex >= maxAttempts) throw error;
          recoveryTarget = options.selectRecoveryTarget?.(current, undefined, error) ?? legacyTarget(current.profile);
          if (!recoveryTarget) throw error;
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
