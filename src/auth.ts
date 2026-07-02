/**
 * Authentication — Dual Upstream
 *
 * Resolves API keys for both upstream providers.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const CONFIG_DIR = join(homedir(), ".claw-router");

export function resolveApiKey(): string {
  const envKey = process.env.OPENROUTER_API_KEY;
  if (envKey?.trim()) return envKey.trim();
  const keyFile = join(CONFIG_DIR, "api-key");
  if (existsSync(keyFile)) {
    const key = readFileSync(keyFile, "utf-8").trim();
    if (key) return key;
  }
  throw new Error("OPENROUTER_API_KEY not set. Set env var or save to ~/.claw-router/api-key");
}

export function resolveProxyApiKey(): string | undefined {
  return process.env.PROXY_API_KEY?.trim() || undefined;
}

export function resolveProxyBaseUrl(): string | undefined {
  return process.env.PROXY_BASE_URL?.trim() || undefined;
}

export function saveApiKey(key: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(join(CONFIG_DIR, "api-key"), key.trim() + "\n", { mode: 0o600 });
  console.log(`[ClawRouter] API key saved to ${join(CONFIG_DIR, "api-key")}`);
}

export async function resolveOrGenerateWalletKey(): Promise<string> {
  const envKey = process.env.BLOCKRUN_WALLET_KEY?.trim();
  if (envKey) return envKey;

  const walletFile = join(CONFIG_DIR, "wallet.key");
  if (existsSync(walletFile)) {
    const key = readFileSync(walletFile, "utf-8").trim();
    if (key) return key;
  }

  mkdirSync(CONFIG_DIR, { recursive: true });
  const key = `0x${randomBytes(32).toString("hex")}`;
  writeFileSync(walletFile, `${key}\n`, { mode: 0o600 });
  return key;
}
