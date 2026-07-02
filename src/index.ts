/**
 * ClawRouter — Smart LLM Router (OpenRouter Edition)
 *
 * Routes each request to the cheapest capable model via OpenRouter.
 * 22+ models, smart 15-dimension routing, <1ms local decisions.
 *
 * Usage:
 *   clawrouter                           # Start proxy
 *   clawrouter --port 8402               # Custom port
 *   OPENROUTER_API_KEY=sk-... clawrouter # Set API key
 */

import { startProxy, getProxyPort, buildProxyModelList } from "./proxy.js";
import { blockrunProvider, setActiveProxy } from "./provider.js";
import { resolveApiKey, saveApiKey } from "./auth.js";
import { BLOCKRUN_MODELS, OPENCLAW_MODELS, resolveModelAlias, MODEL_ALIASES } from "./models.js";
import { route, DEFAULT_ROUTING_CONFIG, getFallbackChain, calculateModelCost } from "./router/index.js";
import type { RoutingDecision, RoutingConfig, Tier } from "./router/index.js";
import { logUsage } from "./logger.js";
import type { UsageEntry } from "./logger.js";
import { RequestDeduplicator } from "./dedup.js";
import type { CachedResponse } from "./dedup.js";
import { ResponseCache } from "./response-cache.js";
import { SessionStore, getSessionId, hashRequestContent, DEFAULT_SESSION_CONFIG } from "./session.js";
import type { SessionEntry, SessionConfig } from "./session.js";
import { VERSION } from "./version.js";
import type {
  OpenClawPluginDefinition,
  OpenClawPluginApi,
  PluginCommandContext,
  PluginCommandResult,
  OpenClawPluginCommandDefinition,
} from "./types.js";

import { writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function getPackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Install skills to OpenClaw workspace.
 */
function installSkillsToWorkspace(logger: { info: (msg: string) => void; warn: (msg: string) => void }) {
  try {
    const packageRoot = getPackageRoot();
    const bundledSkillsDir = join(packageRoot, "skills");
    if (!existsSync(bundledSkillsDir)) return;

    const profile = (process["env"].OPENCLAW_PROFILE ?? "").trim().toLowerCase();
    const workspaceDirName = profile && profile !== "default" ? `workspace-${profile}` : "workspace";
    const workspaceSkillsDir = join(homedir(), ".openclaw", workspaceDirName, "skills");
    mkdirSync(workspaceSkillsDir, { recursive: true });

    const entries = readdirSync(bundledSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const srcSkillFile = join(bundledSkillsDir, entry.name, "SKILL.md");
      const dstSkillDir = join(workspaceSkillsDir, entry.name);
      const dstSkillFile = join(dstSkillDir, "SKILL.md");
      if (!existsSync(srcSkillFile)) continue;
      if (existsSync(dstSkillFile)) {
        const src = require("node:fs").readFileSync(srcSkillFile, "utf-8") as string;
        const dst = require("node:fs").readFileSync(dstSkillFile, "utf-8") as string;
        if (src === dst) continue;
      }
      mkdirSync(dstSkillDir, { recursive: true });
      copyFileSync(srcSkillFile, dstSkillFile);
      logger.info(`Installed skill: ${entry.name}`);
    }
  } catch (err) {
    logger.warn(`Skill install failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Plugin definition ──

const plugin: OpenClawPluginDefinition = {
  reload: { noopPrefixes: ["models.providers.blockrun"] },

  async register(api: OpenClawPluginApi) {
    api.registerProvider(blockrunProvider);
  },

  async activate(api: OpenClawPluginApi) {
    // Resolve API key
    let apiKey: string;
    try {
      apiKey = resolveApiKey();
    } catch {
      api.logger.warn("OpenRouter API key not set. Set OPENROUTER_API_KEY or save to ~/.claw-router/api-key");
      return;
    }

    // Start proxy
    const proxy = await startProxy({
      apiKey,
      onRouted: (decision) => {
        api.logger.info(`Routed → ${decision.model} (${decision.tier}, ${(decision.savings * 100).toFixed(0)}% savings)`);
      },
    });
    setActiveProxy(proxy);

    // Install skills
    installSkillsToWorkspace(api.logger);

    api.logger.info(`ClawRouter v${VERSION} active — proxy on ${proxy.baseUrl}`);
  },

  async deactivate(api: OpenClawPluginApi) {
    setActiveProxy(null);
    api.logger.info("ClawRouter deactivated");
  },
};

export default plugin;

// ── Re-exports ──

export { startProxy, getProxyPort } from "./proxy.js";
export { resolveApiKey, saveApiKey } from "./auth.js";
export { blockrunProvider } from "./provider.js";
export {
  OPENCLAW_MODELS, BLOCKRUN_MODELS, buildProviderModels,
  MODEL_ALIASES, resolveModelAlias,
  supportsToolCalling, supportsVision, isReasoningModel, getModelContextWindow,
} from "./models.js";
export { route, DEFAULT_ROUTING_CONFIG, getFallbackChain, calculateModelCost } from "./router/index.js";
export type { RoutingDecision, RoutingConfig, Tier } from "./router/index.js";
export { logUsage } from "./logger.js";
export type { UsageEntry } from "./logger.js";
export { RequestDeduplicator } from "./dedup.js";
export type { CachedResponse } from "./dedup.js";
export { SessionStore, getSessionId, hashRequestContent } from "./session.js";
export type { SessionEntry, SessionConfig } from "./session.js";
export { ResponseCache } from "./response-cache.js";
export { VERSION } from "./version.js";
