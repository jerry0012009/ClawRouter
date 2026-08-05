import { describe, expect, it } from "vitest";
import { sanitizeHeadersForPersistence, sanitizePayloadForPersistence } from "../src/alpha/secrets.js";

describe("Alpha persistence secret boundary", () => {
  it("drops credential headers case-insensitively", () => {
    expect(sanitizeHeadersForPersistence({
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      "X-Api-Key": "secret",
      "X-ACU-NewAPI-User-ID": "user-1",
      "X-ACU-Signature": "signed-value",
      "X-Request-ID": "request-1",
    })).toEqual({ "x-request-id": "request-1" });
  });

  it("uses deterministic non-reversible placeholders", () => {
    const input = { token: "same-secret", nested: { api_key: "same-secret" } };
    const first = sanitizePayloadForPersistence(input) as typeof input;
    const second = sanitizePayloadForPersistence(input) as typeof input;
    expect(first).toEqual(second);
    expect(first.token).toBe(first.nested.api_key);
    expect(first.token).toMatch(/^<REDACTED_SECRET_[a-f0-9]{16}>$/);
  });

  it("removes NUL characters that PostgreSQL jsonb cannot store", () => {
    const sanitized = sanitizePayloadForPersistence({
      input: "before\u0000after",
      nested: ["\u0000"],
    });

    expect(sanitized).toEqual({
      input: "before\uFFFDafter",
      nested: ["\uFFFD"],
    });
    expect(JSON.stringify(sanitized)).not.toContain("\\u0000");
  });
});
