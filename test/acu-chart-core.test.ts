import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Candidate = {
  modelId: string; displayName: string; predictedScore: number; conservativeScore: number;
  expectedTotalCost: number; valueUtility: number; p50LatencyMs: number | null;
  evidenceConfidence: string; healthStatus: string; routingEligible: boolean;
};

async function loadCore() {
  const source = await readFile(join(process.cwd(), "public", "acu-chart-core.js"), "utf8");
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return (context as unknown as { AcuChartCore: Record<string, (...args: never[]) => unknown> }).AcuChartCore;
}

const candidate = (modelId: string, score: number, cost: number, extra: Partial<Candidate> = {}): Candidate => ({
  modelId, displayName: modelId, predictedScore: score, conservativeScore: score - 4,
  expectedTotalCost: cost, valueUtility: score / 100 - cost, p50LatencyMs: 2000,
  evidenceConfidence: "medium", healthStatus: "healthy", routingEligible: true, ...extra,
});

describe("investor chart presentation helpers", () => {
  it("selects the quality ceiling by score, then conservative score, health, latency and evidence", async () => {
    const core = await loadCore();
    const selected = core.selectQualityCeiling([
      candidate("slow", 92.54, 0.1, { conservativeScore: 88, p50LatencyMs: 8000 }),
      candidate("winner", 92.51, 0.2, { conservativeScore: 89, p50LatencyMs: 3000 }),
      candidate("cheap", 91, 0.001),
    ]) as Candidate;
    expect(selected.modelId).toBe("winner");
  });

  it("uses bounded local difficulty zoom and an honest minimum 20-point score span", async () => {
    const core = await loadCore();
    expect(Array.from(core.autoDifficultyDomain(25) as number[])).toEqual([7, 43]);
    expect(Array.from(core.autoDifficultyDomain(5) as number[])).toEqual([0, 30]);
    expect(Array.from(core.autoDifficultyDomain(95) as number[])).toEqual([70, 100]);
    const curves = { a: [{ difficultyScore: 20, estimatedQuality: 0.80 }], b: [{ difficultyScore: 20, estimatedQuality: 0.805 }] };
    const domain = core.autoScoreDomain(curves, ["a", "b"], [7, 43]) as number[];
    expect(domain[1] - domain[0]).toBeGreaterThanOrEqual(20);
    expect(domain[0]).toBeGreaterThanOrEqual(0);
    expect(domain[1]).toBeLessThanOrEqual(100);
  });

  it("filters unavailable models and always features ceiling, recommendation and actual execution", async () => {
    const core = await loadCore();
    const candidates = [candidate("ceiling", 95, .1), candidate("recommended", 90, .01), candidate("actual", 89, .02), candidate("four", 88, .03), candidate("five", 87, .04), candidate("six", 86, .05), candidate("cooldown", 99, .03, { healthStatus: "cooldown" })];
    const visible = core.visibleCandidates(candidates, ["ceiling", "recommended", "actual", "four", "five", "six", "cooldown"]) as Candidate[];
    expect(visible.map((item) => item.modelId)).toEqual(["ceiling", "recommended", "actual", "four", "five", "six"]);
    const featured = core.featuredModelIds({ candidates: visible, ceilingId: "ceiling", recommendedId: "recommended", actualId: "actual", attemptIds: [] }) as string[];
    expect(featured).toEqual(expect.arrayContaining(["ceiling", "recommended", "actual"]));
    expect(featured).toHaveLength(6);
  });

  it("sorts the model list without making network calls", async () => {
    const source = await readFile(join(process.cwd(), "public", "acu-chart-core.js"), "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    const core = await loadCore();
    const items = [candidate("costly", 95, .2), candidate("value", 90, .01)];
    expect((core.sortCandidates(items, "cost") as Candidate[])[0].modelId).toBe("value");
    expect((core.sortCandidates(items, "score") as Candidate[])[0].modelId).toBe("costly");
  });
});
