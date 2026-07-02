/**
 * Typed Error Classes for ClawRouter
 */

/** Thrown when all upstream models fail. */
export class UpstreamError extends Error {
  readonly code = "UPSTREAM_ERROR" as const;
  readonly status: number;
  readonly modelId: string;

  constructor(opts: { message: string; status: number; modelId: string }) {
    super(opts.message);
    this.name = "UpstreamError";
    this.status = opts.status;
    this.modelId = opts.modelId;
  }
}

/** Thrown when the API key is missing or invalid. */
export class AuthError extends Error {
  readonly code = "AUTH_ERROR" as const;

  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export function isUpstreamError(error: unknown): error is UpstreamError {
  return error instanceof Error && (error as UpstreamError).code === "UPSTREAM_ERROR";
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof Error && (error as AuthError).code === "AUTH_ERROR";
}
