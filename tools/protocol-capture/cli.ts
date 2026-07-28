#!/usr/bin/env node
import { resolve } from "node:path";
import { startCaptureProxy } from "./proxy.js";
import type { CapturePoint } from "./types.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const point = required("PROTOCOL_CAPTURE_POINT");
if (!new Set(["A", "B", "C", "D"]).has(point)) throw new Error("PROTOCOL_CAPTURE_POINT must be A, B, C, or D");

const handle = await startCaptureProxy({
  upstream: required("PROTOCOL_CAPTURE_UPSTREAM"),
  captureDir: resolve(required("PROTOCOL_CAPTURE_DIR")),
  capturePoint: point as CapturePoint,
  fixtureId: process.env.PROTOCOL_FIXTURE_ID?.trim() || `manual-${Date.now()}`,
  provider: process.env.PROTOCOL_CAPTURE_PROVIDER?.trim(),
  host: process.env.PROTOCOL_CAPTURE_HOST?.trim() || "127.0.0.1",
  port: Number(process.env.PROTOCOL_CAPTURE_PORT || 9081),
});

console.log(`Protocol capture ${point} listening at ${handle.baseUrl}`);
console.log(`Forwarding to ${required("PROTOCOL_CAPTURE_UPSTREAM")}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void handle.close().finally(() => process.exit(0)));
}
