import type { NativeProviderAdapter, NativeProviderRequest } from "./provider.js";
import type { AlphaExecutionProfile } from "./routing.js";

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
};

export type ProviderRecoveryOptions = {
  initial: ProviderAttemptHandle;
  maxAttempts?: number;
  selectRecoveryProfile?(current: AlphaExecutionProfile): AlphaExecutionProfile | undefined;
  selectRecoveryTarget?(current: ProviderAttemptHandle, failure?: BufferedProviderFailure, error?: unknown): ProviderRecoveryTarget | undefined;
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
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function bufferFailure(response: Response): Promise<BufferedProviderFailure> {
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: Buffer.from(await response.arrayBuffer()),
  };
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
          const response = await current.adapter.execute({ ...request, body: current.body ?? request.body });
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
