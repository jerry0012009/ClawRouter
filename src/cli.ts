#!/usr/bin/env node
/**
 * ClawRouter CLI — Smart LLM Router (OpenRouter Edition)
 *
 * Usage:
 *   clawrouter                           # Start proxy
 *   clawrouter --version                 # Show version
 *   clawrouter --port 8402               # Custom port
 *   clawrouter setup                     # Save API key
 *   clawrouter stats                     # Usage stats
 *   clawrouter models                    # List models
 */

import { startProxy, getProxyPort } from "./proxy.js";
import { VERSION } from "./version.js";
import { resolveApiKey, resolveProxyApiKey, resolveProxyBaseUrl, saveApiKey } from "./auth.js";
import { BLOCKRUN_MODELS, MODEL_ALIASES } from "./models.js";

function printHelp(): void {
  console.log(`
ClawRouter v${VERSION} — Smart LLM Router (OpenRouter Edition)

Usage:
  clawrouter [options]
  clawrouter setup                     Save OpenRouter API key
  clawrouter models                    List available models
  clawrouter stats [--days <n>]        Usage stats (default: 7 days)
  clawrouter stats clear               Clear all usage logs

Options:
  --version, -v     Show version number
  --help, -h        Show this help message
  --port <number>   Port to listen on (default: ${getProxyPort()})

Environment:
  OPENROUTER_API_KEY    OpenRouter API key (or save via: clawrouter setup)

For more info: https://github.com/jerry0012009/ClawRouter
`);
}

async function queryProxy(path: string, port: number): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ── Flags ──
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    printHelp();
    return;
  }

  const command = args[0];
  const portArg = args.indexOf("--port");
  const port = portArg >= 0 ? parseInt(args[portArg + 1], 10) : getProxyPort();

  // ── Commands ──
  switch (command) {
    case "setup": {
      // Interactive API key setup
      const readline = await import("node:readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const key = await new Promise<string>((resolve) => {
        rl.question("Enter your OpenRouter API key: ", (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });
      if (!key) {
        console.error("No key entered.");
        process.exit(1);
      }
      saveApiKey(key);
      console.log("✓ API key saved. Run `clawrouter` to start the proxy.");
      return;
    }

    case "models": {
      console.log(`\nAvailable Models (${BLOCKRUN_MODELS.length}):\n`);
      const categories: Record<string, typeof BLOCKRUN_MODELS> = {};
      for (const m of BLOCKRUN_MODELS) {
        const provider = m.id.split("/")[0];
        if (!categories[provider]) categories[provider] = [];
        categories[provider].push(m);
      }
      for (const [provider, models] of Object.entries(categories)) {
        console.log(`  ${provider.toUpperCase()}`);
        for (const m of models) {
          const flags: string[] = [];
          if (m.reasoning) flags.push("reasoning");
          if (m.input.includes("image")) flags.push("vision");
          const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
          console.log(`    ${m.id.padEnd(40)} $${m.cost.input}/$${m.cost.output} per 1M tokens${flagStr}`);
        }
        console.log();
      }
      console.log("Aliases:");
      const aliasGroups = new Map<string, string[]>();
      for (const [alias, model] of Object.entries(MODEL_ALIASES)) {
        if (!aliasGroups.has(model)) aliasGroups.set(model, []);
        aliasGroups.get(model)!.push(alias);
      }
      for (const [model, aliases] of aliasGroups) {
        console.log(`  ${model.padEnd(40)} → ${aliases.join(", ")}`);
      }
      return;
    }

    case "stats": {
      try {
        if (args[1] === "clear") {
          const result = await queryProxy("/stats?clear=true", port);
          console.log("Stats cleared.");
          return;
        }
        const days = args.includes("--days") ? parseInt(args[args.indexOf("--days") + 1], 10) : 7;
        const stats = await queryProxy(`/stats?days=${days}`, port) as Record<string, unknown>;
        console.log(`\nUsage Stats (${days} days):\n`);
        console.log(JSON.stringify(stats, null, 2));
      } catch (err) {
        console.error(`Failed to get stats: ${err instanceof Error ? err.message : err}`);
        console.error("Is the proxy running? Start it with: clawrouter");
      }
      return;
    }

    case "status": {
      try {
        const health = await queryProxy("/health", port) as Record<string, unknown>;
        console.log(`\nProxy Status:\n`);
        console.log(JSON.stringify(health, null, 2));
      } catch {
        console.error("Proxy not running. Start it with: clawrouter");
      }
      return;
    }

    default: {
      // Assume it's a startup with potential --port flag
      if (command.startsWith("--")) {
        printHelp();
        return;
      }
      console.error(`Unknown command: ${command}`);
      console.error("Run `clawrouter --help` for usage.");
      process.exit(1);
    }
  }
}

// ── Direct proxy start (when no command or just --port) ──
async function startDirect(): Promise<void> {
  const args = process.argv.slice(2);
  const hasCommand = args.length > 0 && !args[0].startsWith("--");

  // If there's a command (setup, models, stats, status), handle it
  if (hasCommand) {
    await main();
    return;
  }

  // Otherwise start the proxy
  const portArg = args.indexOf("--port");
  const port = portArg >= 0 ? parseInt(args[portArg + 1], 10) : getProxyPort();

  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  let apiKey: string;
  try {
    apiKey = resolveApiKey();
  } catch (err) {
    console.error(`\n  ${err instanceof Error ? err.message : err}\n`);
    console.error("  Set OPENROUTER_API_KEY or run: clawrouter setup\n");
    process.exit(1);
  }

  const proxy = await startProxy({ apiKey, proxyApiKey: resolveProxyApiKey(), proxyBaseUrl: resolveProxyBaseUrl(), port });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[ClawRouter] Shutting down...");
    await proxy.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

startDirect().catch((err) => {
  console.error(`[ClawRouter] Fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
