import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLiveTestBudgetConfig, reserveLiveTestBudget } from "../tools/rc1-validation/live-test-budget.js";

function enabledEnv(stateFile: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ACU_LIVE_TEST_ENABLED: "true",
    ACU_TEST_RUN_BUDGET_CNY: "5",
    ACU_TEST_TOTAL_BUDGET_CNY: "10",
    ACU_TEST_MAX_CONCURRENCY: "1",
    ACU_TEST_MAX_OUTPUT_TOKENS: "4096",
    ACU_TEST_REQUIRE_APPROVAL_ABOVE_CNY: "5",
    ACU_TEST_USD_TO_CNY: "7",
    ACU_TEST_BUDGET_STATE_FILE: stateFile,
    ...overrides,
  };
}

describe("RC1 live-test budget", () => {
  it("is fail-closed by default", async () => {
    expect(readLiveTestBudgetConfig({}).enabled).toBe(false);
    await expect(reserveLiveTestBudget({ purpose: "test", estimatedCostUsd: 0, env: {} }))
      .rejects.toThrow("disabled");
  });

  it("rejects concurrency and per-run budget violations before a paid call", async () => {
    const root = await mkdtemp(join(tmpdir(), "acu-budget-test-"));
    const env = enabledEnv(join(root, "state.json"));
    await expect(reserveLiveTestBudget({ purpose: "test", estimatedCostUsd: 0.1, requestedConcurrency: 2, env }))
      .rejects.toThrow("concurrency");
    await expect(reserveLiveTestBudget({ purpose: "test", estimatedCostUsd: 1, env }))
      .rejects.toThrow("per-run budget");
  });

  it("persists reservations and actual cumulative spend", async () => {
    const root = await mkdtemp(join(tmpdir(), "acu-budget-test-"));
    const stateFile = join(root, "state.json");
    const env = enabledEnv(stateFile);
    const run = await reserveLiveTestBudget({ purpose: "provider_preflight", estimatedCostUsd: 0.2, env });
    expect(run.estimatedCostCny).toBeCloseTo(1.4);
    const settled = await run.finish(0.1);
    expect(settled.runCostCny).toBeCloseTo(0.7);
    expect(settled.cumulativeCostCny).toBeCloseTo(0.7);
    const state = JSON.parse(await readFile(stateFile, "utf8")) as { spentCny: number; reservations: unknown[] };
    expect(state.spentCny).toBeCloseTo(0.7);
    expect(state.reservations).toEqual([]);
  });

  it("requires explicit approval above the configured threshold", async () => {
    const root = await mkdtemp(join(tmpdir(), "acu-budget-test-"));
    const env = enabledEnv(join(root, "state.json"), {
      ACU_TEST_REQUIRE_APPROVAL_ABOVE_CNY: "1",
    });
    await expect(reserveLiveTestBudget({ purpose: "test", estimatedCostUsd: 0.2, env }))
      .rejects.toThrow("approval threshold");
  });
});
