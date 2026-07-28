#!/usr/bin/env node
import { startMockProvider } from "./mock-provider.js";

const handle = await startMockProvider({
  port: Number(process.env.PROTOCOL_MOCK_PORT || 9090),
  status: Number(process.env.PROTOCOL_MOCK_STATUS || 200),
  failCount: process.env.PROTOCOL_MOCK_FAIL_COUNT === undefined
    ? undefined
    : Number(process.env.PROTOCOL_MOCK_FAIL_COUNT),
  delayMs: Number(process.env.PROTOCOL_MOCK_DELAY_MS || 0),
  streamDelayMs: Number(process.env.PROTOCOL_MOCK_STREAM_DELAY_MS || 0),
});
console.log(`Controlled protocol mock provider listening at ${handle.baseUrl}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void handle.close().finally(() => process.exit(0)));
}
