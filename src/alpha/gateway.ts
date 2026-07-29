import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { normalizeMessagesRequest } from "./protocol/messages.js";
import { normalizeResponsesRequest } from "./protocol/responses.js";
import type { CanonicalEnvelope } from "./protocol/types.js";
import type { NativeProviderAdapter } from "./provider.js";
import { relayProviderResponse, type RelayResult } from "./stream-relay.js";
import { verifyTrustedIdentity, type TrustedNewApiIdentity } from "./trusted-identity.js";

export type AlphaExecutionResolution = {
  adapter: NativeProviderAdapter;
  requestedModel: string;
  actualModel: string;
  provider: string;
  channel: string;
  body?: Uint8Array;
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
  resolveExecution(envelope: CanonicalEnvelope, identity: TrustedNewApiIdentity): Promise<AlphaExecutionResolution>;
  onTrace?(trace: AlphaGatewayTrace): Promise<void> | void;
  maxRequestBytes?: number;
  now?: () => Date;
};

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

function jsonError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent || response.destroyed) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ error: { type: "acu_gateway_error", message } }));
}

function pathProtocol(pathname: string): "responses" | "messages" | undefined {
  if (pathname === "/v1/responses") return "responses";
  if (pathname === "/v1/messages") return "messages";
  return undefined;
}

export function createAlphaGatewayServer(options: AlphaGatewayOptions): Server {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://acu.internal");
    if (request.method === "GET" && url.pathname === "/internal/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    const protocol = pathProtocol(url.pathname);
    if (request.method !== "POST" || !protocol) {
      jsonError(response, 404, "Unsupported ACU endpoint");
      return;
    }

    const abortController = new AbortController();
    request.once("aborted", () => abortController.abort(new Error("client aborted request")));
    response.once("close", () => {
      if (!response.writableEnded) abortController.abort(new Error("client disconnected"));
    });

    let trace: AlphaGatewayTrace | undefined;
    try {
      const body = await readRequestBody(request, options.maxRequestBytes ?? 32 * 1024 * 1024);
      const identity = verifyTrustedIdentity(request.headers, body, {
        sharedSecret: options.trustedIdentitySecret,
        now: options.now?.(),
      });
      const parsed = JSON.parse(body.toString("utf8")) as unknown;
      const envelope = protocol === "responses"
        ? normalizeResponsesRequest(parsed, request.headers)
        : normalizeMessagesRequest(parsed, request.headers, request.headers["x-claude-code-version"] as string | undefined);
      const resolution = await options.resolveExecution(envelope, identity);
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
      await options.onTrace?.(trace);
    } catch (error) {
      if (trace) {
        trace.status = abortController.signal.aborted ? "cancelled" : "failed";
        trace.error = error;
        await options.onTrace?.(trace);
      }
      if (!abortController.signal.aborted) jsonError(response, 502, error instanceof Error ? error.message : "ACU gateway failure");
    }
  });
}
