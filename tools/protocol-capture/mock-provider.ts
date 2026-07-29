import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type MockProviderOptions = {
  port?: number;
  host?: string;
  status?: number;
  failCount?: number;
  delayMs?: number;
  streamDelayMs?: number;
};

export type MockProviderHandle = { baseUrl: string; close: () => Promise<void> };

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

function sendSse(res: ServerResponse, events: Array<{ event: string; data: unknown }>, initialDelayMs = 0): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-request-id": `mock-${randomUUID()}` });
  res.flushHeaders();
  let index = 0;
  const writeNext = (): void => {
    const item = events[index++];
    if (!item) {
      res.end();
      return;
    }
    res.write(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`);
    setTimeout(writeNext, 2);
  };
  setTimeout(writeNext, initialDelayMs);
}

function responsesPayload(model: string, text: string): Record<string, unknown> {
  return {
    id: `resp_mock_${randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: [{ id: `msg_${randomUUID()}`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 16 },
  };
}

function responsesEvents(payload: Record<string, unknown>, text: string): Array<{ event: string; data: unknown }> {
  const output = (payload.output as unknown[])[0] as Record<string, unknown>;
  const content = (output.content as unknown[])[0];
  return [
    { event: "response.created", data: { type: "response.created", response: { ...payload, status: "in_progress", output: [] }, sequence_number: 0 } },
    { event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { ...output, status: "in_progress", content: [] }, sequence_number: 1 } },
    { event: "response.content_part.added", data: { type: "response.content_part.added", item_id: output.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] }, sequence_number: 2 } },
    { event: "response.output_text.delta", data: { type: "response.output_text.delta", item_id: output.id, output_index: 0, content_index: 0, delta: text, sequence_number: 3 } },
    { event: "response.output_text.done", data: { type: "response.output_text.done", item_id: output.id, output_index: 0, content_index: 0, text, sequence_number: 4 } },
    { event: "response.content_part.done", data: { type: "response.content_part.done", item_id: output.id, output_index: 0, content_index: 0, part: content, sequence_number: 5 } },
    { event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item: output, sequence_number: 6 } },
    { event: "response.completed", data: { type: "response.completed", response: payload, sequence_number: 7 } },
  ];
}

function errorPayload(status: number, attempt: number): Record<string, unknown> {
  return {
    error: {
      type: status === 429 ? "rate_limit_error" : "mock_provider_error",
      message: `controlled mock status ${status}`,
      status,
      attempt,
    },
  };
}

export async function startMockProvider(options: number | MockProviderOptions = 0): Promise<MockProviderHandle> {
  const normalized = typeof options === "number" ? { port: options } : options;
  const port = normalized.port ?? 0;
  const host = normalized.host ?? "127.0.0.1";
  const status = normalized.status ?? 200;
  const failCount = normalized.failCount ?? (status === 200 ? 0 : Number.POSITIVE_INFINITY);
  const delayMs = normalized.delayMs ?? 0;
  const streamDelayMs = normalized.streamDelayMs ?? 0;
  let requestCount = 0;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://mock.invalid").pathname;
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    const body = await jsonBody(req);
    const model = typeof body.model === "string" ? body.model : "mock-model";
    const attempt = ++requestCount;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (attempt <= failCount) {
      res.writeHead(status, {
        "content-type": "application/json",
        "retry-after": "0",
        "x-mock-attempt": String(attempt),
        "x-request-id": `mock-${randomUUID()}`,
      }).end(JSON.stringify(errorPayload(status, attempt)));
      return;
    }
    if (path.endsWith("/responses")) {
      const text = "mock protocol response";
      const payload = responsesPayload(model, text);
      if (body.stream === true) sendSse(res, responsesEvents(payload, text), streamDelayMs);
      else res.writeHead(200, { "content-type": "application/json", "x-request-id": `mock-${randomUUID()}` }).end(JSON.stringify(payload));
      return;
    }
    if (path.endsWith("/messages")) {
      const payload = { id: `msg_mock_${randomUUID()}`, type: "message", role: "assistant", model, content: [{ type: "text", text: "mock protocol response" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 12, output_tokens: 4 } };
      if (body.stream === true) sendSse(res, [
        { event: "message_start", data: { type: "message_start", message: { ...payload, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } } },
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "mock protocol response" } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } } },
        { event: "message_stop", data: { type: "message_stop" } },
      ], streamDelayMs);
      else res.writeHead(200, { "content-type": "application/json", "request-id": `mock-${randomUUID()}` }).end(JSON.stringify(payload));
      return;
    }
    if (path.endsWith("/chat/completions")) {
      const payload = { id: `chatcmpl_mock_${randomUUID()}`, object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "mock protocol response" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const bound = (server.address() as AddressInfo).port;
  const advertisedHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return { baseUrl: `http://${advertisedHost}:${bound}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
