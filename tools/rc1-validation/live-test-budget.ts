import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type BudgetState = {
  schemaVersion: "acu-rc1-live-test-budget-v1";
  spentCny: number;
  reservations: Array<{
    runId: string;
    purpose: string;
    reservedCny: number;
    createdAt: string;
  }>;
};

export type LiveTestBudgetConfig = {
  enabled: boolean;
  runBudgetCny: number;
  totalBudgetCny: number;
  maxConcurrency: number;
  maxOutputTokens: number;
  requireApprovalAboveCny: number;
  approved: boolean;
  usdToCny: number;
  stateFile: string;
};

function finitePositive(name: string, value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

export function readLiveTestBudgetConfig(env: NodeJS.ProcessEnv = process.env): LiveTestBudgetConfig {
  return {
    enabled: env.ACU_LIVE_TEST_ENABLED === "true",
    runBudgetCny: finitePositive("ACU_TEST_RUN_BUDGET_CNY", env.ACU_TEST_RUN_BUDGET_CNY, 5),
    totalBudgetCny: finitePositive("ACU_TEST_TOTAL_BUDGET_CNY", env.ACU_TEST_TOTAL_BUDGET_CNY, 30),
    maxConcurrency: Math.floor(finitePositive("ACU_TEST_MAX_CONCURRENCY", env.ACU_TEST_MAX_CONCURRENCY, 1)),
    maxOutputTokens: Math.floor(finitePositive("ACU_TEST_MAX_OUTPUT_TOKENS", env.ACU_TEST_MAX_OUTPUT_TOKENS, 4096)),
    requireApprovalAboveCny: finitePositive(
      "ACU_TEST_REQUIRE_APPROVAL_ABOVE_CNY",
      env.ACU_TEST_REQUIRE_APPROVAL_ABOVE_CNY,
      5,
    ),
    approved: env.ACU_TEST_COST_APPROVED === "true",
    usdToCny: finitePositive("ACU_TEST_USD_TO_CNY", env.ACU_TEST_USD_TO_CNY, 7.2),
    stateFile: resolve(env.ACU_TEST_BUDGET_STATE_FILE ?? "/var/tmp/acu-rc1-live-test-budget.json"),
  };
}

function emptyState(): BudgetState {
  return { schemaVersion: "acu-rc1-live-test-budget-v1", spentCny: 0, reservations: [] };
}

async function loadState(path: string): Promise<BudgetState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as BudgetState;
    if (parsed.schemaVersion !== "acu-rc1-live-test-budget-v1"
      || !Number.isFinite(parsed.spentCny)
      || !Array.isArray(parsed.reservations)) throw new Error("invalid budget state");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw new Error(
      `Cannot read live-test budget state: ${error instanceof Error ? error.message : "unknown error"}`,
      { cause: error },
    );
  }
}

async function saveState(path: string, state: BudgetState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function reserveLiveTestBudget(input: {
  purpose: string;
  estimatedCostUsd: number;
  requestedConcurrency?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  runId: string;
  estimatedCostCny: number;
  finish: (actualCostUsd: number) => Promise<{ runCostCny: number; cumulativeCostCny: number }>;
}> {
  const config = readLiveTestBudgetConfig(input.env);
  if (!config.enabled) throw new Error("Paid live tests are disabled; set ACU_LIVE_TEST_ENABLED=true locally after review");
  const requestedConcurrency = input.requestedConcurrency ?? 1;
  if (requestedConcurrency > config.maxConcurrency) {
    throw new Error(`Requested concurrency ${requestedConcurrency} exceeds ACU_TEST_MAX_CONCURRENCY=${config.maxConcurrency}`);
  }
  if (!Number.isFinite(input.estimatedCostUsd) || input.estimatedCostUsd < 0) {
    throw new Error("estimatedCostUsd must be a non-negative finite number");
  }
  const estimatedCostCny = input.estimatedCostUsd * config.usdToCny;
  if (estimatedCostCny > config.runBudgetCny) {
    throw new Error(`Estimated CNY ${estimatedCostCny.toFixed(4)} exceeds per-run budget ${config.runBudgetCny}`);
  }
  if (estimatedCostCny > config.requireApprovalAboveCny && !config.approved) {
    throw new Error("Estimated live-test cost exceeds approval threshold; set ACU_TEST_COST_APPROVED=true locally after approval");
  }

  const state = await loadState(config.stateFile);
  const reservedCny = state.reservations.reduce((sum, item) => sum + item.reservedCny, 0);
  if (state.spentCny + reservedCny + estimatedCostCny > config.totalBudgetCny) {
    throw new Error(`Estimated cost would exceed cumulative CNY budget ${config.totalBudgetCny}`);
  }
  const runId = `live-${new Date().toISOString().replace(/[^0-9]/g, "")}-${process.pid}`;
  state.reservations.push({
    runId,
    purpose: input.purpose,
    reservedCny: estimatedCostCny,
    createdAt: new Date().toISOString(),
  });
  await saveState(config.stateFile, state);

  let finished = false;
  return {
    runId,
    estimatedCostCny,
    finish: async (actualCostUsd: number) => {
      if (finished) throw new Error(`Live-test run ${runId} was already finalized`);
      if (!Number.isFinite(actualCostUsd) || actualCostUsd < 0) throw new Error("actualCostUsd must be non-negative");
      const latest = await loadState(config.stateFile);
      const reservation = latest.reservations.find((item) => item.runId === runId);
      if (!reservation) throw new Error(`Live-test budget reservation ${runId} is missing`);
      const runCostCny = actualCostUsd * config.usdToCny;
      latest.reservations = latest.reservations.filter((item) => item.runId !== runId);
      latest.spentCny += runCostCny;
      await saveState(config.stateFile, latest);
      finished = true;
      return { runCostCny, cumulativeCostCny: latest.spentCny };
    },
  };
}
