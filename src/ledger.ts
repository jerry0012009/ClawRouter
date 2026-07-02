/**
 * ACU Ledger
 *
 * Append-only request ledger for ACU Router demos.
 * Files: ~/.claw-router/ledger/YYYY-MM-DD.jsonl
 */

import { mkdir, readdir, unlink, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { readTextFile } from "./fs-read.js";

function ledgerDir(): string {
  return process.env.ACU_LEDGER_DIR?.trim() || join(homedir(), ".claw-router", "ledger");
}

export type AcuLedgerEntry = {
  request_id: string;
  timestamp: string;
  prompt_hash: string;
  task_type: string;
  profile: string;
  tier: string;
  method: string;
  selected_model: string;
  actual_model_used: string;
  upstream: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
  actual_cost: number;
  baseline_model: string;
  baseline_cost: number;
  savings: number;
  latency_ms: number;
  fallback_attempts: number;
  fallback_used: boolean;
  quality_fallback_used: boolean;
  validator_result: string;
  quality_score?: number;
  cache_hit: boolean;
  error_category?: string;
};

export type AcuLedgerSummary = {
  total_requests: number;
  total_cost: number;
  total_baseline_cost: number;
  total_savings: number;
  avg_latency_ms: number;
  fallback_rate: number;
  validator_pass_rate: number;
  by_model: Record<string, { count: number; cost: number; baseline_cost: number; savings: number }>;
  by_tier: Record<string, { count: number; cost: number; baseline_cost: number; savings: number }>;
  by_task_type: Record<string, { count: number; cost: number; baseline_cost: number; savings: number }>;
  recent: AcuLedgerEntry[];
};

async function ensureLedgerDir(): Promise<void> {
  await mkdir(ledgerDir(), { recursive: true });
}

function ledgerFileFor(date: string): string {
  return join(ledgerDir(), `${date}.jsonl`);
}

async function getLedgerFiles(): Promise<string[]> {
  try {
    const files = await readdir(ledgerDir());
    return files.filter((file) => file.endsWith(".jsonl")).sort().reverse();
  } catch {
    return [];
  }
}

async function readLedgerFile(file: string): Promise<AcuLedgerEntry[]> {
  try {
    const text = await readTextFile(join(ledgerDir(), file));
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as AcuLedgerEntry];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export async function appendLedgerEntry(entry: AcuLedgerEntry): Promise<void> {
  try {
    await ensureLedgerDir();
    const date = entry.timestamp.slice(0, 10);
    await appendFile(ledgerFileFor(date), JSON.stringify(entry) + "\n");
  } catch {
    // Ledger must never break request flow.
  }
}

export async function getLedgerEntries(days = 7): Promise<AcuLedgerEntry[]> {
  const files = (await getLedgerFiles()).slice(0, Math.max(1, Math.min(days, 30)));
  const entries: AcuLedgerEntry[] = [];
  for (const file of files) entries.push(...await readLedgerFile(file));
  return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function addGroup(
  group: Record<string, { count: number; cost: number; baseline_cost: number; savings: number }>,
  key: string,
  entry: AcuLedgerEntry,
): void {
  if (!group[key]) group[key] = { count: 0, cost: 0, baseline_cost: 0, savings: 0 };
  group[key].count++;
  group[key].cost += entry.actual_cost;
  group[key].baseline_cost += entry.baseline_cost;
  group[key].savings += entry.savings;
}

export async function getLedgerSummary(days = 7): Promise<AcuLedgerSummary> {
  const entries = await getLedgerEntries(days);
  const by_model: AcuLedgerSummary["by_model"] = {};
  const by_tier: AcuLedgerSummary["by_tier"] = {};
  const by_task_type: AcuLedgerSummary["by_task_type"] = {};
  let total_cost = 0;
  let total_baseline_cost = 0;
  let total_latency = 0;
  let fallback_count = 0;
  let validator_total = 0;
  let validator_pass = 0;

  for (const entry of entries) {
    total_cost += entry.actual_cost;
    total_baseline_cost += entry.baseline_cost;
    total_latency += entry.latency_ms;
    if (entry.fallback_used ?? entry.fallback_attempts > 0) fallback_count++;
    if (entry.validator_result !== "not_applicable") {
      validator_total++;
      if (entry.validator_result === "pass") validator_pass++;
    }
    addGroup(by_model, entry.actual_model_used || "unknown", entry);
    addGroup(by_tier, entry.tier || "UNKNOWN", entry);
    addGroup(by_task_type, entry.task_type || "unknown", entry);
  }

  const total_requests = entries.length;
  return {
    total_requests,
    total_cost,
    total_baseline_cost,
    total_savings: total_baseline_cost - total_cost,
    avg_latency_ms: total_requests > 0 ? total_latency / total_requests : 0,
    fallback_rate: total_requests > 0 ? fallback_count / total_requests : 0,
    validator_pass_rate: validator_total > 0 ? validator_pass / validator_total : 0,
    by_model,
    by_tier,
    by_task_type,
    recent: entries.slice(0, 10),
  };
}

export async function clearLedger(): Promise<{ deletedFiles: number }> {
  const files = await getLedgerFiles();
  let deletedFiles = 0;
  for (const file of files) {
    try {
      await unlink(join(ledgerDir(), file));
      deletedFiles++;
    } catch {
      // Ignore file-level delete failures.
    }
  }
  return { deletedFiles };
}
