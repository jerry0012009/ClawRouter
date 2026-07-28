import { createHmac, randomBytes } from "node:crypto";
import type { CaptureRecord } from "./types.js";

const SECRET_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie|x-new-api-token|x-provider-key)$/i;
const SECRET_KEY = /(^|_)(authorization|api_?key|token|cookie|secret|password|account_?id|user_?id|email)($|_)/i;

export class DeterministicRedactor {
  private readonly values = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  placeholder(value: string, category: string): string {
    const existing = this.values.get(value);
    if (existing) return existing;
    const normalized = category.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const next = (this.counters.get(normalized) ?? 0) + 1;
    this.counters.set(normalized, next);
    const result = `<REDACTED_${normalized}_${next}>`;
    this.values.set(value, result);
    return result;
  }

  text(input: string): string {
    let value = input;
    value = value.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, (match) => this.placeholder(match, "api_key"));
    value = value.replace(/\bBearer\s+([^\s,;]+)/gi, (_match, token: string) => `Bearer ${this.placeholder(token, "api_key")}`);
    value = value.replace(/https?:\/\/([^\s/@:]+):([^\s/@]+)@/g, (match, user: string, pass: string) => (
      match.replace(`${user}:${pass}@`, `${this.placeholder(user, "git_user")}:${this.placeholder(pass, "git_credential")}@`)
    ));
    value = value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, (match) => this.placeholder(match, "email"));
    value = value.replace(/(?:\/root|\/home\/[^/\s"']+)(?=\/|\b)/g, (match) => this.placeholder(match, "user_home"));
    return value;
  }

  headers(headers: Record<string, string | string[]>): Record<string, string | string[]> {
    return Object.fromEntries(Object.entries(headers).map(([name, raw]) => {
      const redactOne = (item: string): string => SECRET_HEADER.test(name)
        ? this.placeholder(item, name.replace(/^x-/, ""))
        : this.text(item);
      return [name, Array.isArray(raw) ? raw.map(redactOne) : redactOne(raw)];
    }));
  }

  value(input: unknown, key = ""): unknown {
    if (typeof input === "string") {
      return SECRET_KEY.test(key) ? this.placeholder(input, key || "secret") : this.text(input);
    }
    if (Array.isArray(input)) return input.map((item) => this.value(item, key));
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .map(([childKey, child]) => [childKey, this.value(child, childKey)]));
    }
    return input;
  }
}

export function nonReversibleOriginalHash(value: string | Buffer, ephemeralKey: Buffer): string {
  return `hmac-sha256:${createHmac("sha256", ephemeralKey).update(value).digest("hex")}`;
}

function sanitizeBody(raw: string, encoding: "utf8" | "base64", redactor: DeterministicRedactor): string {
  if (encoding === "base64") return redactor.placeholder(raw, "binary_body");
  try {
    return JSON.stringify(redactor.value(JSON.parse(raw) as unknown));
  } catch {
    return redactor.text(raw);
  }
}

export function sanitizeCapture(
  record: CaptureRecord,
  redactor = new DeterministicRedactor(),
  ephemeralHashKey = randomBytes(32),
): CaptureRecord {
  const clone = structuredClone(record);
  clone.request.headers = redactor.headers(clone.request.headers);
  clone.response.headers = redactor.headers(clone.response.headers);
  const requestRaw = clone.request.body.raw;
  const responseRaw = clone.response.body.raw;
  clone.request.body.raw = sanitizeBody(requestRaw, clone.request.body.encoding, redactor);
  clone.response.body.raw = sanitizeBody(responseRaw, clone.response.body.encoding, redactor);
  clone.request.body.sha256 = nonReversibleOriginalHash(requestRaw, ephemeralHashKey);
  clone.response.body.sha256 = nonReversibleOriginalHash(responseRaw, ephemeralHashKey);
  clone.upstream_url = redactor.text(clone.upstream_url);
  clone.response.streaming_events = clone.response.streaming_events.map((event) => ({
    ...event,
    raw_event: redactor.text(event.raw_event),
    raw_event_json: redactor.value(event.raw_event_json),
    text_delta: event.text_delta === null ? null : redactor.text(event.text_delta),
    tool_arguments_delta: event.tool_arguments_delta === null ? null : redactor.text(event.tool_arguments_delta),
    thinking_reasoning_delta: event.thinking_reasoning_delta === null ? null : redactor.text(event.thinking_reasoning_delta),
    usage_event: redactor.value(event.usage_event),
    error_event: redactor.value(event.error_event),
  }));
  clone.capture_error = clone.capture_error === null ? null : redactor.text(clone.capture_error);
  return clone;
}
