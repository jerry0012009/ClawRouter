import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { normalizeMessagesRequest } from "./protocol/messages.js";
import { normalizeResponsesRequest } from "./protocol/responses.js";
import type { CanonicalEnvelope } from "./protocol/types.js";
import type { NativeProviderAdapter } from "./provider.js";
import { relayProviderResponse, type RelayResult } from "./stream-relay.js";
import { verifyTrustedIdentity, type TrustedNewApiIdentity } from "./trusted-identity.js";
import { AlphaAdmissionError } from "./routing.js";
import type { MonitorRange } from "./channel-monitor.js";

export type AlphaExecutionResolution = {
  adapter: NativeProviderAdapter;
  requestedModel: string;
  actualModel: string;
  provider: string;
  channel: string;
  body?: Uint8Array;
  context?: unknown;
};

export type AlphaIngressContext = {
  headers: IncomingMessage["headers"];
  path: string;
  query: string;
  rawBody: Uint8Array;
  signal: AbortSignal;
};

export type AlphaGatewayTrace = {
  requestBody: Uint8Array;
  response?: RelayResult;
  envelope: CanonicalEnvelope;
  identity: TrustedNewApiIdentity;
  resolution: AlphaExecutionResolution;
  status: "started" | "completed" | "cancelled" | "failed";
  error?: unknown;
};

export type AlphaGatewayOptions = {
  trustedIdentitySecret: string;
  adminTrace?: {
    token: string;
    load(logicalRequestId: string): Promise<Record<string, unknown> | undefined>;
  };
  adminChannelMonitor?: {
    token: string;
    load(range: MonitorRange): Promise<Record<string, unknown>>;
    pause(channelId: string, durationMinutes: 30 | 120, actor: string): Promise<Record<string, unknown>>;
  };
  adminSelectionCorridor?: {
    token: string;
    load(inputTokens: number, expectedOutputTokens: number): Promise<Record<string, unknown>>;
  };
  models?: string[];
  requirePrivateNetwork?: boolean;
  healthCheck?(): Promise<Record<string, unknown>>;
  resolveExecution(envelope: CanonicalEnvelope, identity: TrustedNewApiIdentity, ingress: AlphaIngressContext): Promise<AlphaExecutionResolution>;
  onTrace?(trace: AlphaGatewayTrace): Promise<void> | void;
  onTraceError?(error: unknown, trace: AlphaGatewayTrace): Promise<void> | void;
  maxRequestBytes?: number;
  now?: () => Date;
};

const DEFAULT_MAX_REQUEST_BYTES = 128 * 1024 * 1024;

function adminBearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return undefined;
  return /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length += chunk.length;
    if (length > maxBytes) throw new Error("Request body exceeds the configured limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function jsonError(response: ServerResponse, status: number, message: string, protocol?: "responses" | "messages", error?: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  const admission = error instanceof AlphaAdmissionError ? error : undefined;
  response.end(
    JSON.stringify(
      protocol === "messages"
        ? {
            type: "error",
            error: { type: admission?.errorType ?? "api_error", message, ...admission?.details },
          }
        : {
            error: {
              type: admission?.errorType ?? "acu_gateway_error",
              message,
              ...admission?.details,
            },
          },
    ),
  );
}

function executionErrorStatus(error: unknown): number {
  const status = Number((error as { statusCode?: unknown } | undefined)?.statusCode);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

function pathProtocol(pathname: string): "responses" | "messages" | undefined {
  if (pathname === "/v1/responses") return "responses";
  if (pathname === "/v1/messages") return "messages";
  return undefined;
}

export function isPrivateNetworkAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (normalized === "::1" || normalized === "127.0.0.1") return true;
  if (normalized.startsWith("10.") || normalized.startsWith("192.168.")) return true;
  const secondOctet = /^172\.(\d+)\./.exec(normalized)?.[1];
  if (secondOctet && Number(secondOctet) >= 16 && Number(secondOctet) <= 31) return true;
  return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

export function createAlphaGatewayServer(options: AlphaGatewayOptions): Server {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://acu.internal");
    if (request.method === "GET" && url.pathname === "/internal/health") {
      try {
        const details = (await options.healthCheck?.()) ?? {};
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "ok", ...details }));
      } catch {
        jsonError(response, 503, "ACU dependency health check failed");
      }
      return;
    }
    if ((options.requirePrivateNetwork ?? true) && !isPrivateNetworkAddress(request.socket.remoteAddress)) {
      jsonError(response, 403, "ACU ingress is restricted to private network sources");
      return;
    }
    if (url.pathname === "/internal/admin/channel-monitor" && (request.method === "GET" || request.method === "POST")) {
      if (!options.adminChannelMonitor) {
        jsonError(response, 404, "Unsupported ACU endpoint");
        return;
      }
      const token = adminBearerToken(request);
      if (!token || !tokenMatches(token, options.adminChannelMonitor.token)) {
        jsonError(response, token ? 403 : 401, token ? "Administrator identity is not authorized" : "Administrator bearer token is required");
        return;
      }
      try {
        const result =
          request.method === "GET"
            ? await options.adminChannelMonitor.load((url.searchParams.get("range") as MonitorRange) || "1h")
            : await (async () => {
                const body = JSON.parse((await readRequestBody(request, 16 * 1024)).toString("utf8")) as Record<string, unknown>;
                const durationMinutes = Number(body.durationMinutes);
                if (typeof body.channelId !== "string" || ![30, 120].includes(durationMinutes)) throw new Error("Invalid Channel pause request");
                return options.adminChannelMonitor!.pause(body.channelId, durationMinutes as 30 | 120, String(body.actor || "new-api-admin"));
              })();
        response.setHeader("cache-control", "no-store");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(result));
      } catch (error) {
        jsonError(response, 400, error instanceof Error ? error.message : "Channel monitor request failed");
      }
      return;
    }
    if (url.pathname === "/internal/admin/selection-corridor" && request.method === "GET") {
      if (!options.adminSelectionCorridor) {
        jsonError(response, 404, "Unsupported ACU endpoint");
        return;
      }
      const token = adminBearerToken(request);
      if (!token || !tokenMatches(token, options.adminSelectionCorridor.token)) {
        jsonError(response, token ? 403 : 401, token ? "Administrator identity is not authorized" : "Administrator bearer token is required");
        return;
      }
      try {
        const inputTokens = Math.max(1, Math.min(1_000_000, Number(url.searchParams.get("inputTokens")) || 100_000));
        const expectedOutputTokens = Math.max(1, Math.min(100_000, Number(url.searchParams.get("expectedOutputTokens")) || 4_000));
        const result = await options.adminSelectionCorridor.load(inputTokens, expectedOutputTokens);
        response.setHeader("cache-control", "no-store");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(result));
      } catch (error) {
        jsonError(response, 503, error instanceof Error ? error.message : "ACU selection corridor is unavailable");
      }
      return;
    }
    const adminTraceMatch = /^\/internal\/admin\/traces\/(req_[A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    if (request.method === "GET" && adminTraceMatch) {
      if (!options.adminTrace) {
        jsonError(response, 404, "Unsupported ACU endpoint");
        return;
      }
      const token = adminBearerToken(request);
      if (!token) {
        jsonError(response, 401, "Administrator bearer token is required");
        return;
      }
      if (!tokenMatches(token, options.adminTrace.token)) {
        jsonError(response, 403, "Administrator identity is not authorized");
        return;
      }
      try {
        const trace = await options.adminTrace.load(adminTraceMatch[1]);
        if (!trace) {
          jsonError(response, 404, "Logical request trace was not found");
          return;
        }
        response.setHeader("cache-control", "no-store");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(trace));
      } catch {
        jsonError(response, 503, "ACU trace store is unavailable");
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      try {
        verifyTrustedIdentity(request.headers, Buffer.alloc(0), {
          sharedSecret: options.trustedIdentitySecret,
          now: options.now?.(),
        });
        const modelIds = [...new Set(["acu-auto", "acu-high", ...(options.models ?? [])])];
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            object: "list",
            data: modelIds.map((id) => ({ id, object: "model", created: 0, owned_by: "acu" })),
          }),
        );
      } catch (error) {
        jsonError(response, 401, error instanceof Error ? error.message : "Untrusted ACU identity");
      }
      return;
    }
    const protocol = pathProtocol(url.pathname);
    if (request.method !== "POST" || !protocol) {
      jsonError(response, 404, "Unsupported ACU endpoint", protocol);
      return;
    }

    const abortController = new AbortController();
    request.once("aborted", () => abortController.abort(new Error("client aborted request")));
    response.once("close", () => {
      if (!response.writableEnded) abortController.abort(new Error("client disconnected"));
    });

    let trace: AlphaGatewayTrace | undefined;
    let stage: "body" | "identity" | "protocol" | "execution" = "body";
    try {
      const body = await readRequestBody(request, options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES);
      stage = "identity";
      const identity = verifyTrustedIdentity(request.headers, body, {
        sharedSecret: options.trustedIdentitySecret,
        now: options.now?.(),
      });
      stage = "protocol";
      const parsed = JSON.parse(body.toString("utf8")) as unknown;
      const envelope =
        protocol === "responses"
          ? normalizeResponsesRequest(parsed, request.headers)
          : normalizeMessagesRequest(parsed, request.headers, identity.clientVersion === "unknown" ? undefined : identity.clientVersion);
      stage = "execution";
      const resolution = await options.resolveExecution(envelope, identity, {
        headers: request.headers,
        path: url.pathname,
        query: url.search,
        rawBody: body,
        signal: abortController.signal,
      });
      trace = { requestBody: body, envelope, identity, resolution, status: "started" };
      await options.onTrace?.(trace);
      const upstream = await resolution.adapter.execute({
        protocol,
        path: url.pathname,
        query: url.search,
        headers: request.headers,
        body: resolution.body ?? body,
        signal: abortController.signal,
      });
      const relay = await relayProviderResponse(upstream, response);
      trace.response = relay;
      trace.status = relay.clientCancelled ? "cancelled" : "completed";
      try {
        await options.onTrace?.(trace);
      } catch (traceError) {
        await options.onTraceError?.(traceError, trace);
      }
      if (!response.destroyed) response.end();
    } catch (error) {
      if (trace) {
        trace.status = abortController.signal.aborted ? "cancelled" : "failed";
        trace.error = error;
        try {
          await options.onTrace?.(trace);
        } catch (traceError) {
          await options.onTraceError?.(traceError, trace);
        }
      }
      if (!abortController.signal.aborted) {
        if (response.headersSent && !response.destroyed) response.end();
        else {
          const status = stage === "identity" ? 401 : stage === "protocol" ? 400 : stage === "body" ? 413 : executionErrorStatus(error);
          jsonError(response, status, error instanceof Error ? error.message : "ACU gateway failure", protocol, error);
        }
      }
    }
  });
}
