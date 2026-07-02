/**
 * OpenRouter Authentication
 *
 * Resolves the OpenRouter API key from environment variable or config file.
 * No wallet management — OpenRouter handles billing via API key.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".claw-router");
const KEY_FILE = join(CONFIG_DIR, "api-key");

/**
 * Resolve OpenRouter API key.
 * Priority: env var → config file → error.
 */
export function resolveApiKey(): string {
  // 1. Environment variable
  const envKey = process.env.OPENROUTER_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();

  // 2. Config file
  if (existsSync(KEY_FILE)) {
    const key = readFileSync(KEY_FILE, "utf-8").trim();
    if (key) return key;
  }

  throw new Error(
    "OpenRouter API key not found.\n" +
    "Set OPENROUTER_API_KEY environment variable or save key to ~/.claw-router/api-key"
  );
}

/**
 * Save API key to config file.
 */
export function saveApiKey(key: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(KEY_FILE, key.trim() + "\n", { mode: 0o600 });
  console.log(`[ClawRouter] API key saved to ${KEY_FILE}`);
}
