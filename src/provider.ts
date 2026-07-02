/**
 * BlockRun ProviderPlugin for OpenClaw
 *
 * Registers ClawRouter as an LLM provider in OpenClaw.
 * Uses a local proxy to handle routing transparently —
 * the client sees a standard OpenAI-compatible API at localhost.
 */

import type { ProviderPlugin } from "./types.js";
import { buildProviderModels } from "./models.js";
import type { ProxyHandle } from "./proxy.js";
import { getProxyPort } from "./proxy.js";

let activeProxy: ProxyHandle | null = null;

export function setActiveProxy(proxy: ProxyHandle | null): void {
  activeProxy = proxy;
}

export function getActiveProxy(): ProxyHandle | null {
  return activeProxy;
}

export const blockrunProvider: ProviderPlugin = {
  id: "blockrun",
  label: "ClawRouter",
  docsPath: "https://github.com/jerry0012009/ClawRouter",
  aliases: ["cr", "clawrouter"],
  envVars: ["OPENROUTER_API_KEY"],

  get models() {
    const port = activeProxy?.port ?? getProxyPort();
    return buildProviderModels(`http://127.0.0.1:${port}/v1`);
  },

  // No auth required — the proxy handles API key internally
  auth: [],
};
