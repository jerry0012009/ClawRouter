import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { SseEventCollector } from "./sse.js";
import type { CapturePoint, CaptureRecord, CapturedBody } from "./types.js";

export type CaptureProxyOptions = {
  upstream: string;
  captureDir: string;
  capturePoint: CapturePoint;
  fixtureId: string;
  host?: string;
  port?: number;
  provider?: string;
  onRecord?: (record: CaptureRecord) => void | Promise<void>;
};

export type CaptureProxyHandle = {
  baseUrl: string;
  port: number;
  close: () => Promise<void>;
};

function headersObject(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  return Object.fromEntries(Object.entries(headers)
    .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined));
}

function bodyRecord(chunks: Buffer[]): CapturedBody {
  const body = Buffer.concat(chunks);
  const text = body.toString("utf8");
  const roundTrips = Buffer.from(text, "utf8").equals(body);
  return {
    encoding: roundTrips ? "utf8" : "base64",
    raw: roundTrips ? text : body.toString("base64"),
    byte_length: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function protocolFor(pathname: string): CaptureRecord["protocol"] {
  if (/(?:^|\/)responses\/?$/.test(pathname)) return "responses";
  if (/(?:^|\/)messages\/?$/.test(pathname)) return "messages";
  if (/(?:^|\/)chat\/completions\/?$/.test(pathname)) return "chat_completions";
  return "unknown";
}

function requestId(headers: Record<string, string | string[]>, names: string[]): string | null {
  for (const name of names) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (typeof value === "string" && value) return value;
    if (Array.isArray(value) && value[0]) return value[0];
  }
  return null;
}

function parseModel(chunks: Buffer[]): string | null {
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    return typeof value.model === "string" ? value.model : null;
  } catch {
    return null;
  }
}

function forwardedHeaders(req: IncomingMessage, upstream: URL): IncomingHttpHeaders {
  const headers = { ...req.headers };
  headers.host = upstream.host;
  delete headers["proxy-connection"];
  return headers;
}

function endClient(res: ServerResponse, chunk?: Buffer): void {
  if (res.destroyed || res.writableEnded) return;
  if (chunk) res.end(chunk);
  else res.end();
}

async function persistRecord(directory: string, record: CaptureRecord): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = `${record.fixture_id}-${record.capture_point}-${record.capture_id}.json`;
  await writeFile(join(directory, filename), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export async function startCaptureProxy(options: CaptureProxyOptions): Promise<CaptureProxyHandle> {
  const upstreamBase = new URL(options.upstream);
  const server = createServer((req, res) => {
    const startedAt = new Date().toISOString();
    const captureId = randomUUID();
    const requestChunks: Buffer[] = [];
    const responseChunks: Buffer[] = [];
    const events = new SseEventCollector();
    const incomingHeaders = headersObject(req.headers);
    const incomingUrl = new URL(req.url ?? "/", "http://capture.invalid");
    const target = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, upstreamBase.origin);
    const connection: CaptureRecord["connection"] = {
      started_at: startedAt,
      request_ended_at: null,
      response_started_at: null,
      response_ended_at: null,
      interrupted_at: null,
      client_cancelled: false,
      client_cancelled_at: null,
    };
    let responseStatus: number | null = null;
    let responseHeaders: Record<string, string | string[]> = {};
    let captureError: string | null = null;
    let completed = false;
    let upstreamResponse: IncomingMessage | undefined;

    const finalize = async (): Promise<void> => {
      if (completed) return;
      completed = true;
      events.finish();
      const responseBody = bodyRecord(responseChunks);
      const record: CaptureRecord = {
        schema_version: "acu-protocol-capture-v1",
        fixture_id: options.fixtureId,
        capture_id: captureId,
        capture_point: options.capturePoint,
        connection,
        request: {
          method: req.method ?? "GET",
          path: incomingUrl.pathname,
          query: incomingUrl.searchParams.toString(),
          headers: incomingHeaders,
          body: bodyRecord(requestChunks),
        },
        response: {
          status_code: responseStatus,
          headers: responseHeaders,
          body: responseBody,
          streaming_events: events.events,
        },
        ids: {
          upstream_request_id: requestId(responseHeaders, ["x-request-id", "request-id"]),
          new_api_request_id: requestId({ ...incomingHeaders, ...responseHeaders }, ["x-new-api-request-id", "x-request-id"]),
          acu_request_id: requestId({ ...incomingHeaders, ...responseHeaders }, ["x-acu-request-id", "x-acu-trace-id"]),
          provider_request_id: requestId(responseHeaders, ["x-provider-request-id", "openai-request-id", "request-id"]),
        },
        model: parseModel(requestChunks),
        provider: options.provider ?? null,
        protocol: protocolFor(incomingUrl.pathname),
        upstream_url: target.toString(),
        capture_error: captureError,
      };
      await persistRecord(options.captureDir, record);
      await options.onRecord?.(record);
    };

    const requester = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstreamReq = requester(target, {
      method: req.method,
      headers: forwardedHeaders(req, target),
    }, (upstreamRes) => {
      upstreamResponse = upstreamRes;
      connection.response_started_at = new Date().toISOString();
      responseStatus = upstreamRes.statusCode ?? 502;
      responseHeaders = headersObject(upstreamRes.headers);
      res.writeHead(responseStatus, upstreamRes.headers);
      res.flushHeaders();
      const isSse = String(upstreamRes.headers["content-type"] ?? "").includes("text/event-stream");
      upstreamRes.on("data", (value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        responseChunks.push(chunk);
        if (isSse) events.push(chunk);
        if (!res.write(chunk)) upstreamRes.pause();
      });
      res.on("drain", () => upstreamRes.resume());
      upstreamRes.on("end", () => {
        connection.response_ended_at = new Date().toISOString();
        endClient(res);
        void finalize();
      });
      upstreamRes.on("aborted", () => {
        connection.interrupted_at ??= new Date().toISOString();
        captureError = "upstream_response_aborted";
        endClient(res);
        void finalize();
      });
      upstreamRes.on("error", (error) => {
        connection.interrupted_at ??= new Date().toISOString();
        captureError = `upstream_response_error:${error.message}`;
        endClient(res);
        void finalize();
      });
    });

    req.on("data", (value: Buffer | string) => requestChunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value)));
    req.on("end", () => { connection.request_ended_at = new Date().toISOString(); });
    req.on("aborted", () => {
      connection.client_cancelled = true;
      connection.client_cancelled_at = new Date().toISOString();
      connection.interrupted_at ??= connection.client_cancelled_at;
      upstreamReq.destroy();
      void finalize();
    });
    res.on("close", () => {
      const protocolCompleted = events.events.some((event) => event.completed_stop_event);
      if (connection.response_ended_at || completed || upstreamResponse?.complete || upstreamResponse?.readableEnded || protocolCompleted) return;
      connection.client_cancelled = true;
      connection.client_cancelled_at = new Date().toISOString();
      connection.interrupted_at ??= connection.client_cancelled_at;
      upstreamResponse?.destroy();
      upstreamReq.destroy();
      void finalize();
    });
    upstreamReq.on("error", (error) => {
      if (completed) return;
      captureError = `upstream_request_error:${error.message}`;
      connection.interrupted_at ??= new Date().toISOString();
      if (!res.headersSent) {
        responseStatus = 502;
        responseHeaders = { "content-type": "application/json" };
        const body = Buffer.from(JSON.stringify({ error: { type: "capture_upstream_error", message: "Capture upstream unavailable" } }));
        responseChunks.push(body);
        res.writeHead(502, responseHeaders);
        endClient(res, body);
      } else endClient(res);
      void finalize();
    });
    req.pipe(upstreamReq);
  });

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const boundPort = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://${host}:${boundPort}`,
    port: boundPort,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
