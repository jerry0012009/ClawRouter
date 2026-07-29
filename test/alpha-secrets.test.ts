import { describe, expect, it } from "vitest";
import { sanitizeHeadersForPersistence, sanitizePayloadForPersistence } from "../src/alpha/secrets.js";

describe("Alpha persistence secret boundary", () => {
  it("drops credential headers case-insensitively", () => {
    expect(sanitizeHeadersForPersistence({
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      "X-Api-Key": "secret",
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
});
