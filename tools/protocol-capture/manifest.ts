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
  if (manifest.provider_kind !== undefined && !new Set(["real", "mock"]).has(String(manifest.provider_kind))) errors.push("provider_kind is invalid");
  if (manifest.through_acu !== undefined && typeof manifest.through_acu !== "boolean") errors.push("through_acu must be boolean");
  if (manifest.retry_setting !== undefined
    && !(Number.isInteger(manifest.retry_setting) && Number(manifest.retry_setting) >= 0)
    && !new Set(["not_applicable", "unknown"]).has(String(manifest.retry_setting))) errors.push("retry_setting is invalid");
  if (manifest.capture_completeness !== undefined) {
    const completeness = manifest.capture_completeness as Record<string, unknown>;
    for (const point of ["A", "B", "C", "D"]) {
      if (!new Set(["captured", "not_available", "not_applicable"]).has(String(completeness?.[point]))) {
        errors.push(`capture_completeness.${point} is invalid`);
      }
    }
  }
  return errors;
}

export function assertValidManifest(value: unknown): asserts value is ProtocolFixtureManifest {
  const errors = validateManifest(value);
  if (errors.length > 0) throw new Error(`Invalid protocol fixture manifest: ${errors.join("; ")}`);
}
