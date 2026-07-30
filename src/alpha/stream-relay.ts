import type { ServerResponse } from "node:http";
import { isHopByHopHeader } from "./provider.js";
import { inspectWebSearchEvidence, WebSearchStreamObserver, type WebSearchEvidence } from "./web-search.js";
import { getResponseObservation, ModelOutputObserver } from "./model-output.js";

export type RelayResult = {
  body: Buffer;
  httpStatus: number;
  responseHeaders: Record<string, string>;
  complete: boolean;
  clientCancelled: boolean;
  rawResponseBytes: number;
  modelVisibleOutputBytes: number;
  firstModelEventAt?: string;
  firstModelEventLatencyMs?: number;
  responseStarted: boolean;
  webSearch: WebSearchEvidence;
};

function copyResponseHeaders(upstream: Response, response: ServerResponse): void {
  response.statusCode = upstream.status;
  upstream.headers.forEach((value, name) => {
    if (!isHopByHopHeader(name) && name.toLowerCase() !== "content-encoding") {
      response.setHeader(name, value);
    }
  });
}

function decodedResponseHeaders(upstream: Response): Record<string, string> {
  return Object.fromEntries([...upstream.headers.entries()].filter(([name]) =>
    !isHopByHopHeader(name) && name.toLowerCase() !== "content-encoding"));
}

export async function relayProviderResponse(upstream: Response, response: ServerResponse): Promise<RelayResult> {
  copyResponseHeaders(upstream, response);
  response.flushHeaders();
  const chunks: Buffer[] = [];
  const preObserved = getResponseObservation(upstream);
  const modelObserver = new ModelOutputObserver(Date.now() - (preObserved?.firstModelEventLatencyMs ?? 0));
  let complete = true;
  let clientCancelled = false;
  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const webObserver = contentType.toLowerCase().includes("text/event-stream")
    ? new WebSearchStreamObserver()
    : undefined;
  if (upstream.body) {
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        const chunk = Buffer.from(item.value);
        chunks.push(chunk);
        webObserver?.observe(chunk);
        modelObserver.observe(chunk);
        if (response.destroyed || !response.write(chunk)) {
          if (response.destroyed) {
            complete = false;
            clientCancelled = true;
            await reader.cancel("client disconnected");
            break;
          }
          await new Promise<void>((resolve) => response.once("drain", resolve));
        }
      }
    } catch (error) {
      complete = false;
      clientCancelled = response.destroyed;
      if (!clientCancelled) throw error;
    }
  }
  const body = Buffer.concat(chunks);
  const observed = modelObserver.result();
  return {
    body,
    httpStatus: upstream.status,
    responseHeaders: decodedResponseHeaders(upstream),
    complete,
    clientCancelled,
    rawResponseBytes: observed.rawResponseBytes,
    modelVisibleOutputBytes: observed.modelVisibleOutputBytes,
    firstModelEventAt: preObserved?.firstModelEventAt?.toISOString() ?? observed.firstModelEventAt?.toISOString(),
    firstModelEventLatencyMs: preObserved?.firstModelEventLatencyMs ?? observed.firstModelEventLatencyMs,
    responseStarted: response.headersSent,
    webSearch: webObserver?.evidence() ?? inspectWebSearchEvidence(body, contentType),
  };
}
