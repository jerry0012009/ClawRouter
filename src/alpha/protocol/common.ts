import { createHash } from "node:crypto";

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function textParts(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  return array(value).flatMap((part) => {
    const item = record(part);
    if (!item) return [];
    const type = typeof item.type === "string" ? item.type : "";
    if (!["text", "input_text", "output_text"].includes(type)) return [];
    return typeof item.text === "string" && item.text.trim() ? [item.text] : [];
  });
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
