import type { NativeProviderAdapter, NativeProviderRequest } from "./provider.js";
import type { AlphaExecutionProfile } from "./routing.js";

export type ProviderAttemptHandle = {
  attemptId: string;
  attemptIndex: number;
  adapter: NativeProviderAdapter;
  profile: AlphaExecutionProfile;
  body?: Uint8Array;
};

export type BufferedProviderFailure = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

export type ProviderRecoveryOptions = {
  initial: ProviderAttemptHandle;
  maxAttempts?: number;
  selectRecoveryProfile(current: AlphaExecutionProfile): AlphaExecutionProfile | undefined;
  startRetry(profile: AlphaExecutionProfile, attemptIndex: number): Promise<ProviderAttemptHandle>;
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
  return {
    async execute(request: NativeProviderRequest): Promise<Response> {
      const maxAttempts = options.maxAttempts ?? 2;
      let current = options.initial;
      while (true) {
        const startedAt = Date.now();
        let recoveryProfile: AlphaExecutionProfile | undefined;
        try {
          const response = await current.adapter.execute({ ...request, body: current.body ?? request.body });
          if (!isRecoverableProviderStatus(response.status)
            || current.attemptIndex >= maxAttempts
            || request.signal.aborted) {
            options.onSelected?.(current);
            return response;
          }
          recoveryProfile = options.selectRecoveryProfile(current.profile);
          if (!recoveryProfile) {
            options.onSelected?.(current);
            return response;
          }
          const failure = await bufferFailure(response);
          await options.recordFailedAttempt({
            attempt: current,
            latencyMs: Date.now() - startedAt,
            response: failure,
          });
        } catch (error) {
          if (request.signal.aborted || current.attemptIndex >= maxAttempts) throw error;
          recoveryProfile = options.selectRecoveryProfile(current.profile);
          if (!recoveryProfile) throw error;
          await options.recordFailedAttempt({
            attempt: current,
            latencyMs: Date.now() - startedAt,
            error,
          });
        }
        current = await options.startRetry(recoveryProfile, current.attemptIndex + 1);
      }
    },
  };
}
