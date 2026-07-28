import type { StreamEvent } from "./types.js";

function stringAt(value: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    let cursor: unknown = value;
    for (const key of path) {
      if (!cursor || typeof cursor !== "object") {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (typeof cursor === "string") return cursor;
  }
  return null;
}

function parseEvent(rawEvent: string, sequence: number, arrivedAt: string): StreamEvent {
  let eventName: string | null = null;
  const data: string[] = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim() || null;
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  const payloadText = data.join("\n");
  let payload: unknown | null = null;
  if (payloadText && payloadText !== "[DONE]") {
    try {
      payload = JSON.parse(payloadText) as unknown;
    } catch {
      payload = payloadText;
    }
  }
  const payloadType = payload && typeof payload === "object"
    ? String((payload as Record<string, unknown>).type ?? "")
    : "";
  const effectiveName = eventName ?? (payloadType || null);
  const usage = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>).usage
      ?? ((payload as Record<string, unknown>).response as Record<string, unknown> | undefined)?.usage
      ?? null
    : null;
  const stopped = payloadText === "[DONE]"
    || /(?:completed|message_stop|response\.done|response\.completed|content_block_stop)$/i.test(effectiveName ?? "");
  const isError = /error/i.test(effectiveName ?? "")
    || Boolean(payload && typeof payload === "object" && "error" in payload);
  return {
    event_name: effectiveName,
    event_sequence: sequence,
    raw_event: rawEvent,
    raw_event_json: payload,
    arrived_at: arrivedAt,
    text_delta: stringAt(payload, [
      ["delta"], ["text"], ["delta", "text"], ["delta", "content"],
      ["choices", "0", "delta", "content"],
    ]),
    tool_arguments_delta: stringAt(payload, [
      ["delta", "partial_json"], ["delta", "arguments"], ["arguments_delta"],
    ]),
    thinking_reasoning_delta: stringAt(payload, [
      ["delta", "thinking"], ["delta", "reasoning"], ["reasoning_delta"], ["summary_text_delta"],
    ]),
    usage_event: usage,
    completed_stop_event: stopped,
    error_event: isError ? payload ?? payloadText : null,
  };
}

export class SseEventCollector {
  private pending = "";
  private sequence = 0;
  readonly events: StreamEvent[] = [];

  push(chunk: Buffer, arrivedAt = new Date().toISOString()): void {
    this.pending += chunk.toString("utf8");
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match || match.index === undefined) break;
      const end = match.index + match[0].length;
      const raw = this.pending.slice(0, end);
      this.pending = this.pending.slice(end);
      this.events.push(parseEvent(raw, ++this.sequence, arrivedAt));
    }
  }

  finish(arrivedAt = new Date().toISOString()): void {
    if (!this.pending) return;
    this.events.push(parseEvent(this.pending, ++this.sequence, arrivedAt));
    this.pending = "";
  }
}
