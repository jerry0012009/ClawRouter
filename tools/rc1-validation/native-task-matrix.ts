#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { readLiveTestBudgetConfig, reserveLiveTestBudget } from "./live-test-budget.js";

type Protocol = "responses" | "messages";
type MatrixTask = { id: string; protocol: Protocol; class: "simple" | "medium" | "hard" | "planning"; prompt: string };

const codexToken = process.env.RC1_NEW_API_CODEX_TOKEN?.trim();
const claudeToken = process.env.RC1_NEW_API_CLAUDE_TOKEN?.trim();
const codexHome = process.env.RC1_CODEX_HOME?.trim();
const claudeConfigDir = process.env.RC1_CLAUDE_CONFIG_DIR?.trim();
const requestedProtocol = process.env.RC1_MATRIX_PROTOCOL?.trim() as Protocol | undefined;
const requestedIds = new Set((process.env.RC1_MATRIX_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const concurrency = Math.max(1, Number.parseInt(process.env.RC1_MATRIX_CONCURRENCY ?? "1", 10));

if (requestedProtocol && !["responses", "messages"].includes(requestedProtocol)) {
  throw new Error("RC1_MATRIX_PROTOCOL must be responses or messages");
}

const tasks = JSON.parse(await readFile(new URL("./task-matrix.json", import.meta.url), "utf8")) as MatrixTask[];
const selected = tasks.filter((task) => (!requestedProtocol || task.protocol === requestedProtocol)
  && (requestedIds.size === 0 || requestedIds.has(task.id)));
if (selected.length === 0) throw new Error("No matrix tasks matched the requested filters");
if (selected.some((task) => task.protocol === "responses") && (!codexToken || !codexHome)) {
  throw new Error("Responses tasks require RC1_NEW_API_CODEX_TOKEN and RC1_CODEX_HOME");
}
if (selected.some((task) => task.protocol === "messages") && (!claudeToken || !claudeConfigDir)) {
  throw new Error("Messages tasks require RC1_NEW_API_CLAUDE_TOKEN and RC1_CLAUDE_CONFIG_DIR");
}

const budgetConfig = readLiveTestBudgetConfig();
const estimatedCostUsdPerTask = Number(process.env.RC1_MATRIX_ESTIMATED_COST_USD_PER_TASK ?? "0.5");
if (!Number.isFinite(estimatedCostUsdPerTask) || estimatedCostUsdPerTask <= 0) {
  throw new Error("RC1_MATRIX_ESTIMATED_COST_USD_PER_TASK must be a positive number");
}
const estimatedCostUsd = selected.length * estimatedCostUsdPerTask;
const budgetRun = await reserveLiveTestBudget({
  purpose: "native_e2e",
  estimatedCostUsd,
  requestedConcurrency: concurrency,
});

const seed = resolve("test/protocol-sandbox/.seed/work");
const runRoot = await mkdtemp(join(tmpdir(), "acu-rc1-matrix-"));

function execute(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string; durationMs: number }> {
  return new Promise((resolveRun, reject) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      durationMs: Date.now() - started,
    }));
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runTask(task: MatrixTask): Promise<void> {
  const cwd = join(runRoot, task.id);
  await cp(seed, cwd, { recursive: true });
  const commonEnv = { ...process.env, NO_COLOR: "1" };
  let result: Awaited<ReturnType<typeof execute>>;
  let sessionId: string | null = null;
  let usage: unknown = null;
  let outputForHash = "";
  if (task.protocol === "responses") {
    result = await execute("codex", [
      "exec", "--ignore-rules", "--json", "--ephemeral", "--skip-git-repo-check", "-C", cwd, task.prompt,
    ], cwd, {
      ...commonEnv,
      CODEX_HOME: codexHome,
      ACU_RC1_TOKEN: codexToken,
      CODEX_MAX_OUTPUT_TOKENS: String(budgetConfig.maxOutputTokens),
    });
    for (const line of result.stdout.split(/\r?\n/)) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "thread.started") sessionId = String(event.thread_id ?? "") || null;
        if (event.type === "turn.completed") usage = event.usage ?? null;
        const item = event.item as Record<string, unknown> | undefined;
        if (event.type === "item.completed" && item?.type === "agent_message") outputForHash += String(item.text ?? "");
      } catch { /* native stderr/stdout noise is summarized, never persisted */ }
    }
  } else {
    const permissionMode = task.class === "planning" ? "plan" : "dontAsk";
    result = await execute("claude", [
      "-p", "--no-session-persistence", "--model", "acu-auto", "--permission-mode", permissionMode,
      "--allowedTools", "Read,Write,Edit,Bash,Glob,Grep,EnterPlanMode,ExitPlanMode",
      "--output-format", "json", "--max-budget-usd", "6", task.prompt,
    ], cwd, {
      ...commonEnv,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(budgetConfig.maxOutputTokens),
      ANTHROPIC_BASE_URL: "http://127.0.0.1:3200",
      ANTHROPIC_AUTH_TOKEN: claudeToken,
    });
    try {
      const value = JSON.parse(result.stdout) as Record<string, unknown>;
      sessionId = typeof value.session_id === "string" ? value.session_id : null;
      usage = value.usage ?? null;
      outputForHash = String(value.result ?? "");
    } catch { /* summarized below */ }
  }
  console.log(JSON.stringify({
    id: task.id,
    protocol: task.protocol,
    class: task.class,
    exitCode: result.code,
    durationMs: result.durationMs,
    sessionId,
    usage,
    outputSha256: hash(outputForHash),
    stderrSha256: hash(result.stderr),
    stderrBytes: Buffer.byteLength(result.stderr),
  }));
}

let cursor = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < selected.length) {
    const task = selected[cursor++];
    await runTask(task);
  }
}));
const settledBudget = await budgetRun.finish(estimatedCostUsd);
console.error(JSON.stringify({
  testRunId: budgetRun.runId,
  accountingMode: "conservative_preflight_estimate",
  runCostCny: settledBudget.runCostCny,
  cumulativeTestCostCny: settledBudget.cumulativeCostCny,
}));
