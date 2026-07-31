type JsonObject = Record<string, unknown>;

export type WebSearchEvidence = {
  actuallyInvoked: boolean;
  eventStatus: string[];
  executionCompleted: boolean;
  resultVerified: boolean;
  searchLatencyMs?: number;
};

export class WebSearchStreamObserver {
  private readonly statuses = new Set<string>();
  private pending = "";
  private invoked = false;
  private completed = false;
  private result = false;
  private searchStartedAt?: number;
  private searchCompletedAt?: number;

  observe(chunk: Buffer): void {
    this.pending += chunk.toString("utf8");
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let payload: unknown;
      try { payload = JSON.parse(data) as unknown; } catch { continue; }
      const observed = observePayload(payload, this.statuses);
      const observedAt = Date.now();
      if (observed.invoked && this.searchStartedAt === undefined) this.searchStartedAt = observedAt;
      if (observed.completed) this.searchCompletedAt = observedAt;
      this.invoked ||= observed.invoked;
      this.completed ||= observed.completed;
      this.result ||= observed.result;
    }
  }

  evidence(): WebSearchEvidence {
    return {
      actuallyInvoked: this.invoked,
      eventStatus: [...this.statuses],
      executionCompleted: this.completed,
      resultVerified: this.result,
      searchLatencyMs: this.searchStartedAt === undefined || this.searchCompletedAt === undefined
        ? undefined
        : Math.max(0, this.searchCompletedAt - this.searchStartedAt),
    };
  }
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function observePayload(payload: unknown, statuses: Set<string>): { invoked: boolean; completed: boolean; result: boolean } {
  const root = object(payload);
  const type = typeof root?.type === "string" ? root.type : "";
  let invoked = false;
  let completed = false;
  let result = false;
  if (type.startsWith("response.web_search_call.")) {
    const status = type.slice("response.web_search_call.".length);
    statuses.add(status);
    invoked = true;
    completed = status === "completed";
  }
  const contentBlock = object(root?.content_block);
  if (type === "content_block_start" && contentBlock?.type === "server_tool_use"
    && contentBlock.name === "web_search") {
    statuses.add("in_progress");
    invoked = true;
  }
  if (type === "content_block_start" && contentBlock?.type === "web_search_tool_result") {
    statuses.add("completed");
    invoked = true;
    completed = true;
    result = true;
  }
  const item = object(root?.item) ?? object(root?.output_item);
  if (item?.type === "web_search_call") {
    invoked = true;
    result = true;
    if (typeof item.status === "string") statuses.add(item.status);
    completed = item.status === "completed";
  }
  const response = object(root?.response) ?? root;
  const output = Array.isArray(response?.output) ? response.output : [];
  for (const value of output) {
    const outputItem = object(value);
    if (outputItem?.type !== "web_search_call") continue;
    invoked = true;
    result = true;
    if (typeof outputItem.status === "string") statuses.add(outputItem.status);
    if (outputItem.status === "completed") completed = true;
  }
  const content = Array.isArray(response?.content) ? response.content : [];
  for (const value of content) {
    const block = object(value);
    if (block?.type === "server_tool_use" && block.name === "web_search") {
      statuses.add("in_progress");
      invoked = true;
    }
    if (block?.type === "web_search_tool_result") {
      statuses.add("completed");
      invoked = true;
      completed = true;
      result = true;
    }
  }
  return { invoked, completed, result };
}

export function inspectWebSearchEvidence(body: Buffer, contentType: string): WebSearchEvidence {
  const statuses = new Set<string>();
  let actuallyInvoked = false;
  let executionCompleted = false;
  let resultVerified = false;
  const text = body.toString("utf8");
  const payloads: unknown[] = contentType.toLowerCase().includes("text/event-stream")
    ? text.split(/\r?\n/).flatMap((line) => {
      if (!line.startsWith("data:")) return [];
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return [];
      try { return [JSON.parse(data) as unknown]; } catch { return []; }
    })
    : (() => { try { return [JSON.parse(text) as unknown]; } catch { return []; } })();
  for (const payload of payloads) {
    const observed = observePayload(payload, statuses);
    actuallyInvoked ||= observed.invoked;
    executionCompleted ||= observed.completed;
    resultVerified ||= observed.result;
  }
  return {
    actuallyInvoked,
    eventStatus: [...statuses],
    executionCompleted,
    resultVerified,
    searchLatencyMs: undefined,
  };
}
