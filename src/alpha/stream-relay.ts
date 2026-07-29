import type { ServerResponse } from "node:http";
import { isHopByHopHeader } from "./provider.js";

export type RelayResult = {
  body: Buffer;
  complete: boolean;
  clientCancelled: boolean;
  visibleOutputBytes: number;
  responseStarted: boolean;
};

function copyResponseHeaders(upstream: Response, response: ServerResponse): void {
  response.statusCode = upstream.status;
  upstream.headers.forEach((value, name) => {
    if (!isHopByHopHeader(name)) response.setHeader(name, value);
  });
}

export async function relayProviderResponse(upstream: Response, response: ServerResponse): Promise<RelayResult> {
  copyResponseHeaders(upstream, response);
  response.flushHeaders();
  const chunks: Buffer[] = [];
  let visibleOutputBytes = 0;
  let complete = true;
  let clientCancelled = false;
  if (upstream.body) {
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        const chunk = Buffer.from(item.value);
        chunks.push(chunk);
        visibleOutputBytes += chunk.length;
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
  if (!response.destroyed) response.end();
  return {
    body: Buffer.concat(chunks),
    complete,
    clientCancelled,
    visibleOutputBytes,
    responseStarted: response.headersSent,
  };
}
