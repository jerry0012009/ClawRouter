import { createHash } from "node:crypto";
import { isInternalIdentityHeader } from "./trusted-identity.js";

const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
]);

const SECRET_FIELD_PATTERN = /(?:^|[_-])(?:api[_-]?key|authorization|cookie|password|passwd|provider[_-]?key|secret|token)(?:$|[_-])/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const COMMON_KEY_PATTERN = /\b(?:sk|sk-proj|sk-ant|or)-[A-Za-z0-9_-]{12,}\b/g;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const CREDENTIAL_GIT_URL_PATTERN = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g;

function placeholder(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `<REDACTED_SECRET_${digest}>`;
}

function sanitizeString(value: string): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, (match) => placeholder(match))
    .replace(CREDENTIAL_GIT_URL_PATTERN, (_match, scheme: string) => `${scheme}<REDACTED_CREDENTIALS>@`)
    .replace(BEARER_PATTERN, (match) => placeholder(match))
    .replace(COMMON_KEY_PATTERN, (match) => placeholder(match));
}

export function sanitizeHeadersForPersistence(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const sanitized: Record<string, string | string[]> = {};
  for (const [name, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined || SECRET_HEADER_NAMES.has(name.toLowerCase())
      || isInternalIdentityHeader(name)) continue;
    sanitized[name.toLowerCase()] = Array.isArray(rawValue)
      ? rawValue.map(sanitizeString)
      : sanitizeString(rawValue);
  }
  return sanitized;
}

export function sanitizePayloadForPersistence(value: unknown, fieldName = ""): unknown {
  if (value === null || value === undefined) return value;
  if (SECRET_FIELD_PATTERN.test(fieldName)) return placeholder(String(value));
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizePayloadForPersistence(item));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      sanitizePayloadForPersistence(item, key),
    ]));
  }
  return value;
}
