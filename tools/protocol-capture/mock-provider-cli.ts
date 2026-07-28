#!/usr/bin/env node
import { startMockProvider } from "./mock-provider.js";

const handle = await startMockProvider(Number(process.env.PROTOCOL_MOCK_PORT || 9090));
console.log(`Controlled protocol mock provider listening at ${handle.baseUrl}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void handle.close().finally(() => process.exit(0)));
}
