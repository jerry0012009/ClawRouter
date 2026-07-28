import type { ProtocolFixtureManifest } from "./types.js";

const REQUIRED_STRING_FIELDS = [
  "fixture_id", "captured_at", "client_version", "os", "newapi_version", "acu_commit",
  "provider", "requested_model", "actual_model", "scenario",
] as const;

export function validateManifest(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["manifest must be an object"];
  const manifest = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof manifest[field] !== "string" || manifest[field] === "") errors.push(`${field} must be a non-empty string`);
  }
  if (!new Set(["codex", "claude-code"]).has(String(manifest.client))) errors.push("client is invalid");
  if (!new Set(["responses", "messages", "chat_completions"]).has(String(manifest.protocol))) errors.push("protocol is invalid");
  if (!new Set(["complete", "partial", "blocked", "failed"]).has(String(manifest.capture_status))) errors.push("capture_status is invalid");
  for (const field of ["stream", "contains_tools", "contains_reasoning", "contains_plan_signal", "sanitized"]) {
    if (typeof manifest[field] !== "boolean") errors.push(`${field} must be boolean`);
  }
  if (manifest.sanitized !== true) errors.push("sanitized must be true");
  if (!Number.isInteger(manifest.request_count) || Number(manifest.request_count) < 0) errors.push("request_count must be a non-negative integer");
  if (!Array.isArray(manifest.capture_points)
    || manifest.capture_points.some((point) => !new Set(["A", "B", "C", "D"]).has(String(point)))) {
    errors.push("capture_points must contain only A/B/C/D");
  }
  if (typeof manifest.captured_at === "string" && Number.isNaN(Date.parse(manifest.captured_at))) errors.push("captured_at must be ISO-8601");
  return errors;
}

export function assertValidManifest(value: unknown): asserts value is ProtocolFixtureManifest {
  const errors = validateManifest(value);
  if (errors.length > 0) throw new Error(`Invalid protocol fixture manifest: ${errors.join("; ")}`);
}
