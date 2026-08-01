export type ModelOutputObservation = {
  rawResponseBytes: number;
  modelVisibleOutputBytes: number;
  firstModelEventAt?: Date;
  firstModelEventLatencyMs?: number;
  protocolCompleted?: boolean;
};

function hasChatDelta(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return false;
  return choices.some((choice) => {
    const delta = (choice as { delta?: unknown } | undefined)?.delta;
    if (!delta || typeof delta !== "object") return false;
    const record = delta as Record<string, unknown>;
    return (typeof record.content === "string" && record.content.length > 0)
      || (typeof record.reasoning_content === "string" && record.reasoning_content.length > 0)
      || Array.isArray(record.tool_calls)
      || record.function_call !== undefined;
  });
}

function isModelEvent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (/^response\.(?:output_item|content_part)\.added$/.test(type)) return true;
  if (/^response\.(?:output_text|reasoning|function_call_arguments|custom_tool_call_input)\.delta$/.test(type)) return true;
  if (type === "content_block_start" || type === "content_block_delta") return true;
  return hasChatDelta(value);
}

function isProtocolCompleted(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "response.completed") return true;
  if (record.type !== "message_stop") return false;
  return true;
}

export class ModelOutputObserver {
  private pending = "";
  private observation: ModelOutputObservation = { rawResponseBytes: 0, modelVisibleOutputBytes: 0, protocolCompleted: false };

  constructor(private readonly startedAtMs: number) {}

  observe(chunk: Uint8Array): void {
    this.observation.rawResponseBytes += chunk.byteLength;
    this.pending += Buffer.from(chunk).toString("utf8");
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.observeLine(line);
  }

  private observeLine(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data);
      if (isProtocolCompleted(parsed)) this.observation.protocolCompleted = true;
      if (!isModelEvent(parsed)) return;
      const bytes = Buffer.byteLength(`${line}\n`);
      this.observation.modelVisibleOutputBytes += bytes;
      if (!this.observation.firstModelEventAt) {
        const now = new Date();
        this.observation.firstModelEventAt = now;
        this.observation.firstModelEventLatencyMs = Math.max(0, now.getTime() - this.startedAtMs);
      }
    } catch {
      // Non-JSON SSE data is not a verified model output event.
    }
  }

  hasModelEvent(): boolean {
    return this.observation.firstModelEventAt !== undefined;
  }

  result(): ModelOutputObservation {
    return { ...this.observation };
  }
}

const responseObservations = new WeakMap<Response, ModelOutputObservation>();

export function setResponseObservation(response: Response, observation: ModelOutputObservation): void {
  responseObservations.set(response, observation);
}

export function getResponseObservation(response: Response): ModelOutputObservation | undefined {
  return responseObservations.get(response);
}
