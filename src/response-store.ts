/**
 * Response store — stub for share functionality.
 */
type ResponseEntry = {
  id: string;
  timestamp: string;
  model: string;
  sessionId?: string;
  requestSummary: string;
  responseText: string;
};

const store: ResponseEntry[] = [];
let nextId = 1;

export function summarizeRequest(text: string): string {
  return text.slice(0, 100).replace(/\n/g, " ");
}

export async function appendResponse(entry: Omit<ResponseEntry, "id">): Promise<void> {
  store.push({ ...entry, id: String(nextId++) });
  if (store.length > 100) store.shift();
}

export async function getLast(_sessionId?: string): Promise<ResponseEntry | undefined> {
  return store[store.length - 1];
}

export async function listRecent(limit: number): Promise<ResponseEntry[]> {
  return store.slice(-limit);
}

export async function getById(id: string): Promise<ResponseEntry | undefined> {
  return store.find((e) => e.id === id);
}
